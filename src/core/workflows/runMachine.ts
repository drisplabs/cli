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
	DEFAULT_NUDGE_CAP,
	DEFAULT_RETRY_CAP,
	DEFAULT_RETRY_BACKOFF_MS,
} from './types';
import type {TurnOutcome} from './terminalOutcome';
import {buildNudgePrompt, hasSkeletonMarker} from './journalReader';
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
			prompt: string;
			continuation: TurnContinuation;
	  }
	| {kind: 'handing_over'; handle: string}
	| {
			kind: 'awaiting_attention';
			stopReason: string;
			/**
			 * The structured reason the Run parked, when the interpreter has one
			 * (#190: a permission request deferred after the grace window). The
			 * `stopReason` sentence stays the human-facing summary.
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
 * Seed prompt for the fresh post-Handover Turn: the Handoff file carries the
 * in-flight context the Journal never checkpointed; the Journal remains the
 * durable ledger.
 */
export function buildHandoverSeedPrompt(
	handoffPath: string,
	journalPath: string | undefined,
): string {
	return (
		`A Handover occurred: the previous agent session reached its context bound and was distilled into a Handoff file. ` +
		`Read the Handoff file at ${handoffPath}` +
		(journalPath ? ` and the journal at ${journalPath}` : '') +
		`, then continue the work from exactly where it stands. ` +
		`Do not redo completed work, and do not re-litigate decisions the Handoff file records.`
	);
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
): string {
	return (
		`This workflow run was suspended awaiting a human; it is now resumed. The human replied:\n\n${reply}\n\n` +
		buildReplayGuidance(parkedInterruption) +
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
		const phase: RunPhase = {
			kind: 'backing_off',
			ms: 0,
			prompt: opts.resumedMemory.lastStopPrompt,
			continuation: opts.resumedMemory.lastStopContinuation,
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
	memory: RunMemory,
	event: Extract<RunEvent, {type: 'turn_finished'}>,
	cfg: StepConfig,
): StepResult {
	if (event.cancelled) {
		return {phase: {kind: 'cancelled'}, memory, actions: [{type: 'persist'}]};
	}

	if (event.handoverRequestHandle !== null) {
		return {
			phase: {kind: 'handing_over', handle: event.handoverRequestHandle},
			memory,
			actions: [
				{
					type: 'start_fork_turn',
					handle: event.handoverRequestHandle,
					// Reuse this Turn's own prepared configOverride (the same object
					// the primary `start_turn` action used) rather than recomputing —
					// matches workflowRunner.ts's original `prepared.configOverride`
					// reuse at the fork call site exactly.
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
						prompt: phase.prompt,
						continuation: phase.continuation,
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
		const promptOverride = buildNudgePrompt(
			{...loop, journalPath: cfg.journalPromptPath ?? loop.journalPath},
			{
				skeletonNotReplaced: hasSkeletonMarker(event.journalContent),
			},
		);
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
	return {
		phase: {
			kind: 'turn_in_flight',
			prompt: prepared.prompt,
			continuation,
			configOverride: prepared.configOverride,
		},
		memory: {
			...memoryWithHash,
			iteration: nextIteration,
			lastStopPrompt: prepared.prompt,
			lastStopContinuation: continuation,
		},
		actions: [
			{type: 'persist'},
			{type: 'notify_iteration_complete'},
			{
				type: 'start_turn',
				prompt: prepared.prompt,
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
	// Resume the same Agent Session if it reported one — it persists on disk,
	// so resuming preserves in-flight work the Journal never checkpointed.
	// Otherwise fall back to whichever continuation this attempt used.
	const continuation: TurnContinuation = event.adapterSessionId
		? {mode: 'resume', handle: event.adapterSessionId}
		: phase.continuation;
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

function handleHandingOver(
	phase: Extract<RunPhase, {kind: 'handing_over'}>,
	memory: RunMemory,
	event: Extract<RunEvent, {type: 'fork_finished'}>,
	cfg: StepConfig,
): StepResult {
	if (event.cancelled) {
		return {phase: {kind: 'cancelled'}, memory, actions: [{type: 'persist'}]};
	}

	const nextIteration = memory.iteration + 1;

	if (event.ok) {
		// The fork is discarded (nothing resumes it); the next Turn is a fresh
		// Agent Session — the only context-resetting transition — and ticks
		// the Iteration counter like any Turn.
		const continuation: TurnContinuation = {mode: 'fresh'};
		const seedPrompt = buildHandoverSeedPrompt(
			event.handoffPath,
			cfg.journalAbsPath ?? undefined,
		);
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
				...memory,
				iteration: nextIteration,
				lastStopPrompt: seedPrompt,
				lastStopContinuation: continuation,
			},
			actions: [
				{type: 'purge_handoffs'},
				{type: 'persist'},
				{
					type: 'start_turn',
					prompt: seedPrompt,
					continuation,
					configOverride: prepared.configOverride,
				},
			],
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
 * The reducer (ADR 0016 §1): given the current phase, the persisted memory,
 * and exactly one event describing what just happened, decides the next
 * phase/memory and the actions the interpreter must perform. Pure — no I/O,
 * no timers, no randomness.
 *
 * `step` is never called on a terminal phase; the interpreter's loop ends
 * once `phase.kind` is one of the four terminal kinds. Calling it on one
 * anyway is a programmer error — the `default` arm below both handles that
 * and gives TypeScript an exhaustiveness check on `RunPhase` (§4): adding a
 * new phase variant without a case above fails `_exhaustive: never` at
 * compile time.
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
		case 'awaiting_attention':
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

function isQueuedSteer(value: unknown): value is QueuedSteer {
	if (!value || typeof value !== 'object') return false;
	const steer = value as Record<string, unknown>;
	return (
		typeof steer.text === 'string' &&
		(steer.origin === 'hub' || steer.origin === 'local') &&
		typeof steer.receivedAt === 'number'
	);
}
