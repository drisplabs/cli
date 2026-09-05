/**
 * Run-loop reducer (ADR 0016) — the pure decision core of a Workflow Run.
 *
 * `workflowRunner.ts` used to be one `while` loop that mixed every I/O call
 * (spawning Turns, reading/writing the Journal, sleeping for a retry backoff,
 * persisting a snapshot) with every *decision* about what should happen next
 * (Nudge, Retry, Handover, suspend, stop). That made the decision logic
 * impossible to unit-test without mocking the whole harness, and — per ADR
 * 0016 §2 — meant nothing about a Run's progress (Iteration, Nudge streak,
 * Retry streak) survived a process restart, so a resumed Run silently reset
 * its budgets instead of continuing them.
 *
 * This module is the fix: `step(phase, memory, event, cfg)` is the single
 * owner of "what happens next" (§1). It performs no I/O, no timers, and no
 * randomness — everything it needs arrives via `event`/`cfg`, and it returns
 * a new `phase`/`memory` plus the `actions` the caller must perform before
 * the next Turn (or backoff, or fork) can start. `workflowRunner.ts` becomes
 * the interpreter: it executes `actions`, gathers exactly one `RunEvent`, and
 * calls `step` again — see `perform()` there.
 *
 * `RunMemory` is the part of a Run's state ADR 0016 §2 wants persisted
 * (Iteration, Nudge streak, Retry streak, the Journal hash a Nudge resets
 * against, and the prompt/continuation last attempted) so a rehydrated Run
 * continues its budgets instead of restarting them (§6) — see
 * `createInitialRun`'s `resumedMemory` path.
 */

import crypto from 'node:crypto';
import type {Interruption} from '@drisp/protocol';
import type {
	HarnessProcessOverride,
	TurnContinuation,
} from '../runtime/process';
import type {LoopConfig} from './types';
import {
	DEFAULT_HANDOVER_CAP,
	DEFAULT_NUDGE_CAP,
	DEFAULT_RETRY_CAP,
	DEFAULT_RETRY_BACKOFF_MS,
	HANDOFF_NO_PROGRESS_SIMILARITY,
} from './types';
import {buildIterationCeilingReason, type TurnOutcome} from './terminalOutcome';
import {
	buildContinuePrompt,
	buildJournalSizeNudgeSuffix,
	buildNudgePrompt,
	buildShedIntegrityNudgeSuffix,
	DEFAULT_JOURNAL_TOKEN_BOUND,
	estimateTokenCount,
	hasSkeletonMarker,
	type ShedIntegrityGaps,
} from './journalReader';
import {prepareWorkflowTurn, type WorkflowRunState} from './sessionPlan';
import {classifyTurnFailure} from '../runtime/failureTaxonomy';
import {prependSteerBlock, type QueuedSteer} from './steer';

/**
 * Non-terminal phases carry `prompt`/`continuation` directly (rather than
 * only on `RunMemory`) so a `switch` over `phase.kind` that forgets a case
 * cannot silently fall through and reuse the wrong phase's fields — each
 * case's fields are only visible once TypeScript has narrowed to it (ADR
 * 0016 §4).
 */
export type RunPhase =
	| {
			kind: 'turn_in_flight';
			prompt: string;
			continuation: TurnContinuation;
			configOverride?: HarnessProcessOverride;
	  }
	| {
			kind: 'backing_off';
			ms: number;
			/**
			 * What to re-issue once the backoff elapses — a discriminated union
			 * rather than the flat `prompt`/`continuation` this phase used to
			 * carry, because a fork retry (ADR 0016 §8) backs off the same way a
			 * Turn retry does but must re-issue `start_fork_turn`, not
			 * `start_turn`, once it elapses.
			 */
			resume:
				| {
						kind: 'turn';
						prompt: string;
						continuation: TurnContinuation;
				  }
				| {
						kind: 'fork';
						handle: string;
						configOverride?: HarnessProcessOverride;
						/** Carried through the backoff into the re-issued fork. */
						journalUnchanged: boolean;
						journalTokens: number;
						shedIntegrity: ShedIntegrityGaps | null;
				  };
	  }
	| {
			kind: 'handing_over';
			handle: string;
			configOverride?: HarnessProcessOverride;
			/** Set once this fork has already been retried once (ADR 0016 §8). */
			retried?: boolean;
			/**
			 * Whether the interrupted Turn left the Journal hash unchanged since
			 * the previous Turn boundary (ADR 0018 §1) — observed when the
			 * Handover was requested, consumed once the fork succeeds: the
			 * successful-fork row judges the Handover unproductive on it.
			 */
			journalUnchanged: boolean;
			/**
			 * The Journal's estimated size in tokens at the boundary (ADR 0015
			 * §3's estimate), so the seed prompt built once the fork succeeds can
			 * carry the size nudge — the Handover path used to be the one
			 * continuation that never did (ADR 0018 §7).
			 */
			journalTokens: number;
			/** A half-executed shed observed at the boundary, for the seed prompt (ADR 0018 §7). */
			shedIntegrity: ShedIntegrityGaps | null;
	  }
	| {
			kind: 'awaiting_attention';
			stopReason: string;
			/**
			 * The structured reason the Run parked, when the interpreter has one
			 * (#190: a permission request deferred after the grace window). The
			 * `stopReason` sentence stays the human-facing summary. On a wake it
			 * is the parked Interruption rehydrated from the Run record, so the
			 * `woken` row can shape the wake prompt into a replay instruction.
			 */
			interruption?: Interruption;
	  }
	| {kind: 'completed'}
	| {kind: 'failed'; stopReason?: string}
	| {kind: 'cancelled'};

export type TerminalRunPhase = Extract<
	RunPhase,
	{kind: 'awaiting_attention' | 'completed' | 'failed' | 'cancelled'}
>;

/**
 * The persisted state of a Run (ADR 0016 §2): everything a rehydrated Run
 * needs to continue its budgets instead of restarting them. `lastStopPrompt`/
 * `lastStopContinuation` mirror whichever `turn_in_flight`/`backing_off`
 * phase most recently started a Turn — `turn_in_flight` itself is never
 * persisted (§6), so this is how the interpreter reconstructs a
 * `backing_off{ms: 0, ...}` phase on rehydrate and re-issues the same action.
 */
export type RunMemory = {
	iteration: number;
	nudgeStreak: number;
	retryStreak: number;
	/**
	 * SHA-256 hex digest of the Journal's content at the last stop, or `null`
	 * before any stop has been observed. A hash rather than the raw content
	 * keeps a persisted Run cheap regardless of Journal size, and covers only
	 * `journal.md` itself (ADR 0016 §9) — not a future multi-file Dossier.
	 */
	lastJournalHash: string | null;
	lastStopPrompt: string;
	lastStopContinuation: TurnContinuation;
	/**
	 * Steers (#191) received but not yet delivered, in arrival order. A Steer
	 * is never injected into a running Turn: it waits here until the next
	 * `start_turn`, which drains the whole queue into the head of that Turn's
	 * prompt. Persisted so a Steer sent to a parked or restarting Run is
	 * delivered on its continue rather than lost.
	 */
	pendingSteers: QueuedSteer[];
	/**
	 * Size in bytes of the most recent Handoff file written at a Handover
	 * (ADR 0015 §8: Handoff size is a fidelity metric the Runner records), or
	 * `null` before any Handover has occurred or when the stat failed.
	 * Absent (`undefined` at runtime) on `RunMemory` persisted before this
	 * field existed — `deserializeRunMemory` does not require it, so read it
	 * defensively (`memory.lastHandoffSizeBytes ?? null`) rather than assuming
	 * presence.
	 */
	lastHandoffSizeBytes: number | null;
	/**
	 * Set when the Run parked on a row that follows a Handover (ADR 0018 §9):
	 * the iteration ceiling on the Handover row (§4). The persisted
	 * `adapterSessionId` is then a session at its context bound — the killed
	 * one, or the fork — and resuming it would re-trip compaction at once, so
	 * the wake starts a **fresh** Agent Session seeded with the newest Handoff
	 * file, the Journal and the reply. The `woken` row clears it. Absent on
	 * snapshots persisted before this field existed; `deserializeRunMemory`
	 * defaults it to `false`.
	 */
	parkedAfterHandover: boolean;
	/**
	 * Consecutive **unproductive** Handovers — the Handover streak (ADR 0018
	 * §2). Grows on a Handover whose Turn left the Journal unchanged, resets
	 * on a productive Handover and on a wake; reaching `handoverCap` parks the
	 * Run. Absent on snapshots persisted before this field existed;
	 * `deserializeRunMemory` defaults it to `0`.
	 */
	handoverStreak: number;
	/**
	 * The most recent Turn that ended at its context bound (ADR 0018 §6): its
	 * opening context, the context at its last call, and its tool-call count
	 * — `null` for each when the harness did not report it, and `null` as a
	 * whole before any Handover. What the cap sentence and the seed prompt
	 * turn into a measured working room. Absent on snapshots persisted before
	 * this field existed; `deserializeRunMemory` defaults it to `null`.
	 */
	lastBoundedTurn: BoundedTurn | null;
	/**
	 * The Run's cumulative token total — input, output, cache reads and cache
	 * writes across every Turn and fork — as of the last Turn or fork boundary
	 * (ADR 0018 §10), or `null` before any boundary reported one. Persisted so
	 * `drisp runs` can show a parked Run's burn, and what `loop.maxRunTokens`
	 * is checked against. Absent on snapshots persisted before this field
	 * existed; `deserializeRunMemory` defaults it to `null`.
	 */
	cumulativeTokens: number | null;
};

