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
import type {TrackerMarkers} from './trackerReader';
import {createWorkflowRunState, resolveTrackerPath} from './sessionPlan';
import {resolveTurnOutcome} from './terminalOutcome';
import {
	readTracker,
	TRACKER_SKELETON_MARKER,
	demoteTerminalMarkers,
} from './trackerReader';
import {substituteVariables} from './templateVars';
import {
	step,
	createInitialRun,
	serializeRunMemory,
	type RunPhase,
	type RunMemory,
	type RunEvent,
	type RunAction,
	type StepConfig,
} from './runMachine';

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
	/**
	 * A previously persisted `RunMemory` (ADR 0016 §2, §6) to rehydrate from
	 * instead of starting fresh — so a resumed Run continues its Iteration,
	 * Nudge streak, and Retry streak budgets rather than restarting them.
	 * Optional and additive: omitted, this Runner behaves exactly as before —
	 * no caller is wired to load and pass this yet (that plumbing is left to
	 * a follow-up; the mechanism itself is exercised directly by
	 * `runMachine.test.ts`).
	 */
	resumedRunMemory?: RunMemory;

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
	/**
	 * Handover orchestration seam (ADR 0014 §5). The caller intercepts the
	 * harness's `compact.pre`, blocks the compaction, interrupts the Turn, and
	 * records the request; the Runner then forks the live conversation, has
	 * the `handoff` skill write a Handoff file, discards the fork, and starts
	 * a fresh Turn seeded with the Handoff file + Tracker — the only
	 * transition that resets context instead of resuming.
	 */
	handover?: {
		/** Return and clear the pending request, or null when none. */
		takeRequest: () => {handle: string} | null;
		/**
		 * The fork is starting/ending — while true the caller must keep
		 * blocking `compact.pre` so writing the handoff cannot be compacted.
		 */
		onForkStateChange?: (forking: boolean) => void;
		/**
		 * Handover failed for this session — degrade: stop intercepting its
		 * compactions so normal vendor compaction proceeds (never stall).
		 */
		onDegraded?: (handle: string) => void;
	};
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
> See the Turn Protocol for tracker conventions.

## Status

Orientation in progress.

## Plan

_To be created during orientation._

## Progress

_No progress yet._
`;

/**
 * Open a new Workflow Run's section on an existing Tracker.
 *
 * `DEFAULT_TRACKER_PATH` is keyed on the Athena Session, so every Workflow Run
 * in a Session shares one Tracker and the skeleton — the only place the Run's
 * `{input}` goal is recorded — is written just once, for the first Run. Later
 * Runs then worked against a Tracker that never said what they had been asked
 * to do, and inherited their predecessor's Terminal Marker along with it.
 *
 * Opening a section fixes both: it records this Run's goal, and it demotes the
 * prior Run's markers so they neither end this Run at its first Turn nor read
 * as misplaced once it writes below them.
 */
function openRunSection(
	trackerPath: string,
	opts: {runId: string; goal: string; markers: TrackerMarkers},
): void {
	let existing: string;
	try {
		existing = fs.readFileSync(trackerPath, 'utf-8');
	} catch {
		return;
	}

	const banner =
		`\n\n---\n\n## New Workflow Run\n\n` +
		`**Run**: ${opts.runId}\n` +
		`**Goal**: ${opts.goal}\n\n` +
		`_Sections above belong to earlier Workflow Runs in this Athena Session._\n`;

	try {
		fs.writeFileSync(
			trackerPath,
			demoteTerminalMarkers(existing.trimEnd(), opts.markers) + banner,
			'utf-8',
		);
	} catch {
		// A Tracker that cannot be rewritten is left as-is; the Run still starts.
	}
}

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
 * Prompt for the forked Agent Session: invoke the first-party `handoff` skill
 * (delivered to every Workflow Run via the plugin path) to distill the
 * conversation into a Handoff file at a path the Runner controls.
 */
