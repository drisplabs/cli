import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
	HarnessProcessOverride,
	TurnContinuation,
	TurnExecutionResult,
} from '../runtime/process';
import type {TokenUsage} from '../../shared/types/headerMetrics';
import type {AthenaHarness} from '../../infra/plugins/config';
import type {RunStatus, WorkflowConfig} from './types';
import type {WorkflowRunSnapshot} from '../../infra/sessions/types';
import {
	createWorkflowRunState,
	prepareWorkflowTurn,
	resolveTrackerPath,
} from './sessionPlan';
import {classifyTurnFailure} from '../runtime/failureTaxonomy';
import {resolveTurnOutcome} from './terminalOutcome';
import {
	buildNudgePrompt,
	readTracker,
	TRACKER_SKELETON_MARKER,
} from './trackerReader';
import {
	DEFAULT_NUDGE_CAP,
	DEFAULT_RETRY_BACKOFF_MS,
	DEFAULT_RETRY_CAP,
} from './types';
import {substituteVariables} from './templateVars';

export type TurnInput = {
	prompt: string;
	continuation: TurnContinuation;
	configOverride?: HarnessProcessOverride;
};

export type WorkflowRunnerInput = {
	sessionId: string;
	projectDir: string;
	harness?: AthenaHarness;
	workflow?: WorkflowConfig;
	prompt: string;
	initialContinuation?: TurnContinuation;
	/**
	 * Reuse an existing Workflow Run id instead of minting a new one — the
	 * human-resume path (ADR 0014 §6): waking a Run suspended in
	 * `awaiting_attention` returns that same Run to `running` rather than
	 * leaving a forever-suspended row beside a new one.
	 */
	resumeRunId?: string;

	startTurn: (input: TurnInput) => Promise<TurnExecutionResult>;
	persistRunState: (snapshot: WorkflowRunSnapshot) => void;
	onIterationComplete?: (snapshot: WorkflowRunSnapshot) => void;
	abortCurrentTurn?: () => void;
	createTracker?: (trackerPath: string, content: string) => void;
	/**
	 * Consulted after each Turn, before failure classification. A non-null
	 * result suspends the Run in `awaiting_attention` with the given reason
	 * (ADR 0014) — used when a Turn was interrupted because the agent asked a
	 * question no attached human can answer. Takes precedence over the Turn's
	 * exit code: interrupting the Turn to suspend is not a failure.
	 */
	checkSuspension?: () => {reason: string} | null;
	/**
	 * Vendor session id (Claude session / Codex thread) of the most recent
	 * Turn's Agent Session, as observed by the caller's runtime. Snapshotted on
	 * every persist, and the handle the Runner resumes for a Nudge (ADR 0014
	 * §3, §6). Returning null/undefined is safe — the id is simply absent and
	 * continuation falls back to a fresh Turn.
	 */
	currentAdapterSessionId?: () => string | null | undefined;
};

export type WorkflowRunResult = {
	runId: string;
	status: RunStatus;
	iterations: number;
	stopReason?: string;
	tokens: TokenUsage;
};

export type WorkflowRunnerHandle = {
	readonly runId: string;
	result: Promise<WorkflowRunResult>;
	cancel: () => void;
	kill: () => void;
};

const NULL_TOKENS: TokenUsage = {
	input: null,
	output: null,
	cacheRead: null,
	cacheWrite: null,
	total: null,
	contextSize: null,
	contextWindowSize: null,
};

const TRACKER_SKELETON_TEMPLATE = `${TRACKER_SKELETON_MARKER}
# Workflow Tracker

**Session**: {sessionId}
**Tracker**: {trackerPath}
**Goal**: {input}

---

> This tracker was created by the runner. Update it as you work.
> See the Stateless Turn Protocol for tracker conventions.

## Status

Orientation in progress.

## Plan

_To be created during orientation._

## Progress

_No progress yet._
`;