/** A Turn's measurement at its context bound (ADR 0018 §6). */
export type BoundedTurn = {
	/** Prompt size of the Turn's first root API call: system prompt, tools, skills, seed. */
	openingContextTokens: number | null;
	/** Prompt size of the Turn's last root API call — where the bound bit. */
	lastContextTokens: number | null;
	/** Tool calls the Turn made, when the caller counted them. */
	toolCalls: number | null;
};

/**
 * What the interpreter reports once a Handover's fork has written the
 * Handoff file (ADR 0018 §8): the file, its fidelity and progress metrics,
 * the streak, and the bounded Turn's measurement. The exec runner turns it
 * into `run.handover.completed`, adding the Run's cumulative tokens.
 */
export type HandoverCompletion = {
	/** The iteration the Handover interrupted. */
	iteration: number;
	handoffPath: string;
	handoffSizeBytes: number | null;
	handoffSimilarity: number | null;
	handoverStreak: number;
	openingContextTokens: number | null;
	lastContextTokens: number | null;
	toolCalls: number | null;
};

/**
 * Why an unattended Turn was interrupted to park the Run (#189) — the
 * runner-side **Interruption** (see the glossary's wire section). With nobody
 * attached, exactly three things stop a Turn for a person:
 *
 * - `ask_rule`: a permission an **ask rule** claimed (the rule pattern as
 *   written in `workflow.json`, and the tool it matched);
 * - `question`: the agent asked a question only a person can answer
 *   (`AskUserQuestion`, a `user_input` request, an elicitation);
 * - `unclaimed_permission`: a permission no rule answered under a preset
 *   whose policy is to hold rather than auto-answer (`guarded` / `standard`).
 *
 * Under the `autonomous` preset an unclaimed permission is answered inside
 * the Turn by the preset's policy and never reaches the reducer. The fourth
 * way to park — the `NEEDS_HUMAN` marker — is a Journal end-state and arrives
 * as a `suspend` outcome instead.
 */
export type RunInterruption =
	| {
			kind: 'ask_rule';
			rule: string;
			toolName: string;
			/** Present when the claimed permission was held, then deferred (#190). */
			permission?: DeferredPermission;
	  }
	| {kind: 'question'; question: string}
	| {
			kind: 'unclaimed_permission';
			toolName: string;
			/** Present when the unclaimed permission was held, then deferred (#190). */
			permission?: DeferredPermission;
	  };

/**
 * Hold, then park (#190): a permission request the runner held for the grace
 * window without an answer arriving was refused with a "deferred" result and
 * the Turn ended. What the park keeps so a later `answer` can be replayed
 * into the re-issued call: the pending request's id, a one-line summary of
 * the tool input (so the re-asked call can be recognised), and how long it
 * was held.
 */
export type DeferredPermission = {
	requestId: string;
	inputSummary: string;
	graceMs: number;
};

function formatGrace(ms: number): string {
	return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}

/**
 * How a deferred permission reads in the park sentence: held for a window
 * that elapsed, or — with no hub attached to answer, so no window — deferred
 * at once.
 */
function describeDeferral(permission: DeferredPermission): string {
	return permission.graceMs > 0
		? ` unanswered within the grace window (${formatGrace(permission.graceMs)}); deferred`
		: ' deferred immediately (no hub attached to answer)';
}

/**
 * The wire-shaped Interruption (`@drisp/protocol`) a deferred permission
 * parks on — a `question` addressed by the request id, whose `question` is
 * the call as asked (`<tool>: <input summary>`). Null for every interruption
 * that carries no deferred permission: those park on their sentence alone.
 */
function protocolInterruptionFor(
	interruption: RunInterruption,
): Interruption | null {
	if (interruption.kind === 'question' || !interruption.permission) return null;
	return {
		kind: 'question',
		message: describeInterruption(interruption),
		requestId: interruption.permission.requestId,
		question: `${interruption.toolName}: ${interruption.permission.inputSummary}`,
	};
}

/**
 * The human sentence an `awaiting_attention` phase carries for an
 * interruption — what `drisp runs` shows as the reason. Owned here, beside
 * the retry-cap and nudge-cap sentences, so every park reason has one author.
 */
function describeInterruption(interruption: RunInterruption): string {
	switch (interruption.kind) {
		case 'ask_rule':
			if (interruption.permission) {
				return (
					`ask rule "${interruption.rule}" fired on ${interruption.toolName}${describeDeferral(interruption.permission)}: ` +
					`${interruption.permission.inputSummary} — wake with --answer=allow|deny`
				);
			}
			return `ask rule "${interruption.rule}" fired on ${interruption.toolName} — needs a human`;
		case 'question':
			return interruption.question
				? `agent asked a question with no human attached to answer: ${interruption.question}`
				: 'agent asked a question with no human attached to answer';
		case 'unclaimed_permission':
			if (interruption.permission) {
				return (
					`permission request (${interruption.toolName})${describeDeferral(interruption.permission)}: ` +
					`${interruption.permission.inputSummary} — wake with --answer=allow|deny, or rerun with --isolation autonomous`
				);
			}
			return (
				`agent requested sandbox approval (${interruption.toolName}) with no human attached to answer` +
				` — rerun with --isolation autonomous, or wake with guidance`
			);
	}
}

/**
 * What `perform()` reports back after executing one phase's actions — the
 * only way information from the outside world reaches the reducer.
 */
export type RunEvent =
	| {
			type: 'turn_finished';
			cancelled: boolean;
			hasError: boolean;
			errorMessage?: string;
			exitCode: number | null;
			lastStderr?: string;
			stderrTail?: string;
			streamMessage: string | null;
			transportBroken: boolean;
			/** The handle of a pending Handover request, or null when none. */
			handoverRequestHandle: string | null;
			/** Set when the Turn was interrupted to park the Run (#189). */
			interruption: RunInterruption | null;
			adapterSessionId: string | null;
			/** Only computed on the success path once loop/journal apply. */
			outcome: TurnOutcome | null;
			journalContent: string;
			/**
			 * The Turn's measurement (ADR 0018 §6): the prompt size of its first
			 * and last root API calls, and its tool-call count — each `null`
			 * when the harness or the caller did not report it. Remembered as
			 * `lastBoundedTurn` when the Turn ended in a Handover.
			 */
			openingContextTokens: number | null;
			lastContextTokens: number | null;
			toolCalls: number | null;
			/**
			 * A half-executed shed the interpreter found in the Dossier after the
			 * Turn (ADR 0018 §7) — a unit record with no `## Units` row, or a
			 * heading in both the Journal and a record — or `null` when the
			 * Dossier is clean or could not be judged. Becomes a prompt suffix on
			 * whichever prompt starts the next Turn; never an edit.
			 */
			shedIntegrity: ShedIntegrityGaps | null;
			/**
			 * The Run's cumulative token total once this Turn's tokens are merged
			 * in (ADR 0018 §10), or `null` when unknown.
			 */
			cumulativeTokens: number | null;
	  }
	| {
			type: 'backoff_elapsed';
			cancelled: boolean;
			adapterSessionId: string | null;
	  }
	| {
			type: 'fork_finished';
			ok: boolean;
			cancelled: boolean;
			handoffPath: string;
			/** Size in bytes of the written Handoff file, or `null` if unknown (ADR 0015 §8). */
			handoffSizeBytes: number | null;
			/**
			 * Similarity of the written Handoff to the previous one in the chain
			 * (word-3-gram Jaccard, ADR 0018 §1), or `null` when there is no
			 * predecessor — the first Handover of a Run — or the read failed.
			 * Computed by the interpreter; the reducer only compares it to
			 * `HANDOFF_NO_PROGRESS_SIMILARITY`.
			 */
			handoffSimilarity: number | null;
			/**
			 * Whether a failed fork looks retryable (ADR 0016 §8) — unused when
			 * `ok` is true. Ignored by the reducer when `ok` is true.
			 */
			transient: boolean;
			/** The Run's cumulative token total once the fork's tokens are merged in, or `null`. */
			cumulativeTokens: number | null;
	  }
	| {
			/**
			 * Fed once, synthetically, when an `awaiting_attention` Run is woken
			 * (ADR 0016 §6/§7): the interpreter's bootstrap for a resumed Run
			 * whose persisted phase was `awaiting_attention` produces this event
			 * instead of replaying whatever ended the prior process.
			 */
			type: 'woken';
			continuation: TurnContinuation;
			/**
			 * The newest Handoff file in the Dossier's chain, or null when there
			 * is none — read by the interpreter, used by the row only when the
			 * park followed a Handover (`memory.parkedAfterHandover`), so the
			 * fresh wake is seeded with it (ADR 0018 §9).
			 */
			handoffPath: string | null;
	  }
	/**
	 * A Steer arrived (#191). Unlike the other events it is not the reply to
	 * a kickoff action: it can land in any non-terminal phase and only queues,
	 * leaving the phase — and any Turn in flight — untouched.
	 */
	| {type: 'steer'; steer: QueuedSteer};

