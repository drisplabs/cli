/**
 * Run-loop reducer (ADR 0016) — the pure decision core of a Workflow Run.
 *
 * `workflowRunner.ts` used to be one `while` loop that mixed every I/O call
 * (spawning Turns, reading/writing the Tracker, sleeping for a retry backoff,
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
 * (Iteration, Nudge streak, Retry streak, the Tracker hash a Nudge resets
 * against, and the prompt/continuation last attempted) so a rehydrated Run
 * continues its budgets instead of restarting them (§6) — see
 * `createInitialRun`'s `resumedMemory` path.
 */

import crypto from 'node:crypto';
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
import {
	buildContinuePrompt,
	buildNudgePrompt,
	buildTrackerSizeNudgeSuffix,
	DEFAULT_TRACKER_TOKEN_BOUND,
	estimateTokenCount,
	TRACKER_SKELETON_MARKER,
} from './trackerReader';
import {prepareWorkflowTurn, type WorkflowRunState} from './sessionPlan';
import {classifyTurnFailure} from '../runtime/failureTaxonomy';

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
				  };
	  }
	| {
			kind: 'handing_over';
			handle: string;
			configOverride?: HarnessProcessOverride;
			/** Set once this fork has already been retried once (ADR 0016 §8). */
			retried?: boolean;
	  }
	| {kind: 'awaiting_attention'; stopReason: string}
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
	 * SHA-256 hex digest of the Tracker's content at the last stop, or `null`
	 * before any stop has been observed. A hash rather than the raw content
	 * keeps a persisted Run cheap regardless of Tracker size, and covers only
	 * `tracker.md` itself (ADR 0016 §9) — not a future multi-file Dossier.
	 */
	lastTrackerHash: string | null;
	lastStopPrompt: string;
	lastStopContinuation: TurnContinuation;
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
};

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
			suspension: {reason: string} | null;
			adapterSessionId: string | null;
			/** Only computed on the success path once loop/tracker apply. */
			outcome: TurnOutcome | null;
			trackerContent: string;
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
			 * Whether a failed fork looks retryable (ADR 0016 §8) — unused when
			 * `ok` is true. Ignored by the reducer when `ok` is true.
			 */
			transient: boolean;
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
	  };

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
	| {type: 'degrade_handover'; handle: string};

/** The immutable per-Run configuration the reducer needs. No callbacks. */
export type StepConfig = {
	workflowState: WorkflowRunState;
	/** The Run's top-level prompt — `WorkflowRunnerInput.prompt`, unchanging across Turns. */
	initialPrompt: string;
	loop?: LoopConfig;
	trackerAbsPath: string | null;
	trackerPromptPath?: string;
};

export type StepResult = {
	phase: RunPhase;
	memory: RunMemory;
	actions: RunAction[];
};