function buildHandoffInvocationPrompt(handoffPath: string): string {
	return (
		`Invoke the handoff skill to write a Handoff file to ${handoffPath}. ` +
		`Do nothing else: no code changes, no tracker updates — only the Handoff file.`
	);
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

/** Handoff files form a numbered chain: `handoff/001.md`, `002.md`, … */
const HANDOFF_DIR_NAME = 'handoff';

/** How many Handoff files to retain; older ones are purged after a Handover. */
const HANDOFF_RETAIN = 2;

function listHandoffSeqs(dir: string): number[] {
	try {
		return fs
			.readdirSync(dir)
			.map(name => /^(\d{3})\.md$/.exec(name)?.[1])
			.filter((seq): seq is string => seq !== undefined)
			.map(Number)
			.sort((a, b) => a - b);
	} catch {
		return [];
	}
}

function handoffPathFor(dir: string, seq: number): string {
	return path.join(dir, `${String(seq).padStart(3, '0')}.md`);
}

/**
 * Allocate the path for the next Handoff file.
 *
 * A fresh sequence number per Handover is what lets `existsSync` prove that
 * *this* fork wrote the file — the job the pre-Handover `rmSync` used to do,
 * at the cost of destroying Handoff N before N+1 was written. Past the second
 * Handover that left the Tracker as the sole carrier again, which is the
 * condition ADR 0014 §5 exists to relieve.
 */
function nextHandoffPath(dir: string): string {
	const next = (listHandoffSeqs(dir).at(-1) ?? 0) + 1;
	fs.mkdirSync(dir, {recursive: true});
	return handoffPathFor(dir, next);
}

/** Drop all but the `keep` most recent Handoff files. Best-effort. */
function purgeHandoffs(dir: string, keep: number): void {
	const seqs = listHandoffSeqs(dir);
	for (const seq of seqs.slice(0, Math.max(0, seqs.length - keep))) {
		try {
			fs.rmSync(handoffPathFor(dir, seq), {force: true});
		} catch {
			// A file that cannot be removed is left behind; retention is advisory.
		}
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

function isTerminalPhase(
	phase: RunPhase,
): phase is Extract<
	RunPhase,
	{kind: 'awaiting_attention' | 'completed' | 'failed' | 'cancelled'}
> {
	return (
		phase.kind === 'awaiting_attention' ||
		phase.kind === 'completed' ||
		phase.kind === 'failed' ||
		phase.kind === 'cancelled'
	);
}

function terminalPhaseToStatus(
	phase: Extract<
		RunPhase,
		{kind: 'awaiting_attention' | 'completed' | 'failed' | 'cancelled'}
	>,
): {status: RunStatus; stopReason?: string} {
	switch (phase.kind) {
		case 'awaiting_attention':
			return {status: 'awaiting_attention', stopReason: phase.stopReason};
		case 'completed':
			return {status: 'completed'};
		case 'failed':
			return {status: 'failed', stopReason: phase.stopReason};
		case 'cancelled':
			return {status: 'cancelled'};
	}
}

/**
 * `perform()` — the interpreter (ADR 0016 §1): the sole point of contact with
 * the outside world. It executes the `RunAction[]` the reducer (`step()`, in
 * `runMachine.ts`) returns, gathers exactly one `RunEvent` describing what
 * happened, and hands it back to `step()`. All fs/timer/harness/callback I/O
 * lives here; the reducer never touches any of it.
 */
export function createWorkflowRunner(
	input: WorkflowRunnerInput,
): WorkflowRunnerHandle {
	const runId = input.resumeRunId ?? crypto.randomUUID();
	let cancelled = false;
	let status: RunStatus = 'running';
	let cumulativeTokens: TokenUsage = {...NULL_TOKENS};
	let stopReason: string | undefined;
	let memory: RunMemory | undefined;

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
			iteration: memory?.iteration ?? 0,
			maxIterations: input.workflow?.loop?.maxIterations ?? 1,
			status,
			stopReason,
			trackerPath: trackerPromptPath,
			...(adapterSessionId ? {adapterSessionId} : {}),
			...(memory ? {runMemoryJson: serializeRunMemory(memory)} : {}),
		};
	}

	function persist(): void {
		try {
			input.persistRunState(snapshot());
		} catch {
			// Persistence failure is non-fatal for the runner
		}
	}

	function handoffDirFor(): string {
		return path.join(
			trackerAbsPath
				? path.dirname(trackerAbsPath)
				: path.resolve(
						input.projectDir,
						'.athena',
						input.sessionId || 'session',
					),
			HANDOFF_DIR_NAME,
		);
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
			// Write-if-absent: the skeleton belongs to the Session's first Run.
			const trackerExisted = fs.existsSync(trackerAbsPath);
			write(trackerAbsPath, content);
			// A wake continues the same Run, so it opens no new section.
			if (trackerExisted && !input.resumeRunId) {
				openRunSection(trackerAbsPath, {
					runId,
					goal: input.prompt,
					markers: {
						completionMarker: input.workflow.loop.completionMarker,
						blockedMarker: input.workflow.loop.blockedMarker,
					},
				});
			}
		}

		persist();

		const workflowState = createWorkflowRunState({
			projectDir: input.projectDir,
			sessionId: input.sessionId,
			workflow: input.workflow,
			harness: input.harness,
		});

		const loop = input.workflow?.loop;
		const cfg: StepConfig = {
			workflowState,
			initialPrompt: input.prompt,
			loop,
			trackerAbsPath,
			trackerPromptPath,
		};

		const initial = createInitialRun(cfg, {
			initialContinuation: input.initialContinuation,
			waking: !!(input.resumeRunId && loop?.enabled),
			resumedMemory: input.resumedRunMemory,
		});
		let phase: RunPhase = initial.phase;
		memory = initial.memory;

		// --- action execution -------------------------------------------------

		async function performStartTurn(
			prompt: string,
			continuation: TurnContinuation,
			configOverride: HarnessProcessOverride | undefined,
		): Promise<RunEvent> {
			const turnResult = await input.startTurn({
				prompt,
				continuation,
				configOverride,
			});

			if (cancelled) {
				return {
					type: 'turn_finished',
					cancelled: true,
					hasError: false,
					exitCode: null,
					streamMessage: null,
					transportBroken: false,
					handoverRequestHandle: null,
					suspension: null,
					adapterSessionId: null,
					outcome: null,
					trackerContent: '',
				};
			}

			cumulativeTokens = mergeTokens(cumulativeTokens, turnResult.tokens);

			// Handover (ADR 0014 §5): checked before suspension and failure
			// classification — the interruption is neither.
			const handoverRequest = input.handover?.takeRequest() ?? null;
			if (handoverRequest) {
				return {
					type: 'turn_finished',
					cancelled: false,
					hasError: false,
					exitCode: null,
					streamMessage: null,
					transportBroken: false,
					handoverRequestHandle: handoverRequest.handle,
					suspension: null,
					adapterSessionId: null,
					outcome: null,
					trackerContent: '',
				};
			}

			// Declared attention interrupted this Turn. Checked before failure
			// classification: the interruption ends the harness process
			// abnormally, but the Run is suspended, not failed.
			const suspension = input.checkSuspension?.() ?? null;
			if (suspension) {
				return {
					type: 'turn_finished',
					cancelled: false,
					hasError: false,
					exitCode: null,
					streamMessage: null,
					transportBroken: false,
					handoverRequestHandle: null,
					suspension,
					adapterSessionId: null,
					outcome: null,
					trackerContent: '',
				};
			}

			const adapterSessionId = input.currentAdapterSessionId?.() ?? null;
			const hasError = !!turnResult.error;
			const failed =
				hasError || (turnResult.exitCode !== null && turnResult.exitCode !== 0);
			if (failed) {
				return {
					type: 'turn_finished',
					cancelled: false,
					hasError,
					errorMessage: turnResult.error?.message,
					exitCode: turnResult.exitCode,
					lastStderr: turnResult.lastStderr,
					stderrTail: turnResult.stderrTail,
					streamMessage: turnResult.streamMessage,
					transportBroken: false,
					handoverRequestHandle: null,
					suspension: null,
					adapterSessionId,
					outcome: null,
					trackerContent: '',
				};
			}

			const transport = turnResult.diagnostics?.transport;
			const transportBroken = !!(
				transport &&
				transport.streamToolUses > 0 &&
				transport.preToolUseEvents === 0
			);

			// Looped: one owner (`resolveTurnOutcome`) maps the Tracker's end-state
			// to a final Run Status — only consulted on the success path, once the
			// hook transport is known-good, matching the original's lazy read.
			let trackerContent = '';
			let outcome = null;
			if (!transportBroken && loop?.enabled && trackerAbsPath) {
				trackerContent = readTracker(trackerAbsPath);
				outcome = resolveTurnOutcome({
					trackerPath: trackerAbsPath,
					loop,
					iteration: memory!.iteration,
				});
			}

			return {
				type: 'turn_finished',
				cancelled: false,
				hasError: false,
				exitCode: turnResult.exitCode,
				streamMessage: turnResult.streamMessage,
				transportBroken,
				handoverRequestHandle: null,
				suspension: null,
				adapterSessionId,
				outcome,
				trackerContent,
			};
		}

		async function performForkTurn(
			handle: string,
			configOverride: HarnessProcessOverride | undefined,
		): Promise<RunEvent> {
			const handoffDir = handoffDirFor();
			const handoffAbsPath = nextHandoffPath(handoffDir);

			input.handover?.onForkStateChange?.(true);
			let forkOk = false;
			try {
				const forkResult = await input.startTurn({
					prompt: buildHandoffInvocationPrompt(handoffAbsPath),
					continuation: {mode: 'resume', handle},
					configOverride: {...configOverride, forkSession: true},
				});
				cumulativeTokens = mergeTokens(cumulativeTokens, forkResult.tokens);
				forkOk =
					!forkResult.error &&
					(forkResult.exitCode === null || forkResult.exitCode === 0) &&
					fs.existsSync(handoffAbsPath);
			} catch {
				forkOk = false;
			} finally {
				input.handover?.onForkStateChange?.(false);
			}

			return {
				type: 'fork_finished',
				ok: forkOk,
				cancelled,
				handoffPath: handoffAbsPath,
			};
		}

		async function performWait(ms: number): Promise<RunEvent> {
			await delayWithCancel(ms, () => cancelled);
			if (cancelled) {
				return {
					type: 'backoff_elapsed',
					cancelled: true,
					adapterSessionId: null,
				};
			}
			const adapterSessionId = input.currentAdapterSessionId?.() ?? null;
			return {type: 'backoff_elapsed', cancelled: false, adapterSessionId};
		}

		function isKickoffAction(action: RunAction): boolean {
			return (
				action.type === 'start_turn' ||
				action.type === 'start_fork_turn' ||
				action.type === 'wait'
			);
		}

		/**
		 * Execute every non-kickoff (side-effect) action in order, then the
		 * kickoff action (if any) — a phase's actions always carry at most one.
		 * Returns the event the kickoff action produced, or `null` for a
		 * terminal phase's actions (persist only, no kickoff).
		 */
		async function runActions(actions: RunAction[]): Promise<RunEvent | null> {
			let kickoff: RunAction | null = null;
			for (const action of actions) {
				if (isKickoffAction(action)) {
					kickoff = action;
					continue;
				}
				// eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- kickoff action types are filtered out above by isKickoffAction and handled in the switch below
				switch (action.type) {
					case 'persist':
						persist();
						break;
					case 'notify_iteration_complete':
						input.onIterationComplete?.(snapshot());
						break;
					case 'purge_handoffs':
						purgeHandoffs(handoffDirFor(), HANDOFF_RETAIN);
						break;
					case 'degrade_handover':
						input.handover?.onDegraded?.(action.handle);
						break;
				}
			}
			if (!kickoff) return null;
			// eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- non-kickoff action types are handled in the switch above
			switch (kickoff.type) {
				case 'start_turn':
					return performStartTurn(
						kickoff.prompt,
						kickoff.continuation,
						kickoff.configOverride,
					);
				case 'start_fork_turn':
					return performForkTurn(kickoff.handle, kickoff.configOverride);
				case 'wait':
					return performWait(kickoff.ms);
				default:
					return null;
			}
		}

		// --- interpreter loop ---------------------------------------------------

		const bootstrapActions: RunAction[] =
			phase.kind === 'turn_in_flight'
				? [
						{
							type: 'start_turn',
							prompt: phase.prompt,
							continuation: phase.continuation,
							configOverride: phase.configOverride,
						},
					]
				: phase.kind === 'backing_off'
					? [{type: 'wait', ms: phase.ms}]
					: [];

		let pendingEvent = await runActions(bootstrapActions);

		while (pendingEvent) {
			const stepResult = step(phase, memory, pendingEvent, cfg);
			phase = stepResult.phase;
			memory = stepResult.memory;

			if (isTerminalPhase(phase)) {
				const terminal = terminalPhaseToStatus(phase);
				status = terminal.status;
				stopReason = terminal.stopReason;
				await runActions(stepResult.actions);
				break;
			}

			pendingEvent = await runActions(stepResult.actions);
		}

		return {
			runId,
			status,
			iterations: memory.iteration,
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