/** What the interpreter must do before the next Turn/backoff/fork can start. */
export type RunAction =
	| {type: 'persist'}
	| {
			type: 'start_turn';
			prompt: string;
			continuation: TurnContinuation;
			configOverride?: HarnessProcessOverride;
	  }
	| {
			type: 'start_fork_turn';
			handle: string;
			configOverride?: HarnessProcessOverride;
	  }
	| {type: 'wait'; ms: number}
	| {type: 'notify_iteration_complete'}
	/** A Handover's fork wrote the Handoff file (ADR 0018 §8) — report it, measured. */
	| {type: 'notify_handover_completed'; completion: HandoverCompletion}
	| {type: 'purge_handoffs'}
	| {type: 'degrade_handover'; handle: string}
	/** Surface a non-fatal notice (e.g. a deprecated marker spelling, #185). */
	| {type: 'warn'; message: string}
	/**
	 * The queued Steers were drained into the `start_turn` that follows this
	 * action (#191) — the interpreter records each in the Journal, with its
	 * origin and the Turn it was delivered into, before that Turn starts.
	 */
	| {type: 'steers_delivered'; steers: QueuedSteer[]; iteration: number}
	/**
	 * Record the Interruption a parking Run carries — in the Journal (so the
	 * next Turn and `drisp runs` see the pending question) and on the Run
	 * record (#190). Always precedes the `persist` of the parked phase.
	 */
	| {type: 'record_interruption'; interruption: Interruption};

/** The immutable per-Run configuration the reducer needs. No callbacks. */
export type StepConfig = {
	workflowState: WorkflowRunState;
	/** The Run's top-level prompt — `WorkflowRunnerInput.prompt`, unchanging across Turns. */
	initialPrompt: string;
	loop?: LoopConfig;
	journalAbsPath: string | null;
	journalPromptPath?: string;
};

export type StepResult = {
	phase: RunPhase;
	memory: RunMemory;
	actions: RunAction[];
};