function mergeTokens(base: TokenUsage, next: TokenUsage): TokenUsage {
	const input = (base.input ?? 0) + (next.input ?? 0);
	const output = (base.output ?? 0) + (next.output ?? 0);
	const cacheRead = (base.cacheRead ?? 0) + (next.cacheRead ?? 0);
	const cacheWrite = (base.cacheWrite ?? 0) + (next.cacheWrite ?? 0);
	const hasAny =
		base.input !== null ||
		next.input !== null ||
		base.output !== null ||
		next.output !== null ||
		base.cacheRead !== null ||
		next.cacheRead !== null ||
		base.cacheWrite !== null ||
		next.cacheWrite !== null;
	if (!hasAny)
		return {
			...NULL_TOKENS,
			contextSize: next.contextSize,
			contextWindowSize: next.contextWindowSize,
		};
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: input + output + cacheRead + cacheWrite,
		contextSize: next.contextSize ?? base.contextSize,
		contextWindowSize: next.contextWindowSize ?? base.contextWindowSize,
	};
}

/**
 * Sleep for `ms`, waking early (in ~250ms slices) if `isCancelled` flips —
 * a Run being killed must not sit out a full retry backoff.
 */
async function delayWithCancel(
	ms: number,
	isCancelled: () => boolean,
): Promise<void> {
	const slice = 250;
	for (let waited = 0; waited < ms && !isCancelled(); waited += slice) {
		await new Promise(resolve =>
			setTimeout(resolve, Math.min(slice, ms - waited)),
		);
	}
}

function defaultCreateTracker(trackerPath: string, content: string): void {
	fs.mkdirSync(path.dirname(trackerPath), {recursive: true});
	try {
		fs.writeFileSync(trackerPath, content, {encoding: 'utf-8', flag: 'wx'});
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
	}
}