function hashTrackerContent(content: string): string {
	return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Seed prompt for the fresh post-Handover Turn: the Handoff file carries the
 * in-flight context the Tracker never checkpointed; the Tracker remains the
 * durable ledger.
 */
export function buildHandoverSeedPrompt(
	handoffPath: string,
	trackerPath: string | undefined,
): string {
	return (
		`A Handover occurred: the previous agent session reached its context bound and was distilled into a Handoff file. ` +
		`Read the Handoff file at ${handoffPath}` +
		(trackerPath ? ` and the tracker at ${trackerPath}` : '') +
		`. Before any domain work: fold whatever durable content the Handoff file records into the tracker` +
		(trackerPath ? ` at ${trackerPath}` : '') +
		` and the open unit's record (ADR 0015 §8) — that fold-in is itself the tracker's next edit. ` +
		`Only once it is written should you continue the work from exactly where it stands. ` +
		`Do not redo completed work, and do not re-litigate decisions the Handoff file records.`
	);
}

/**
 * First prompt of a woken (previously suspended) Run: the human's reply plus
 * enough framing that even a degraded fresh Agent Session — the session that
 * asked may be gone — re-orients from the Tracker instead of treating the
 * reply as a brand-new one-line task.
 */
export function buildWakePrompt(
	reply: string,
	trackerPath: string | undefined,
): string {
	return (
		`This workflow run was suspended awaiting a human; it is now resumed. The human replied:\n\n${reply}\n\n` +
		(trackerPath
			? `Read the tracker at ${trackerPath} for the task and its current state, apply the reply, and continue the workflow. `
			: `Apply the reply and continue the workflow. `) +
		`Keep the tracker current as you work — if it still contains the runner's skeleton, replace it while orienting — and end by declaring a terminal marker as usual.`
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
		 * The persisted `stop_reason` of the resumed run, when `waking` and
		 * `resumedMemory` are both present. Only meaningful for that case.
		 */
		awaitingAttentionStopReason?: string;
	},
): {phase: RunPhase; memory: RunMemory} {
	// A wake (ADR 0014 §6) of a Run whose persisted phase was
	// `awaiting_attention`: rehydrate straight back into that phase rather
	// than replaying whatever prompt/continuation last ran (§3/§6) — `step()`
	// advances it on the next `woken` event via `handleAwaitingAttention`,
	// which is what actually carries `resumedMemory.iteration` forward as the
	// Run's budget across wakes (§2).
	if (opts.waking && opts.resumedMemory) {
		return {
			phase: {
				kind: 'awaiting_attention',
				stopReason: opts.awaitingAttentionStopReason ?? '',
			},
			memory: opts.resumedMemory,
		};
	}

	// A process restart mid-Turn (crash recovery): `turn_in_flight` itself is
	// never persisted (§6), so the interpreter reconstructs a zero-wait
	// `backing_off` phase from the persisted prompt/continuation and
	// re-issues the same Turn once fed a synthetic `backoff_elapsed` event.
	if (opts.resumedMemory) {
		return {
			phase: {
				kind: 'backing_off',
				ms: 0,
				resume: {
					kind: 'turn',
					prompt: opts.resumedMemory.lastStopPrompt,
					continuation: opts.resumedMemory.lastStopContinuation,
				},
			},
			memory: opts.resumedMemory,
		};
	}

	const continuation = opts.initialContinuation ?? {mode: 'fresh'};
	const iteration = 1;
	const prepared = prepareWorkflowTurn(cfg.workflowState, {
		prompt: cfg.initialPrompt,
		iteration,
		configOverride: undefined,
	});
	const prompt = opts.waking
		? buildWakePrompt(cfg.initialPrompt, cfg.trackerPromptPath)
		: prepared.prompt;

	return {
		phase: {
			kind: 'turn_in_flight',
			prompt,
			continuation,
			configOverride: prepared.configOverride,
		},
		memory: {
			iteration,
			nudgeStreak: 0,
			retryStreak: 0,
			lastTrackerHash: null,
			lastStopPrompt: prompt,
			lastStopContinuation: continuation,
			lastHandoffSizeBytes: null,
		},
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
			},
			memory,
			actions: [
				{
					type: 'start_fork_turn',
					handle: event.handoverRequestHandle,
					configOverride: phase.configOverride,
				},
			],
		};
	}

	if (event.suspension) {
		return {
			phase: {kind: 'awaiting_attention', stopReason: event.suspension.reason},
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
		return {
			phase: nextPhase,
			memory: memoryAfterSuccess,
			actions: [{type: 'persist'}],
		};
	}

	// Undeclared markerless stop → Nudge (ADR 0014 §3): resume the same Agent
	// Session with a corrective prompt. Bounded by the Nudge cap, which
	// resets whenever the Tracker advances between stops (a hash comparison,
	// ADR 0016 §7/§9).
	const trackerHash = hashTrackerContent(event.trackerContent);
	let nudgeStreak = memoryAfterSuccess.nudgeStreak;
	if (trackerHash !== memoryAfterSuccess.lastTrackerHash) {
		nudgeStreak = 0;
	}
	const memoryWithHash = {
		...memoryAfterSuccess,
		lastTrackerHash: trackerHash,
		nudgeStreak,
	};

	// Size nudge (ADR 0015 §3): never blocks, never edits the tracker — just a
	// suffix appended to whichever prompt starts the next Turn, computed from
	// the content already on the event (no new I/O).
	const sizeNudgeSuffix =
		estimateTokenCount(event.trackerContent) > DEFAULT_TRACKER_TOKEN_BOUND
			? buildTrackerSizeNudgeSuffix(cfg.trackerPromptPath)
			: '';

	if (event.adapterSessionId) {
		const nextNudgeStreak = nudgeStreak + 1;
		const nudgeCap = loop.nudgeCap ?? DEFAULT_NUDGE_CAP;
		if (nextNudgeStreak > nudgeCap) {
			return {
				phase: {
					kind: 'awaiting_attention',
					stopReason: `nudge cap reached: ${nudgeCap} nudge${
						nudgeCap === 1 ? '' : 's'
					} (nudgeCap) without tracker progress or a terminal marker`,
				},
				memory: {...memoryWithHash, nudgeStreak: nextNudgeStreak},
				actions: [{type: 'persist'}],
			};
		}
		const promptOverride =
			buildNudgePrompt(
				{...loop, trackerPath: cfg.trackerPromptPath ?? loop.trackerPath},
				{
					skeletonNotReplaced: event.trackerContent.includes(
						TRACKER_SKELETON_MARKER,
					),
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
	// so resuming preserves in-flight work the Tracker never checkpointed.
	// Otherwise fall back to whichever continuation this attempt used.
	const continuation: TurnContinuation = event.adapterSessionId
		? {mode: 'resume', handle: event.adapterSessionId}
		: phase.resume.continuation;

	// Replay invariant (ADR 0016 §3): replay the in-flight prompt iff this
	// attempt is a fresh Agent Session. A `resume`d session already contains
	// the prior instruction and failure record on disk — replaying it would
	// duplicate that content — while a fresh session contains neither, so it
	// needs the bare Continue Prompt to re-orient from the Tracker.
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
			cfg.trackerAbsPath ?? undefined,
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
				lastHandoffSizeBytes: event.handoffSizeBytes,
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
 * the human's reply with `buildWakePrompt`.
 */
function handleAwaitingAttention(
	memory: RunMemory,
	event: Extract<RunEvent, {type: 'woken'}>,
	cfg: StepConfig,
): StepResult {
	const nextIteration = memory.iteration + 1;
	const prompt = buildWakePrompt(cfg.initialPrompt, cfg.trackerPromptPath);
	const prepared = prepareWorkflowTurn(cfg.workflowState, {
		prompt: cfg.initialPrompt,
		iteration: nextIteration,
		configOverride: undefined,
	});
	return {
		phase: {
			kind: 'turn_in_flight',
			prompt,
			continuation: event.continuation,
			configOverride: prepared.configOverride,
		},
		memory: {
			...memory,
			iteration: nextIteration,
			lastStopPrompt: prompt,
			lastStopContinuation: event.continuation,
		},
		actions: [
			{type: 'persist'},
			{
				type: 'start_turn',
				prompt,
				continuation: event.continuation,
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
			if (event.type !== 'turn_finished') {
				throw new Error(
					`runMachine: phase 'turn_in_flight' received unexpected event '${event.type}'`,
				);
			}
			return handleTurnInFlight(phase, memory, event, cfg);
		}
		case 'backing_off': {
			if (event.type !== 'backoff_elapsed') {
				throw new Error(
					`runMachine: phase 'backing_off' received unexpected event '${event.type}'`,
				);
			}
			return handleBackingOff(phase, memory, event, cfg);
		}
		case 'handing_over': {
			if (event.type !== 'fork_finished') {
				throw new Error(
					`runMachine: phase 'handing_over' received unexpected event '${event.type}'`,
				);
			}
			return handleHandingOver(phase, memory, event, cfg);
		}
		case 'awaiting_attention': {
			if (event.type !== 'woken') {
				throw new Error(
					`runMachine: phase 'awaiting_attention' received unexpected event '${event.type}'`,
				);
			}
			return handleAwaitingAttention(memory, event, cfg);
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
	const continuation = candidate.lastStopContinuation as
		| {mode?: unknown}
		| undefined;
	if (
		typeof candidate.iteration !== 'number' ||
		typeof candidate.nudgeStreak !== 'number' ||
		typeof candidate.retryStreak !== 'number' ||
		(candidate.lastTrackerHash !== null &&
			typeof candidate.lastTrackerHash !== 'string') ||
		typeof candidate.lastStopPrompt !== 'string' ||
		!continuation ||
		typeof continuation.mode !== 'string'
	) {
		return null;
	}
	return candidate as unknown as RunMemory;
}