function hashJournalContent(content: string): string {
	return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * The park sentence for the cumulative token budget (ADR 0018 §10). The
 * limit is the first integer — `interruptionFromSuspension` reads it back as
 * `cap_exhausted` / `tokens` — so both numbers are written plainly.
 */
function buildTokenBudgetReason(limit: number, used: number): string {
	return `token budget reached: ${limit} tokens (maxRunTokens); used ${used}`;
}

/** Whether a configured `maxRunTokens` has been reached by a reported total. */
function tokenBudgetReached(
	loop: LoopConfig | undefined,
	cumulativeTokens: number | null,
): number | null {
	const limit = loop?.maxRunTokens;
	if (limit === undefined || cumulativeTokens === null) return null;
	return cumulativeTokens >= limit ? limit : null;
}

/** The memory with a boundary's reported cumulative total recorded (ADR 0018 §10). */
function withCumulativeTokens(
	memory: RunMemory,
	cumulativeTokens: number | null,
): RunMemory {
	return cumulativeTokens === null ? memory : {...memory, cumulativeTokens};
}

/** `~71k` for 71,400; `~700` stays `700` — the sentence supplies the `~`. */
function formatTokens(n: number): string {
	return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
}

/** The working room a bounded Turn had, when both ends were measured. */
function workingRoom(
	turn: Pick<BoundedTurn, 'openingContextTokens' | 'lastContextTokens'> | null,
): {opening: number; last: number; room: number} | null {
	if (
		!turn ||
		turn.openingContextTokens === null ||
		turn.lastContextTokens === null
	) {
		return null;
	}
	return {
		opening: turn.openingContextTokens,
		last: turn.lastContextTokens,
		room: Math.max(0, turn.lastContextTokens - turn.openingContextTokens),
	};
}

/**
 * The park sentence for the Handover cap (ADR 0018 §2): names the bound, the
 * signals that judged the streak unproductive, the measurement that explains
 * the loop (§6), and what to change. Read back by
 * `interruptionFromSuspension` (the first integer is the limit), so the
 * opening clause is a contract. Every number is omitted cleanly when unknown.
 */
function buildHandoverCapReason(input: {
	cap: number;
	handoffSimilarity: number | null;
	journalUnchanged: boolean;
	journalTokens: number;
	boundedTurn: BoundedTurn | null;
}): string {
	const room = workingRoom(input.boundedTurn);
	const signals = [
		...(input.handoffSimilarity === null
			? []
			: [
					`last Handoff ${Math.round(input.handoffSimilarity * 100)}% similar to the previous`,
				]),
		`journal ${input.journalUnchanged ? 'unchanged' : 'changed'}` +
			(input.journalTokens > 0
				? ` (~${formatTokens(input.journalTokens)} tokens)`
				: ''),
		...(room
			? [
					`fresh Turns opened at ~${formatTokens(room.opening)} tokens and were bounded at ~${formatTokens(room.last)} (~${formatTokens(room.room)} working room)`,
				]
			: []),
	];
	return (
		`handover cap reached: ${input.cap} consecutive Handover${
			input.cap === 1 ? '' : 's'
		} (handoverCap) without progress — ${signals.join('; ')}. ` +
		`Raise loop.maxTurnTokenCount, shrink the workflow's baseline context, or shed the journal.`
	);
}

/**
 * The fold-in rule every prompt that names a Handoff file states (ADR 0015
 * §8's obligation, executed as ADR 0018 §7 requires): fold in only what the
 * Journal lacks, never as an appended note. The seed prompt and the wake
 * prompt share it so the Turn Protocol has one rule to match.
 */
function buildFoldInRule(journalPath: string | undefined): string {
	return (
		`Before any domain work: fold into the journal` +
		(journalPath ? ` at ${journalPath}` : '') +
		` (or the open unit's record, if it has been shed) only what the Handoff records and the journal lacks — if it lacks nothing, write nothing. ` +
		`Never append a note that the Handoff was processed: the journal is an index, not a log of Handovers, and every line you add is a line every later fresh Turn must read. ` +
		`If the journal is over the ~8,000-token shed bound, shedding is your first action, before any other read — cut, paste, pointer (ADR 0015 §3). `
	);
}

/**
 * Seed prompt for the fresh post-Handover Turn: the Handoff file carries the
 * in-flight context the Journal never checkpointed; the Journal remains the
 * durable ledger. The fold-in is bounded (ADR 0018 §7): the old wording
 * called it "the journal's next edit" and agents executed it as one appended
 * note per Handover, growing the mandatory opening read until it alone
 * exceeded a fresh Turn's working room.
 */
export function buildHandoverSeedPrompt(
	handoffPath: string,
	journalPath: string | undefined,
	measurement: HandoverMeasurement = {},
): string {
	const room = workingRoom({
		openingContextTokens: measurement.openingContextTokens ?? null,
		lastContextTokens: measurement.lastContextTokens ?? null,
	});
	const journalTokens = measurement.journalTokens ?? 0;
	return (
		`A Handover occurred: the previous agent session reached its context bound and was distilled into a Handoff file. ` +
		(measurement.handoverNumber !== undefined
			? `This is Handover ${measurement.handoverNumber} of the run. `
			: '') +
		`Read the Handoff file at ${handoffPath}` +
		(journalPath ? ` and the journal at ${journalPath}` : '') +
		`. ` +
		(room
			? `The previous session opened at ~${formatTokens(room.opening)} tokens (system prompt, tools, skills and seed) and was bounded at ~${formatTokens(room.last)}, ` +
				`so you have roughly ~${formatTokens(room.room)} tokens of working room before your own bound: read selectively, and do not re-read what the Handoff already summarises. `
			: '') +
		(journalTokens > 0
			? `The journal is ~${formatTokens(journalTokens)} tokens. `
			: '') +
		buildFoldInRule(journalPath) +
		`Then continue the work from exactly where it stands. ` +
		`Do not redo completed work, and do not re-litigate decisions the Handoff file records.`
	);
}

/**
 * What the seed prompt tells the fresh Turn about its situation (ADR 0018
 * §6): which Handover this is, the previous session's opening context and
 * bound (hence its working room), and the Journal's size. Every field is
 * optional and omitted from the prompt when unknown.
 */
export type HandoverMeasurement = {
	handoverNumber?: number;
	openingContextTokens?: number | null;
	lastContextTokens?: number | null;
	journalTokens?: number;
};

/** The chain position a Handoff path encodes (`handoff/012.md` → 12), if any. */
function handoverNumberFromPath(handoffPath: string): number | undefined {
	const match = /(\d+)\.md$/.exec(handoffPath);
	return match ? Number(match[1]) : undefined;
}

/**
 * First prompt of a woken (previously suspended) Run: the human's reply plus
 * enough framing that even a degraded fresh Agent Session — the session that
 * asked may be gone — re-orients from the Journal instead of treating the
 * reply as a brand-new one-line task.
 */
export function buildWakePrompt(
	reply: string,
	journalPath: string | undefined,
	parkedInterruption?: Interruption,
	handoffPath?: string,
): string {
	return (
		`This workflow run was suspended awaiting a human; it is now resumed. The human replied:\n\n${reply}\n\n` +
		buildReplayGuidance(parkedInterruption) +
		buildHandoffGuidance(handoffPath, journalPath) +
		(journalPath
			? `Read the journal at ${journalPath} for the task and its current state, apply the reply, and continue the workflow. `
			: `Apply the reply and continue the workflow. `) +
		`Keep the journal current as you work — if it still contains the runner's skeleton, replace it while orienting — and end by declaring a terminal marker as usual.`
	);
}

/**
 * Replay (#190): a Run parked because a permission request (or question) went
 * unanswered inside the grace window was told "deferred" and its Turn ended.
 * On wake the runner cannot re-issue a tool call itself — the agent does — so
 * the wake prompt names the deferred call and asks for it verbatim. A stored
 * answer is replayed into that re-asked call by the runner; without one the
 * request is simply held again. Empty for every other Interruption.
 */
function buildReplayGuidance(parked: Interruption | undefined): string {
	if (!parked || parked.kind !== 'question' || !parked.requestId) return '';
	const call = parked.question ?? 'the same call';
	return (
		`Before your previous Turn ended, your request \`${call}\` (request ${parked.requestId}) was deferred because nobody answered it in time. ` +
		`Re-issue that exact call now, with the same input: if an answer was stored while this run was parked it is applied automatically, otherwise the request is held again for a human. ` +
		`Do not work around the deferred call or substitute a different one.\n\n`
	);
}

/**
 * A wake after a park that followed a Handover (ADR 0018 §9) is a fresh Agent
 * Session: the session that parked sits at its context bound, so nothing of
 * the previous conversation survives except its Handoff file. The wake prompt
 * names that file as mandatory reading beside the Journal, exactly as the
 * Handover seed prompt does. Empty when the park followed any other row.
 */
function buildHandoffGuidance(
	handoffPath: string | undefined,
	journalPath: string | undefined,
): string {
	if (!handoffPath) return '';
	return (
		`This run parked right after a Handover, so this Turn is a fresh Agent Session with no memory of the previous one. ` +
		`Read the newest Handoff file at ${handoffPath} — mandatory reading alongside the journal: it carries the in-flight context the journal never checkpointed. ` +
		buildFoldInRule(journalPath) +
		`Then apply the reply. Do not redo completed work, and do not re-litigate decisions the Handoff file records.\n\n`
	);
}

/** Pure: `parts.join(': ')` of whatever diagnostics a failed Turn carries. */
function buildFailureDetail(
	event: Extract<RunEvent, {type: 'turn_finished'}>,
): string {
	const parts: string[] = [];
	if (event.errorMessage) {
		parts.push(event.errorMessage);
	} else if (event.exitCode !== null) {
		parts.push(`Process exited with code ${event.exitCode}`);
	}
	if (event.lastStderr) {
		parts.push(event.lastStderr);
	} else if (event.streamMessage) {
		parts.push(event.streamMessage.slice(0, 300));
	}
	return parts.join(': ') || 'Turn failed';
}

/**
 * The initial phase/memory for a fresh Run, or for a wake of a suspended one
 * (ADR 0014 §6) — framed with `buildWakePrompt` rather than the bare human
 * reply. `resumedMemory`, when supplied, rehydrates a Run whose most recent
 * persisted state was mid-Turn (ADR 0016 §6): the interpreter reconstructs a
 * `backing_off{ms: 0, ...}` phase from the persisted prompt/continuation and
 * re-issues the same `start_turn` action once fed a synthetic
 * `backoff_elapsed` event, rather than restarting the Run's budgets.
 */
export function createInitialRun(
	cfg: StepConfig,
	opts: {
		initialContinuation?: TurnContinuation;
		/** `input.resumeRunId` truthy and the loop is enabled (ADR 0014 §6). */
		waking: boolean;
		resumedMemory?: RunMemory;
		/**
		 * Steers already waiting when the Run starts (#191) — a local
		 * `--steer`, or a Steer stored against a parked Run. Delivered at the
		 * head of the first Turn's prompt, after any the resumed memory carries.
		 */
		initialSteers?: QueuedSteer[];
		/**
		 * The Interruption the Run being woken parked on, when its record has
		 * one (#190). A deferred question shapes the wake prompt into a replay
		 * instruction; any other kind leaves the plain wake prompt.
		 */
		parkedInterruption?: Interruption;
		/**
		 * The persisted `stop_reason` of the resumed run, when `waking` and
		 * `resumedMemory` are both present. Only meaningful for that case.
		 */
		awaitingAttentionStopReason?: string;
	},
): StepResult {
	const initialSteers = opts.initialSteers ?? [];
	if (opts.resumedMemory) {
		const memory =
			initialSteers.length === 0
				? opts.resumedMemory
				: {
						...opts.resumedMemory,
						pendingSteers: [
							...opts.resumedMemory.pendingSteers,
							...initialSteers,
						],
					};

		// A wake (ADR 0014 §6) of a Run whose persisted phase was
		// `awaiting_attention`: rehydrate straight back into that phase rather
		// than replaying whatever prompt/continuation last ran (§3/§6) — `step()`
		// advances it on the next `woken` event via `handleAwaitingAttention`,
		// which is what actually carries `resumedMemory.iteration` forward as the
		// Run's budget across wakes (§2). The parked Interruption (#190) rides
		// on the phase so that row can shape the wake prompt into a replay.
		if (opts.waking) {
			const phase: RunPhase = {
				kind: 'awaiting_attention',
				stopReason: opts.awaitingAttentionStopReason ?? '',
				...(opts.parkedInterruption
					? {interruption: opts.parkedInterruption}
					: {}),
			};
			return {phase, memory, actions: kickoffActionsFor(phase)};
		}

		// A process restart mid-Turn (crash recovery): `turn_in_flight` itself is
		// never persisted (§6), so the interpreter reconstructs a zero-wait
		// `backing_off` phase from the persisted prompt/continuation and
		// re-issues the same Turn once fed a synthetic `backoff_elapsed` event.
		const phase: RunPhase = {
			kind: 'backing_off',
			ms: 0,
			resume: {
				kind: 'turn',
				prompt: opts.resumedMemory.lastStopPrompt,
				continuation: opts.resumedMemory.lastStopContinuation,
			},
		};
		return {phase, memory, actions: kickoffActionsFor(phase)};
	}

	const continuation = opts.initialContinuation ?? {mode: 'fresh'};
	const iteration = 1;
	const prepared = prepareWorkflowTurn(cfg.workflowState, {
		prompt: cfg.initialPrompt,
		iteration,
		configOverride: undefined,
	});
	const prompt = opts.waking
		? buildWakePrompt(
				cfg.initialPrompt,
				cfg.journalPromptPath,
				opts.parkedInterruption,
			)
		: prepared.prompt;

	const phase: RunPhase = {
		kind: 'turn_in_flight',
		prompt,
		continuation,
		configOverride: prepared.configOverride,
	};
	return deliverPendingSteers({
		phase,
		memory: {
			iteration,
			nudgeStreak: 0,
			retryStreak: 0,
			lastJournalHash: null,
			lastStopPrompt: prompt,
			lastStopContinuation: continuation,
			pendingSteers: initialSteers,
			lastHandoffSizeBytes: null,
			parkedAfterHandover: false,
			handoverStreak: 0,
			lastBoundedTurn: null,
			cumulativeTokens: null,
		},
		actions: kickoffActionsFor(phase),
	});
}

/** The kickoff action a freshly built phase implies — what the interpreter must start. */
function kickoffActionsFor(phase: RunPhase): RunAction[] {
	switch (phase.kind) {
		case 'turn_in_flight':
			return [
				{
					type: 'start_turn',
					prompt: phase.prompt,
					continuation: phase.continuation,
					configOverride: phase.configOverride,
				},
			];
		case 'backing_off':
			return [{type: 'wait', ms: phase.ms}];
		case 'handing_over':
		case 'awaiting_attention':
		case 'completed':
		case 'failed':
		case 'cancelled':
			return [];
	}
}

/**
 * Turn-boundary delivery (#191): when a result starts a Turn and Steers are
 * queued, drain the whole queue — in arrival order — into the head of that
 * Turn's prompt and report the delivery just ahead of the `start_turn`. A
 * result that starts no Turn (suspend, backoff, fork, terminal) leaves the
 * queue exactly as it is, which is what keeps a Steer out of a running Turn.
 */
function deliverPendingSteers(result: StepResult): StepResult {
	const steers = result.memory.pendingSteers;
	if (steers.length === 0 || result.phase.kind !== 'turn_in_flight') {
		return result;
	}
	const startIndex = result.actions.findIndex(a => a.type === 'start_turn');
	if (startIndex === -1) return result;
	const start = result.actions[startIndex] as Extract<
		RunAction,
		{type: 'start_turn'}
	>;
	const prompt = prependSteerBlock(start.prompt, steers);
	const actions = [
		...result.actions.slice(0, startIndex),
		{
			type: 'steers_delivered',
			steers,
			iteration: result.memory.iteration,
		} satisfies RunAction,
		{...start, prompt},
		...result.actions.slice(startIndex + 1),
	];
	return {
		phase: {...result.phase, prompt},
		memory: {...result.memory, lastStopPrompt: prompt, pendingSteers: []},
		actions,
	};
}

/** A Steer only queues (#191): same phase, one more pending Steer, persisted. */
function handleSteer(
	phase: RunPhase,
	memory: RunMemory,
	steer: QueuedSteer,
): StepResult {
	return {
		phase,
		memory: {...memory, pendingSteers: [...memory.pendingSteers, steer]},
		actions: [{type: 'persist'}],
	};
}

function handleTurnInFlight(
	phase: Extract<RunPhase, {kind: 'turn_in_flight'}>,
	incoming: RunMemory,
	event: Extract<RunEvent, {type: 'turn_finished'}>,
	cfg: StepConfig,
): StepResult {
	if (event.cancelled) {
		return {
			phase: {kind: 'cancelled'},
			memory: incoming,
			actions: [{type: 'persist'}],
		};
	}
	// Every boundary records the Run's burn (ADR 0018 §10), whatever it decides.
	const memory = withCumulativeTokens(incoming, event.cumulativeTokens);

	if (event.handoverRequestHandle !== null) {
		// The Handover boundary observes the Journal like a clean stop does
		// (ADR 0018 §1, §5): `lastJournalHash` becomes "the hash at the last
		// Turn boundary of any kind". The Nudge comparison still asks whether
		// the Journal advanced since the last boundary, so progress observed
		// here resets its streak exactly as progress at a stop would.
		const journalHash = hashJournalContent(event.journalContent);
		const journalUnchanged = journalHash === memory.lastJournalHash;
		return {
			phase: {
				kind: 'handing_over',
				handle: event.handoverRequestHandle,
				// Reuse this Turn's own prepared configOverride (the same object
				// the primary `start_turn` action used) rather than recomputing —
				// matches workflowRunner.ts's original `prepared.configOverride`
				// reuse at the fork call site exactly. Stored on the phase too
				// (not just the action) so a transient-retry (§8) can re-issue the
				// fork with the same override.
				configOverride: phase.configOverride,
				journalUnchanged,
				journalTokens: estimateTokenCount(event.journalContent),
				shedIntegrity: event.shedIntegrity,
			},
			memory: {
				...memory,
				lastJournalHash: journalHash,
				nudgeStreak: journalUnchanged ? memory.nudgeStreak : 0,
				// The Turn that just hit its bound, measured (ADR 0018 §6).
				lastBoundedTurn: {
					openingContextTokens: event.openingContextTokens,
					lastContextTokens: event.lastContextTokens,
					toolCalls: event.toolCalls,
				},
			},
			actions: [
				{
					type: 'start_fork_turn',
					handle: event.handoverRequestHandle,
					configOverride: phase.configOverride,
				},
			],
		};
	}

	// Parked for a person (#189): an ask rule, a question, or an unclaimed
	// permission under a holding preset. Checked before failure classification
	// — interrupting the Turn ends the harness process abnormally, but the Run
	// is suspended, not failed.
	if (event.interruption) {
		// Hold, then park (#190): a permission that went unanswered inside the
		// grace window was deferred and carries its request id and call. That
		// structured Interruption is recorded — journal and run record — before
		// the parked phase is persisted, so `drisp runs` and the hub both show
		// what was asked and an `answer` has something to address.
		const deferred = protocolInterruptionFor(event.interruption);
		if (deferred) {
			return {
				phase: {
					kind: 'awaiting_attention',
					stopReason: deferred.message,
					interruption: deferred,
				},
				memory,
				actions: [
					{type: 'record_interruption', interruption: deferred},
					{type: 'persist'},
				],
			};
		}
		return {
			phase: {
				kind: 'awaiting_attention',
				stopReason: describeInterruption(event.interruption),
			},
			memory,
			actions: [{type: 'persist'}],
		};
	}

	const failed =
		event.hasError || (event.exitCode !== null && event.exitCode !== 0);
	if (failed) {
		const failureDetail = buildFailureDetail(event);

		if (cfg.loop?.enabled) {
			const classification = classifyTurnFailure({
				errorMessage: event.errorMessage,
				lastStderr: event.stderrTail ?? event.lastStderr,
				lastMessage: event.streamMessage,
			});

			if (classification.kind === 'transient') {
				const retryStreak = memory.retryStreak + 1;
				const retryCap = cfg.loop.retryCap ?? DEFAULT_RETRY_CAP;
				if (retryStreak > retryCap) {
					return {
						phase: {
							kind: 'awaiting_attention',
							stopReason: `retry cap reached: ${retryCap} transient failure${
								retryCap === 1 ? '' : 's'
							} (retryCap); last (${classification.code}): ${failureDetail}`,
						},
						memory: {...memory, retryStreak},
						actions: [{type: 'persist'}],
					};
				}
				const backoffBase = cfg.loop.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
				const ms = backoffBase * 2 ** (retryStreak - 1);
				return {
					phase: {
						kind: 'backing_off',
						ms,
						resume: {
							kind: 'turn',
							prompt: phase.prompt,
							continuation: phase.continuation,
						},
					},
					memory: {...memory, retryStreak},
					actions: [{type: 'wait', ms}],
				};
			}

			// Hard failure on a resumed Turn: degrade to a fresh replay of the
			// same iteration first (ADR 0014 / #139) — bounded by construction,
			// since the replay runs fresh and a second hard failure escalates.
			if (phase.continuation.mode === 'resume') {
				const continuation: TurnContinuation = {mode: 'fresh'};
				const prepared = prepareWorkflowTurn(cfg.workflowState, {
					prompt: cfg.initialPrompt,
					iteration: memory.iteration,
					configOverride: undefined,
				});
				return {
					phase: {
						kind: 'turn_in_flight',
						prompt: prepared.prompt,
						continuation,
						configOverride: prepared.configOverride,
					},
					memory: {
						...memory,
						lastStopPrompt: prepared.prompt,
						lastStopContinuation: continuation,
					},
					actions: [
						{type: 'persist'},
						{
							type: 'start_turn',
							prompt: prepared.prompt,
							continuation,
							configOverride: prepared.configOverride,
						},
					],
				};
			}

			return {
				phase: {
					kind: 'awaiting_attention',
					stopReason: `hard failure (${classification.code}): ${failureDetail} — not retried; needs a human`,
				},
				memory,
				actions: [{type: 'persist'}],
			};
		}

		return {
			phase: {kind: 'failed', stopReason: failureDetail},
			memory,
			actions: [{type: 'persist'}],
		};
	}

	// The Turn completed without failing — the transient-failure streak is over.
	const memoryAfterSuccess = {...memory, retryStreak: 0};

	if (event.transportBroken) {
		return {
			phase: {
				kind: 'failed',
				stopReason: `Hook transport broken: observed a tool use in the Claude stream but received no PreToolUse events.`,
			},
			memory: memoryAfterSuccess,
			actions: [{type: 'persist'}],
		};
	}

	if (!cfg.loop?.enabled) {
		return {
			phase: {kind: 'completed'},
			memory: memoryAfterSuccess,
			actions: [{type: 'persist'}],
		};
	}
	const loop = cfg.loop;

	if (
		event.outcome &&
		(event.outcome.kind === 'stop' || event.outcome.kind === 'suspend')
	) {
		const outcome = event.outcome;
		const nextPhase: RunPhase =
			outcome.status === 'completed'
				? {kind: 'completed'}
				: outcome.status === 'failed'
					? {kind: 'failed', stopReason: outcome.stopReason}
					: {
							kind: 'awaiting_attention',
							stopReason: outcome.stopReason ?? 'stopped',
						};
		// A deprecated marker spelling reaches the same phase; the only
		// difference is the notice the interpreter is asked to log (#185).
		const deprecation =
			outcome.kind === 'suspend' ? outcome.deprecation : undefined;
		return {
			phase: nextPhase,
			memory: memoryAfterSuccess,
			actions: [
				...(deprecation ? [{type: 'warn', message: deprecation} as const] : []),
				{type: 'persist'},
			],
		};
	}

	// The cumulative token budget (ADR 0018 §10): the universal backstop,
	// checked only where the Run would otherwise keep going — a declared
	// completion still completes and a declared NEEDS_HUMAN keeps its reason.
	const budget = tokenBudgetReached(loop, memory.cumulativeTokens);
	if (budget !== null) {
		return {
			phase: {
				kind: 'awaiting_attention',
				stopReason: buildTokenBudgetReason(budget, memory.cumulativeTokens!),
			},
			memory: memoryAfterSuccess,
			actions: [{type: 'persist'}],
		};
	}

	// Undeclared markerless stop → Nudge (ADR 0014 §3): resume the same Agent
	// Session with a corrective prompt. Bounded by the Nudge cap, which
	// resets whenever the Journal advances between stops (a hash comparison,
	// ADR 0016 §7/§9).
	const journalHash = hashJournalContent(event.journalContent);
	let nudgeStreak = memoryAfterSuccess.nudgeStreak;
	if (journalHash !== memoryAfterSuccess.lastJournalHash) {
		nudgeStreak = 0;
	}
	const memoryWithHash = {
		...memoryAfterSuccess,
		lastJournalHash: journalHash,
		nudgeStreak,
	};

	// Size nudge (ADR 0015 §3): never blocks, never edits the journal — just a
	// suffix appended to whichever prompt starts the next Turn, computed from
	// the content already on the event (no new I/O).
	const sizeNudgeSuffix =
		(estimateTokenCount(event.journalContent) > DEFAULT_JOURNAL_TOKEN_BOUND
			? buildJournalSizeNudgeSuffix(cfg.journalPromptPath)
			: '') +
		// Shed-integrity nudge (ADR 0018 §7): a half-executed shed is named
		// the Turn after it happens, on the same terms as the size nudge.
		(event.shedIntegrity
			? buildShedIntegrityNudgeSuffix(event.shedIntegrity)
			: '');

	if (event.adapterSessionId) {
		const nextNudgeStreak = nudgeStreak + 1;
		const nudgeCap = loop.nudgeCap ?? DEFAULT_NUDGE_CAP;
		if (nextNudgeStreak > nudgeCap) {
			return {
				phase: {
					kind: 'awaiting_attention',
					stopReason: `nudge cap reached: ${nudgeCap} nudge${
						nudgeCap === 1 ? '' : 's'
					} (nudgeCap) without journal progress or a terminal marker`,
				},
				memory: {...memoryWithHash, nudgeStreak: nextNudgeStreak},
				actions: [{type: 'persist'}],
			};
		}
		const promptOverride =
			buildNudgePrompt(
				{...loop, journalPath: cfg.journalPromptPath ?? loop.journalPath},
				{
					skeletonNotReplaced: hasSkeletonMarker(event.journalContent),
				},
			) + sizeNudgeSuffix;
		const nextIteration = memoryWithHash.iteration + 1;
		const continuation: TurnContinuation = {
			mode: 'resume',
			handle: event.adapterSessionId,
		};
		const prepared = prepareWorkflowTurn(cfg.workflowState, {
			prompt: cfg.initialPrompt,
			iteration: nextIteration,
			configOverride: undefined,
		});
		return {
			phase: {
				kind: 'turn_in_flight',
				prompt: promptOverride,
				continuation,
				configOverride: prepared.configOverride,
			},
			memory: {
				...memoryWithHash,
				nudgeStreak: nextNudgeStreak,
				iteration: nextIteration,
				lastStopPrompt: promptOverride,
				lastStopContinuation: continuation,
			},
			actions: [
				{type: 'persist'},
				{type: 'notify_iteration_complete'},
				{
					type: 'start_turn',
					prompt: promptOverride,
					continuation,
					configOverride: prepared.configOverride,
				},
			],
		};
	}

	// No vendor session id to resume: fall back to a fresh Turn seeded by the
	// Continue Prompt (pre-Nudge behaviour).
	const nextIteration = memoryWithHash.iteration + 1;
	const continuation: TurnContinuation = {mode: 'fresh'};
	const prepared = prepareWorkflowTurn(cfg.workflowState, {
		prompt: cfg.initialPrompt,
		iteration: nextIteration,
		configOverride: undefined,
	});
	const promptWithSizeNudge = prepared.prompt + sizeNudgeSuffix;
	return {
		phase: {
			kind: 'turn_in_flight',
			prompt: promptWithSizeNudge,
			continuation,
			configOverride: prepared.configOverride,
		},
		memory: {
			...memoryWithHash,
			iteration: nextIteration,
			lastStopPrompt: promptWithSizeNudge,
			lastStopContinuation: continuation,
		},
		actions: [
			{type: 'persist'},
			{type: 'notify_iteration_complete'},
			{
				type: 'start_turn',
				prompt: promptWithSizeNudge,
				continuation,
				configOverride: prepared.configOverride,
			},
		],
	};
}

function handleBackingOff(
	phase: Extract<RunPhase, {kind: 'backing_off'}>,
	memory: RunMemory,
	event: Extract<RunEvent, {type: 'backoff_elapsed'}>,
	cfg: StepConfig,
): StepResult {
	if (event.cancelled) {
		return {phase: {kind: 'cancelled'}, memory, actions: [{type: 'persist'}]};
	}

	if (phase.resume.kind === 'fork') {
		// A transient fork failure's backoff elapsed (ADR 0016 §8): re-issue the
		// same fork once, marking it retried so a second transient failure
		// degrades instead of retrying again.
		return {
			phase: {
				kind: 'handing_over',
				handle: phase.resume.handle,
				configOverride: phase.resume.configOverride,
				retried: true,
				journalUnchanged: phase.resume.journalUnchanged,
				journalTokens: phase.resume.journalTokens,
				shedIntegrity: phase.resume.shedIntegrity,
			},
			memory,
			actions: [
				{
					type: 'start_fork_turn',
					handle: phase.resume.handle,
					configOverride: phase.resume.configOverride,
				},
			],
		};
	}

	// Resume the same Agent Session if it reported one — it persists on disk,
	// so resuming preserves in-flight work the Journal never checkpointed.
	// Otherwise fall back to whichever continuation this attempt used.
	const continuation: TurnContinuation = event.adapterSessionId
		? {mode: 'resume', handle: event.adapterSessionId}
		: phase.resume.continuation;

	// Replay invariant (ADR 0016 §3): replay the in-flight prompt iff this
	// attempt is a fresh Agent Session. A `resume`d session already contains
	// the prior instruction and failure record on disk — replaying it would
	// duplicate that content — while a fresh session contains neither, so it
	// needs the bare Continue Prompt to re-orient from the Journal.
	const prompt =
		continuation.mode === 'fresh'
			? phase.resume.prompt
			: cfg.loop
				? buildContinuePrompt(cfg.loop)
				: 'Continue.';
	const prepared = prepareWorkflowTurn(cfg.workflowState, {
		prompt: cfg.initialPrompt,
		iteration: memory.iteration,
		configOverride: undefined,
	});
	return {
		phase: {
			kind: 'turn_in_flight',
			prompt,
			continuation,
			configOverride: prepared.configOverride,
		},
		memory: {
			...memory,
			lastStopPrompt: prompt,
			lastStopContinuation: continuation,
		},
		actions: [
			{type: 'persist'},
			{
				type: 'start_turn',
				prompt,
				continuation,
				configOverride: prepared.configOverride,
			},
		],
	};
}

function handleHandingOver(
	phase: Extract<RunPhase, {kind: 'handing_over'}>,
	incoming: RunMemory,
	event: Extract<RunEvent, {type: 'fork_finished'}>,
	cfg: StepConfig,
): StepResult {
	if (event.cancelled) {
		return {
			phase: {kind: 'cancelled'},
			memory: incoming,
			actions: [{type: 'persist'}],
		};
	}
	const memory = withCumulativeTokens(incoming, event.cumulativeTokens);

	const nextIteration = memory.iteration + 1;

	if (event.ok) {
		const memoryAfterFork = {
			...memory,
			lastHandoffSizeBytes: event.handoffSizeBytes,
		};

		// The iteration ceiling applies on the Handover row (ADR 0018 §4): a
		// Turn that ended in a Handover never reaches `resolveTurnOutcome`, the
		// only other place `maxIterations` is evaluated, so without this check a
		// Run whose Turns keep handing over has no ceiling at all. Fork first,
		// then check — the Handoff is the distillation a wake needs, and one fork
		// at the ceiling is cheaper than losing the session's in-flight state.
		// The park is marked (§9): the persisted vendor session sits at its
		// bound, so the wake must start fresh rather than resume it.
		// Reported on every successful fork (ADR 0018 §8), whatever this row
		// decides next: the exec stream's `run.handover.completed`.
		const completion = (handoverStreak: number): RunAction => ({
			type: 'notify_handover_completed',
			completion: {
				iteration: memory.iteration,
				handoffPath: event.handoffPath,
				handoffSizeBytes: event.handoffSizeBytes,
				handoffSimilarity: event.handoffSimilarity,
				handoverStreak,
				openingContextTokens:
					memory.lastBoundedTurn?.openingContextTokens ?? null,
				lastContextTokens: memory.lastBoundedTurn?.lastContextTokens ?? null,
				toolCalls: memory.lastBoundedTurn?.toolCalls ?? null,
			},
		});

		// The cumulative token budget (ADR 0018 §10) is the outermost bound:
		// checked before the ceiling and the cap. Fork first, then check — the
		// Handoff is on disk for the wake, which starts fresh (§9).
		const budget = tokenBudgetReached(cfg.loop, memory.cumulativeTokens);
		if (budget !== null) {
			return {
				phase: {
					kind: 'awaiting_attention',
					stopReason: buildTokenBudgetReason(budget, memory.cumulativeTokens!),
				},
				memory: {...memoryAfterFork, parkedAfterHandover: true},
				actions: [
					{type: 'purge_handoffs'},
					{type: 'persist'},
					completion(memory.handoverStreak),
				],
			};
		}

		const maxIterations = cfg.loop?.maxIterations;
		if (maxIterations !== undefined && memory.iteration >= maxIterations) {
			return {
				phase: {
					kind: 'awaiting_attention',
					stopReason: buildIterationCeilingReason(maxIterations),
				},
				memory: {...memoryAfterFork, parkedAfterHandover: true},
				actions: [
					{type: 'purge_handoffs'},
					{type: 'persist'},
					completion(memory.handoverStreak),
				],
			};
		}

		// The Handover cap (ADR 0018 §1-§3): a Handover is unproductive when its
		// Handoff restates the previous one (the session's own distillation
		// converged — fold-in-proof, since a "processed" note changes the
		// Journal hash but not the next Handoff) or when its Turn left the
		// Journal unchanged (the seed-too-big case, where the fresh Turn dies
		// before writing anything). A streak of them parks the Run: a suspend,
		// not a degrade to vendor compaction, because the cause is structural
		// (the bound, the baseline context, or the Journal's size) and only a
		// person can change it. A productive Handover resets the streak, so a
		// long Run that keeps working never trips this.
		const unproductive =
			(event.handoffSimilarity !== null &&
				event.handoffSimilarity >= HANDOFF_NO_PROGRESS_SIMILARITY) ||
			phase.journalUnchanged;
		const handoverStreak = unproductive ? memory.handoverStreak + 1 : 0;
		const handoverCap = cfg.loop?.handoverCap ?? DEFAULT_HANDOVER_CAP;
		if (handoverStreak >= handoverCap) {
			return {
				phase: {
					kind: 'awaiting_attention',
					stopReason: buildHandoverCapReason({
						cap: handoverCap,
						handoffSimilarity: event.handoffSimilarity,
						journalUnchanged: phase.journalUnchanged,
						journalTokens: phase.journalTokens,
						boundedTurn: memory.lastBoundedTurn,
					}),
				},
				memory: {...memoryAfterFork, handoverStreak, parkedAfterHandover: true},
				actions: [
					{type: 'purge_handoffs'},
					{type: 'persist'},
					completion(handoverStreak),
				],
			};
		}

		// The fork is discarded (nothing resumes it); the next Turn is a fresh
		// Agent Session — the only context-resetting transition — and ticks
		// the Iteration counter like any Turn.
		const continuation: TurnContinuation = {mode: 'fresh'};
		// Size nudge (ADR 0015 §3) on the Handover path too (ADR 0018 §7): the
		// seed prompt was the one continuation that never carried it, though a
		// fresh Turn is exactly where an over-bound Journal costs the most.
		const sizeNudgeSuffix =
			(phase.journalTokens > DEFAULT_JOURNAL_TOKEN_BOUND
				? buildJournalSizeNudgeSuffix(cfg.journalPromptPath)
				: '') +
			(phase.shedIntegrity
				? buildShedIntegrityNudgeSuffix(phase.shedIntegrity)
				: '');
		const seedPrompt =
			buildHandoverSeedPrompt(
				event.handoffPath,
				cfg.journalAbsPath ?? undefined,
				{
					handoverNumber: handoverNumberFromPath(event.handoffPath),
					openingContextTokens:
						memory.lastBoundedTurn?.openingContextTokens ?? null,
					lastContextTokens: memory.lastBoundedTurn?.lastContextTokens ?? null,
					journalTokens: phase.journalTokens,
				},
			) + sizeNudgeSuffix;
		const prepared = prepareWorkflowTurn(cfg.workflowState, {
			prompt: cfg.initialPrompt,
			iteration: nextIteration,
			configOverride: undefined,
		});
		return {
			phase: {
				kind: 'turn_in_flight',
				prompt: seedPrompt,
				continuation,
				configOverride: prepared.configOverride,
			},
			memory: {
				...memoryAfterFork,
				iteration: nextIteration,
				lastStopPrompt: seedPrompt,
				lastStopContinuation: continuation,
				handoverStreak,
			},
			actions: [
				{type: 'purge_handoffs'},
				{type: 'persist'},
				completion(handoverStreak),
				// Reported like the Nudge rows report it (ADR 0018 §8): the exec
				// stream shows `iteration.complete` for a Handover too.
				{type: 'notify_iteration_complete'},
				{
					type: 'start_turn',
					prompt: seedPrompt,
					continuation,
					configOverride: prepared.configOverride,
				},
			],
		};
	}

	// A transient fork failure retries once with backoff before degrading
	// (ADR 0016 §8) — `phase.retried` guards against retrying a second time.
	if (event.transient && !phase.retried) {
		const ms = cfg.loop?.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
		return {
			phase: {
				kind: 'backing_off',
				ms,
				resume: {
					kind: 'fork',
					handle: phase.handle,
					configOverride: phase.configOverride,
					journalUnchanged: phase.journalUnchanged,
					journalTokens: phase.journalTokens,
					shedIntegrity: phase.shedIntegrity,
				},
			},
			memory,
			actions: [{type: 'wait', ms}],
		};
	}

	// Degrade, never stall (ADR 0014 §5): resume the interrupted conversation
	// in place; the caller stops intercepting this session's compactions.
	const continuation: TurnContinuation = {mode: 'resume', handle: phase.handle};
	const prepared = prepareWorkflowTurn(cfg.workflowState, {
		prompt: cfg.initialPrompt,
		iteration: nextIteration,
		configOverride: undefined,
	});
	return {
		phase: {
			kind: 'turn_in_flight',
			prompt: prepared.prompt,
			continuation,
			configOverride: prepared.configOverride,
		},
		memory: {
			...memory,
			iteration: nextIteration,
			lastStopPrompt: prepared.prompt,
			lastStopContinuation: continuation,
		},
		actions: [
			{type: 'degrade_handover', handle: phase.handle},
			{type: 'persist'},
			{
				type: 'start_turn',
				prompt: prepared.prompt,
				continuation,
				configOverride: prepared.configOverride,
			},
		],
	};
}

/**
 * Wake-from-attention as a row of the transition table (ADR 0016 §7): the
 * interpreter feeds a synthetic `woken` event once a suspended Run resumes,
 * and this — like every other transition — runs through `step()` rather than
 * being special-cased outside the reducer. It advances the Iteration counter
 * (so `maxIterations` is a budget across wakes, not per-wake, §2) and frames
 * the human's reply with `buildWakePrompt` — shaped into a replay instruction
 * when the phase carries the deferred Interruption the Run parked on (#190).
 */
function handleAwaitingAttention(
	phase: Extract<RunPhase, {kind: 'awaiting_attention'}>,
	memory: RunMemory,
	event: Extract<RunEvent, {type: 'woken'}>,
	cfg: StepConfig,
): StepResult {
	const nextIteration = memory.iteration + 1;
	// A park that followed a Handover wakes fresh (ADR 0018 §9), whatever
	// session the caller reported: the persisted one sits at its context
	// bound, and resuming it would re-trip compaction before the reply is
	// read. The newest Handoff file becomes mandatory reading beside the
	// Journal. Every other park resumes the intact session as before.
	const wakesFresh = memory.parkedAfterHandover;
	const continuation: TurnContinuation = wakesFresh
		? {mode: 'fresh'}
		: event.continuation;
	const prompt = buildWakePrompt(
		cfg.initialPrompt,
		cfg.journalPromptPath,
		phase.interruption,
		wakesFresh && event.handoffPath ? event.handoffPath : undefined,
	);
	const prepared = prepareWorkflowTurn(cfg.workflowState, {
		prompt: cfg.initialPrompt,
		iteration: nextIteration,
		configOverride: undefined,
	});
	return {
		phase: {
			kind: 'turn_in_flight',
			prompt,
			continuation,
			configOverride: prepared.configOverride,
		},
		memory: {
			...memory,
			iteration: nextIteration,
			lastStopPrompt: prompt,
			lastStopContinuation: continuation,
			parkedAfterHandover: false,
			// A human reply is new information: the Handover streak starts over.
			handoverStreak: 0,
		},
		actions: [
			{type: 'persist'},
			{
				type: 'start_turn',
				prompt,
				continuation,
				configOverride: prepared.configOverride,
			},
		],
	};
}

/**
 * The reducer (ADR 0016 §1): given the current phase, the persisted memory,
 * and exactly one event describing what just happened, decides the next
 * phase/memory and the actions the interpreter must perform. Pure — no I/O,
 * no timers, no randomness.
 *
 * `step` is never called on `completed`/`failed`/`cancelled` — the
 * interpreter's loop ends there. `awaiting_attention` is terminal for that
 * loop too (it stops and waits for a human) but is not a dead end for the
 * reducer: a wake feeds it exactly one `woken` event (ADR 0016 §7) and it
 * transitions like any other row. Calling `step` on a truly terminal phase is
 * a programmer error — the `default` arm below both handles that and gives
 * TypeScript an exhaustiveness check on `RunPhase` (§4): adding a new phase
 * variant without a case above fails `_exhaustive: never` at compile time.
 */
export function step(
	phase: RunPhase,
	memory: RunMemory,
	event: RunEvent,
	cfg: StepConfig,
): StepResult {
	switch (phase.kind) {
		case 'turn_in_flight': {
			if (event.type === 'steer')
				return handleSteer(phase, memory, event.steer);
			if (event.type !== 'turn_finished') {
				throw new Error(
					`runMachine: phase 'turn_in_flight' received unexpected event '${event.type}'`,
				);
			}
			return deliverPendingSteers(
				handleTurnInFlight(phase, memory, event, cfg),
			);
		}
		case 'backing_off': {
			if (event.type === 'steer')
				return handleSteer(phase, memory, event.steer);
			if (event.type !== 'backoff_elapsed') {
				throw new Error(
					`runMachine: phase 'backing_off' received unexpected event '${event.type}'`,
				);
			}
			return deliverPendingSteers(handleBackingOff(phase, memory, event, cfg));
		}
		case 'handing_over': {
			if (event.type === 'steer')
				return handleSteer(phase, memory, event.steer);
			if (event.type !== 'fork_finished') {
				throw new Error(
					`runMachine: phase 'handing_over' received unexpected event '${event.type}'`,
				);
			}
			return deliverPendingSteers(handleHandingOver(phase, memory, event, cfg));
		}
		case 'awaiting_attention': {
			if (event.type !== 'woken') {
				throw new Error(
					`runMachine: phase 'awaiting_attention' received unexpected event '${event.type}'`,
				);
			}
			return deliverPendingSteers(
				handleAwaitingAttention(phase, memory, event, cfg),
			);
		}
		case 'completed':
		case 'failed':
		case 'cancelled': {
			throw new Error(
				`runMachine: step() called on terminal phase '${phase.kind}'`,
			);
		}
		default: {
			const _exhaustive: never = phase;
			throw new Error(
				`runMachine: step() called on unrecognized phase kind '${(_exhaustive as RunPhase).kind}'`,
			);
		}
	}
}

/** Serialize `RunMemory` for the opaque `runMemoryJson` persistence column. */
export function serializeRunMemory(memory: RunMemory): string {
	return JSON.stringify(memory);
}

/**
 * Parse a persisted `runMemoryJson` back into `RunMemory`. Returns `null` for
 * missing, malformed, or foreign JSON — the interpreter falls back to a fresh
 * `RunMemory` in that case, exactly matching pre-rehydration behaviour.
 */
export function deserializeRunMemory(
	json: string | undefined | null,
): RunMemory | null {
	if (!json) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const candidate = parsed as Record<string, unknown>;
	// Snapshots persisted before #185 spell the hash `lastTrackerHash`; read
	// it as `lastJournalHash` so an in-flight Run rehydrates across the rename.
	// Removed in 0.7.0.
	if (!('lastJournalHash' in candidate) && 'lastTrackerHash' in candidate) {
		candidate.lastJournalHash = candidate.lastTrackerHash;
		delete candidate.lastTrackerHash;
	}
	const continuation = candidate.lastStopContinuation as
		| {mode?: unknown}
		| undefined;
	// Snapshots persisted before #191 carry no Steer queue: an absent queue is
	// an empty one, but a present queue must be well-formed.
	if (!('pendingSteers' in candidate)) candidate.pendingSteers = [];
	// Snapshots persisted before ADR 0018 carry no Handover-park marking: an
	// in-flight Run rehydrates as "resume the session", exactly as before.
	if (typeof candidate.parkedAfterHandover !== 'boolean') {
		candidate.parkedAfterHandover = false;
	}
	if (typeof candidate.handoverStreak !== 'number') {
		candidate.handoverStreak = 0;
	}
	if (!isBoundedTurn(candidate.lastBoundedTurn)) {
		candidate.lastBoundedTurn = null;
	}
	if (typeof candidate.cumulativeTokens !== 'number') {
		candidate.cumulativeTokens = null;
	}
	if (
		typeof candidate.iteration !== 'number' ||
		typeof candidate.nudgeStreak !== 'number' ||
		typeof candidate.retryStreak !== 'number' ||
		(candidate.lastJournalHash !== null &&
			typeof candidate.lastJournalHash !== 'string') ||
		typeof candidate.lastStopPrompt !== 'string' ||
		!continuation ||
		typeof continuation.mode !== 'string' ||
		!Array.isArray(candidate.pendingSteers) ||
		!candidate.pendingSteers.every(isQueuedSteer)
	) {
		return null;
	}
	return candidate as unknown as RunMemory;
}

/**
 * Whether a persisted Run must be woken into a fresh Agent Session (ADR 0018
 * §9): true iff its `RunMemory` snapshot carries the Handover-park marking.
 * For the callers that choose a wake's continuation before the reducer runs
 * — resume resolution for `drisp run --continue`, the hub's wake — so neither
 * hands the runner a vendor session that sits at its context bound. Missing
 * or malformed JSON reads as `false`: resume as before.
 */
export function wakesFreshAfterHandover(
	runMemoryJson: string | undefined | null,
): boolean {
	return deserializeRunMemory(runMemoryJson)?.parkedAfterHandover === true;
}

function isBoundedTurn(value: unknown): value is BoundedTurn {
	if (!value || typeof value !== 'object') return false;
	const turn = value as Record<string, unknown>;
	return ['openingContextTokens', 'lastContextTokens', 'toolCalls'].every(
		key => turn[key] === null || typeof turn[key] === 'number',
	);
}

function isQueuedSteer(value: unknown): value is QueuedSteer {
	if (!value || typeof value !== 'object') return false;
	const steer = value as Record<string, unknown>;
	return (
		typeof steer.text === 'string' &&
		(steer.origin === 'hub' || steer.origin === 'local') &&
		typeof steer.receivedAt === 'number'
	);
}