export function createWorkflowRunner(
	input: WorkflowRunnerInput,
): WorkflowRunnerHandle {
	const runId = input.resumeRunId ?? crypto.randomUUID();
	let cancelled = false;
	let status: RunStatus = 'running';
	let iterations = 0;
	let cumulativeTokens: TokenUsage = {...NULL_TOKENS};
	let stopReason: string | undefined;

	const trackerResolved = resolveTrackerPath({
		projectDir: input.projectDir,
		sessionId: input.sessionId,
		workflow: input.workflow,
	});
	const trackerAbsPath = trackerResolved?.absolutePath ?? null;
	const trackerPromptPath = trackerResolved?.promptPath;

	function snapshot(): WorkflowRunSnapshot {
		const adapterSessionId = input.currentAdapterSessionId?.() ?? undefined;
		return {
			runId,
			sessionId: input.sessionId,
			workflowName: input.workflow?.name,
			iteration: iterations,
			maxIterations: input.workflow?.loop?.maxIterations ?? 1,
			status,
			stopReason,
			trackerPath: trackerPromptPath,
			...(adapterSessionId ? {adapterSessionId} : {}),
		};
	}

	function persist(): void {
		try {
			input.persistRunState(snapshot());
		} catch {
			// Persistence failure is non-fatal for the runner
		}
	}

	const result = (async (): Promise<WorkflowRunResult> => {
		// Yield to the microtask queue so the caller can capture the handle
		// before we start executing turns. Without this, startTurn would be
		// invoked synchronously inside createWorkflowRunner, before the
		// returned handle is assigned.
		await Promise.resolve();

		// Create tracker skeleton if needed
		if (trackerAbsPath && input.workflow?.loop?.enabled) {
			const content = substituteVariables(TRACKER_SKELETON_TEMPLATE, {
				sessionId: input.sessionId,
				trackerPath: trackerPromptPath,
				input: input.prompt,
			});
			const write = input.createTracker ?? defaultCreateTracker;
			write(trackerAbsPath, content);
		}

		persist();

		const workflowState = createWorkflowRunState({
			projectDir: input.projectDir,
			sessionId: input.sessionId,
			workflow: input.workflow,
			harness: input.harness,
		});

		let nextContinuation: TurnContinuation = input.initialContinuation ?? {
			mode: 'fresh',
		};
		// Nudge state (ADR 0014 §3): consecutive undeclared stops without
		// Tracker progress, and the Tracker content at the last stop. The
		// corrective prompt for a nudged (resumed) Turn overrides the prepared
		// Continue Prompt for exactly one Turn.
		let nudgeStreak = 0;
		let lastStopTrackerContent: string | null = null;
		let nextPromptOverride: string | null = null;
		// Retry state (ADR 0014 §4): consecutive transient Turn failures.
		// Resets on any Turn that completes without failing.
		let retryStreak = 0;

		const loop = input.workflow?.loop;

		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancelled is mutated externally during await
		while (!cancelled) {
			iterations++;
			const prepared = prepareWorkflowTurn(workflowState, {
				prompt: input.prompt,
				iteration: iterations,
				configOverride: undefined,
			});

			const attemptedContinuation = nextContinuation;
			const promptForTurn = nextPromptOverride ?? prepared.prompt;
			nextPromptOverride = null;
			const turnResult = await input.startTurn({
				prompt: promptForTurn,
				continuation: attemptedContinuation,
				configOverride: prepared.configOverride,
			});

			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancelled is mutated externally during await
			if (cancelled) {
				status = 'cancelled';
				persist();
				break;
			}

			cumulativeTokens = mergeTokens(cumulativeTokens, turnResult.tokens);

			// Declared attention interrupted this Turn (e.g. an AskUserQuestion no
			// attached human can answer). Checked before failure classification:
			// the interruption ends the harness process abnormally, but the Run is
			// suspended, not failed.
			const suspension = input.checkSuspension?.();
			if (suspension) {
				status = 'awaiting_attention';
				stopReason = suspension.reason;
				persist();
				break;
			}

			if (
				turnResult.error ||
				(turnResult.exitCode !== null && turnResult.exitCode !== 0)
			) {
				const parts: string[] = [];
				if (turnResult.error?.message) {
					parts.push(turnResult.error.message);
				} else if (turnResult.exitCode !== null) {
					parts.push(`Process exited with code ${turnResult.exitCode}`);
				}
				if (turnResult.lastStderr) {
					parts.push(turnResult.lastStderr);
				}
				const failureDetail = parts.join(': ') || 'Turn failed';

				// Failure taxonomy (ADR 0014 §4), looped Runs only: transient →
				// backoff then resume the same Agent Session; hard (incl.
				// unclassifiable) → suspend for a human. Non-looped runs keep
				// the plain terminal failure below.
				if (loop?.enabled) {
					const classification = classifyTurnFailure({
						errorMessage: turnResult.error?.message,
						lastStderr: turnResult.lastStderr,
					});

					if (classification.kind === 'transient') {
						retryStreak++;
						const retryCap = loop.retryCap ?? DEFAULT_RETRY_CAP;
						if (retryStreak > retryCap) {
							status = 'awaiting_attention';
							stopReason = `retry cap reached: ${retryCap} transient failure${
								retryCap === 1 ? '' : 's'
							} (retryCap); last (${classification.code}): ${failureDetail}`;
							persist();
							break;
						}
						// Backoff, then resume the same Agent Session — it persists
						// on disk, so resuming preserves in-flight work the Tracker
						// never checkpointed. The Run stays `running`, and the
						// failed attempt does not burn an iteration.
						const backoffBase = loop.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
						await delayWithCancel(
							backoffBase * 2 ** (retryStreak - 1),
							() => cancelled,
						);
						// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancelled is mutated externally during await
						if (cancelled) break;
						iterations--;
						const adapterSessionId = input.currentAdapterSessionId?.() ?? null;
						nextContinuation = adapterSessionId
							? {mode: 'resume', handle: adapterSessionId}
							: attemptedContinuation;
						persist();
						continue;
					}

					// Hard failure on a resumed Turn: degrade to a fresh replay of
					// the same iteration first (ADR 0014 / #139) — this is the
					// missing-or-invalid-session recovery. Bounded by construction:
					// the replay runs fresh, so a second hard failure suspends.
					if (attemptedContinuation.mode === 'resume') {
						iterations--;
						nextContinuation = {mode: 'fresh'};
						persist();
						continue;
					}

					// Hard (or unclassifiable) failure → escalate to a human
					// rather than retry blindly (ADR 0014 §4, §7).
					status = 'awaiting_attention';
					stopReason = `hard failure (${classification.code}): ${failureDetail} — not retried; needs a human`;
					persist();
					break;
				}

				status = 'failed';
				stopReason = failureDetail;
				persist();
				break;
			}

			// The Turn completed without failing — the transient-failure streak
			// is over.
			retryStreak = 0;

			const transport = turnResult.diagnostics?.transport;
			if (
				transport &&
				transport.streamToolUses > 0 &&
				transport.preToolUseEvents === 0
			) {
				status = 'failed';
				stopReason = `Hook transport broken: observed ${transport.streamToolUses} tool use(s) in Claude stream but received no PreToolUse events.`;
				persist();
				break;
			}

			// Non-looped: single turn, done.
			if (!loop?.enabled) {
				status = 'completed';
				persist();
				break;
			}

			// Looped: one owner maps the Tracker's end-state to a final Run Status.
			if (trackerAbsPath) {
				const outcome = resolveTurnOutcome({
					trackerPath: trackerAbsPath,
					loop,
					iteration: iterations,
				});
				if (outcome.kind === 'stop' || outcome.kind === 'suspend') {
					status = outcome.status;
					stopReason = outcome.stopReason;
					persist();
					break;
				}
			}

			// Undeclared markerless stop → Nudge (ADR 0014 §3): resume the same
			// Agent Session with a corrective prompt — finish, or declare a
			// marker. Bounded by the Nudge cap, which resets whenever the
			// Tracker advances between stops so only unproductive repeated
			// stops escalate (checkpointing workflows never trip it).
			const trackerContent = trackerAbsPath ? readTracker(trackerAbsPath) : '';
			if (trackerContent !== lastStopTrackerContent) {
				nudgeStreak = 0;
			}
			lastStopTrackerContent = trackerContent;

			const adapterSessionId = input.currentAdapterSessionId?.() ?? null;
			if (adapterSessionId) {
				nudgeStreak++;
				const nudgeCap = loop.nudgeCap ?? DEFAULT_NUDGE_CAP;
				if (nudgeStreak > nudgeCap) {
					status = 'awaiting_attention';
					stopReason = `nudge cap reached: ${nudgeCap} nudge${
						nudgeCap === 1 ? '' : 's'
					} (nudgeCap) without tracker progress or a terminal marker`;
					persist();
					break;
				}
				nextContinuation = {mode: 'resume', handle: adapterSessionId};
				nextPromptOverride = buildNudgePrompt({
					...loop,
					trackerPath: trackerPromptPath ?? loop.trackerPath,
				});
			} else {
				// No vendor session id to resume (harness never reported one):
				// fall back to the pre-Nudge behaviour — a fresh Turn seeded by
				// the Continue Prompt.
				nextContinuation = {mode: 'fresh'};
			}
			persist();
			input.onIterationComplete?.(snapshot());
		}

		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancelled is mutated externally during await
		if (cancelled && status === 'running') {
			status = 'cancelled';
			persist();
		}

		return {
			runId,
			status,
			iterations,
			stopReason,
			tokens: cumulativeTokens,
		};
	})();

	return {
		runId,
		result,
		cancel() {
			cancelled = true;
		},
		kill() {
			cancelled = true;
			input.abortCurrentTurn?.();
		},
	};
}
