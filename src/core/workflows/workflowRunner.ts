import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {Interruption} from '@drisp/protocol';
import type {
	HarnessProcessOverride,
	TurnContinuation,
	TurnExecutionResult,
} from '../runtime/process';
import type {TokenUsage} from '../../shared/types/headerMetrics';
import type {AthenaHarness} from '../../infra/plugins/config';
import type {RunStatus, WorkflowConfig} from './types';
import type {WorkflowRunSnapshot} from './runState';
import type {JournalMarkers, JournalTaskProjection} from './journalReader';
import {createWorkflowRunState, resolveJournalPath} from './sessionPlan';
import {resolveTurnOutcome} from './terminalOutcome';
import {
	readJournal,
	JOURNAL_SKELETON_MARKER,
	checkShedIntegrity,
	demoteTerminalMarkers,
	insertAboveTerminalMarker,
	projectJournalTasks,
	type UnitRecordSnapshot,
} from './journalReader';
import {substituteVariables} from './templateVars';
import {admitContinuation, type ResourceStop} from './continuationPolicy';
import {readRestartContract, restartInstructions} from './restartContract';
import {DEFAULT_MAX_TURN_TOKEN_COUNT} from './types';
import {estimateTokenCount} from './journalReader';
import {createPhaseTracker} from './turnProtocolBlock';
import {
	formatSteerJournalEntry,
	type DeliveredSteer,
	type QueuedSteer,
} from './steer';
import {
	step,
	createInitialRun,
	serializeRunMemory,
	type HandoverCompletion,
	type RunPhase,
	type RunMemory,
	type RunEvent,
	type RunAction,
	type RunInterruption,
	type StepConfig,
} from './runMachine';

export type HandoverCompletionReport = HandoverCompletion & {
	tokens: TokenUsage;
};

export type TurnInput = {
	/** Invocation-local cumulative usage, never session-lifetime totals. */
	onUsage?: (usage: TokenUsage) => void;
	prompt: string;
	continuation: TurnContinuation;
	configOverride?: HarnessProcessOverride;

	iteration: number;
};

/**
 * The Run moved to a new workflow step: what the Journal's Turn Protocol
 * block named after the Turn at `turn`. Emitted once per change of step, so
 * two consecutive Turns on the same step produce one, not two. Mirrors the
 * `phase` event in `@drisp/protocol`.
 */
export type PhaseChange = {
	runId: string;
	turn: number;
	step: string;
	stepIndex?: number;
	stepTotal?: number;
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
	 * Optional and additive: omitted, this Runner behaves exactly as before.
	 * The headless `runExec` path (`src/app/exec/runner.ts`) derives this from
	 * `store.getLatestRun()` when `resumeRunId` is set; the interactive
	 * `useWorkflowSessionController` path does not yet pass `resumeRunId` at
	 * all, so it has no wake-from-suspend of its own to wire this through.
	 */
	resumedRunMemory?: RunMemory;
	/**
	 * The Interruption the Run being woken parked on (#190), read from its
	 * record by the caller. A deferred question turns the wake prompt into a
	 * replay instruction — re-issue that exact call — so the runner can apply
	 * a stored answer to it without asking again.
	 */
	parkedInterruption?: Interruption;
	/**
	 * The persisted `stop_reason` of the resumed Run (ADR 0016 §2, §6/§7) —
	 * only meaningful alongside `resumedRunMemory` when `resumeRunId` names a
	 * Run that was `awaiting_attention`. Restores the bound-tripped message a
	 * wake's `awaiting_attention` phase carries until the woken Turn advances
	 * it.
	 */
	resumedStopReason?: string;

	startTurn: (input: TurnInput) => Promise<TurnExecutionResult>;
	persistRunState: (snapshot: WorkflowRunSnapshot) => void;
	/**
	 * An iteration boundary: the snapshot of the Run, and its cumulative
	 * tokens so far (ADR 0018 §10) — shown on `iteration.complete` whether or
	 * not a `maxRunTokens` budget is configured.
	 */
	onIterationComplete?: (
		snapshot: WorkflowRunSnapshot,
		cumulativeTokens: TokenUsage,
	) => void;

	onHandoverCompleted?: (completion: HandoverCompletionReport) => void;
	/**
	 * The tool-call count of the Turn in flight, as the caller observes it
	 * (the exec runner counts `tool.pre` events per Turn). Read once the Turn
	 * ends; `null`/`undefined` when unknown. Optional.
	 */
	currentTurnToolCalls?: () => number | null | undefined;
	abortCurrentTurn?: () => void;
	createJournal?: (journalPath: string, content: string) => void;
	/**
	 * Receives non-fatal Runner notices — today, the deprecation logged when
	 * a Turn declares itself with the legacy `WORKFLOW_BLOCKED` marker (#185).
	 * Optional: an unwired caller simply drops the notice.
	 */
	onWarning?: (message: string) => void;
	/**
	 * Receives the Steers the Runner drained into a Turn's prompt (#191), each
	 * tagged with the Turn it was delivered into — called just before that
	 * Turn starts, after the Journal entry is written. Optional.
	 */
	onSteerDelivered?: (steers: DeliveredSteer[]) => void;
	/**
	 * Receives a {@link PhaseChange} when a Turn's Journal names a workflow
	 * step different from the last one seen (the Turn Protocol block, ADR
	 * 0015 §7). Derived in the journal-read path after a successful Turn;
	 * never touches the Run's phase/memory. A malformed block is reported
	 * through `onWarning` instead, once per distinct defect.
	 */
	onPhaseChange?: (change: PhaseChange) => void;
	/**
	 * Consulted after each Turn, before failure classification. A non-null
	 * result parks the Run in `awaiting_attention` (ADR 0014, #189) — used when
	 * a Turn was interrupted because an ask rule fired, the agent asked a
	 * question no attached human can answer, or a permission went unclaimed
	 * under a holding preset. The reducer names the reason. Takes precedence
	 * over the Turn's exit code: interrupting the Turn to park is not a
	 * failure. A permission that was held for the grace window and then
	 * deferred (#190) carries `permission`; the Runner records the resulting
	 * Interruption in the Journal and on the run record.
	 */
	checkInterruption?: () => RunInterruption | null;
	/**
	 * Vendor session id (Claude session / Codex thread) of the most recent
	 * Turn's Agent Session, as observed by the caller's runtime. Snapshotted on
	 * every persist, and the handle the Runner resumes for a Nudge (ADR 0014
	 * §3, §6). Returning null/undefined is safe — the id is simply absent and
	 * continuation falls back to a fresh Turn.
	 */
	currentAdapterSessionId?: () => string | null | undefined;

	handover?: {
		/** Return and clear the pending request, or null when none. */
		takeRequest: () => {handle: string} | null;
	};
	/**
	 * Task-tool projection seam (ADR 0015 §7). Called best-effort after every
	 * `persist` action with the Journal's `## Units` table + unit-record
	 * frontmatter projected into a harness-neutral shape — or not called at
	 * all when {@link projectJournalTasks} finds no table to project. A parse
	 * miss or a throw from this callback is swallowed: this can never fail a
	 * Turn or a Run. Optional — omitted, the Runner behaves exactly as before.
	 */
	projectTasks?: (tasks: JournalTaskProjection[]) => void;
};

export type WorkflowRunResult = {
	runId: string;
	status: RunStatus;
	iterations: number;
	stopReason?: string;
	/** The Interruption an `awaiting_attention` Run parked on, when structured (#190). */
	interruption?: Interruption;
	tokens: TokenUsage;
};

export type WorkflowRunnerHandle = {
	readonly runId: string;
	result: Promise<WorkflowRunResult>;
	cancel: () => void;
	kill: () => void;
	/**
	 * Queue a Steer (#191). It is never injected into a Turn in flight: it
	 * waits for the next Turn boundary and is delivered, with any others in
	 * arrival order, at the head of that Turn's prompt. A Steer sent before
	 * the first Turn starts heads the first prompt. Returns `false` once the
	 * Run has ended — a parked Run is steered through its continue instead.
	 */
	steer: (steer: QueuedSteer) => boolean;
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

const JOURNAL_SKELETON_TEMPLATE = `${JOURNAL_SKELETON_MARKER}
# Workflow Journal

**Session**: {sessionId}
**Journal**: {journalPath}
**Goal**: {input}

---

> This journal was created by the runner. Update it as you work.
> See the Turn Protocol for journal conventions.

## Status

Orientation in progress.

## Plan

_To be created during orientation._

## Progress

_No progress yet._
`;

/**
 * Open a new Workflow Run's section on an existing Journal.
 *
 * `DEFAULT_JOURNAL_PATH` is keyed on the Athena Session, so every Workflow Run
 * in a Session shares one Journal and the skeleton — the only place the Run's
 * `{input}` goal is recorded — is written just once, for the first Run. Later
 * Runs then worked against a Journal that never said what they had been asked
 * to do, and inherited their predecessor's Terminal Marker along with it.
 *
 * Opening a section fixes both: it records this Run's goal, and it demotes the
 * prior Run's markers so they neither end this Run at its first Turn nor read
 * as misplaced once it writes below them.
 */
function openRunSection(
	journalPath: string,
	opts: {runId: string; goal: string; markers: JournalMarkers},
): void {
	let existing: string;
	try {
		existing = fs.readFileSync(journalPath, 'utf-8');
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
			journalPath,
			demoteTerminalMarkers(existing.trimEnd(), opts.markers) + banner,
			'utf-8',
		);
	} catch {
		// A Journal that cannot be rewritten is left as-is; the Run still starts.
	}
}

/**
 * Record delivered Steers in the Journal (#191): each with its origin, when it
 * arrived, and the Turn it was delivered into. Written above any Terminal
 * Marker the Journal ends with — on a wake the answered `NEEDS_HUMAN` line
 * stays last, as the agent left it — so the entry never reads as prose after
 * a marker. Best-effort, like the Run-section banner.
 */
function recordSteersInJournal(
	journalPath: string,
	steers: readonly QueuedSteer[],
	iteration: number,
	markers: JournalMarkers,
): void {
	let existing: string;
	try {
		existing = fs.readFileSync(journalPath, 'utf-8');
	} catch {
		return;
	}
	const entries = steers
		.map(steer => formatSteerJournalEntry(steer, iteration))
		.join('');
	try {
		fs.writeFileSync(
			journalPath,
			insertAboveTerminalMarker(existing, entries, markers),
			'utf-8',
		);
	} catch {
		// A Journal that cannot be rewritten is left as-is; the Turn still starts.
	}
}

/**
 * Record the Interruption a parking Run carries on the Journal (#190) — a
 * runner-owned note in the same spirit as the Run section: the next Turn
 * reads the pending question there, and a human reading the Journal sees why
 * the Run stopped. Appended below whatever the agent wrote; the agent's prose
 * is never edited (ADR 0015 §7).
 */
function appendInterruptionNote(
	journalPath: string,
	interruption: Interruption,
): void {
	const lines = [
		'',
		'',
		'---',
		'',
		'## Needs human (runner note)',
		'',
		interruption.message,
		'',
	];
	if (interruption.kind === 'question') {
		if (interruption.question) lines.push(`- call: ${interruption.question}`);
		if (interruption.requestId)
			lines.push(`- request: ${interruption.requestId}`);
		lines.push(
			'',
			'_Written by the runner: the request above was deferred and this run is parked until a human answers it. ' +
				'On continue the agent re-issues the call; a stored answer is replayed into it without asking again._',
		);
	} else {
		lines.push(
			'_Written by the runner: this run is parked until a human replies._',
		);
	}
	try {
		fs.appendFileSync(journalPath, lines.join('\n') + '\n', 'utf-8');
	} catch {
		// A Journal that cannot be appended to still leaves the run record as
		// the durable carrier of the Interruption.
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

/**
 * The unit records beside the Journal (`units/*.md`), read for the
 * shed-integrity check (ADR 0018 §7). Read-only and best-effort: a missing
 * directory is no records, an unreadable file is skipped — never a failure,
 * never an edit (ADR 0015 §7).
 */
function readUnitRecords(journalAbsPath: string): UnitRecordSnapshot[] {
	const unitsDir = path.join(path.dirname(journalAbsPath), 'units');
	let names: string[];
	try {
		names = fs.readdirSync(unitsDir).filter(name => name.endsWith('.md'));
	} catch {
		return [];
	}
	const records: UnitRecordSnapshot[] = [];
	for (const name of names.sort()) {
		try {
			records.push({
				recordPath: `units/${name}`,
				content: fs.readFileSync(path.join(unitsDir, name), 'utf-8'),
			});
		} catch {
			// Unreadable record: not judged, not fatal.
		}
	}
	return records;
}

function defaultCreateJournal(journalPath: string, content: string): void {
	fs.mkdirSync(path.dirname(journalPath), {recursive: true});
	try {
		fs.writeFileSync(journalPath, content, {encoding: 'utf-8', flag: 'wx'});
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
	let cumulativeTokens: TokenUsage = {
		...(input.resumedRunMemory?.usage ?? NULL_TOKENS),
		total: input.resumedRunMemory?.cumulativeTokens ?? null,
	};
	let stopReason: string | undefined;
	let interruption: Interruption | undefined;
	let memory: RunMemory | undefined;
	// Steers (#191) that arrive before the interpreter loop is up are held
	// here and seeded into the first Turn; once the loop runs, `applySteer`
	// feeds them to the reducer instead.
	const preStartSteers: QueuedSteer[] = [];
	let applySteer: ((steer: QueuedSteer) => boolean) | null = null;

	const journalResolved = resolveJournalPath({
		projectDir: input.projectDir,
		sessionId: input.sessionId,
		workflow: input.workflow,
	});
	const journalAbsPath = journalResolved?.absolutePath ?? null;
	const journalPromptPath = journalResolved?.promptPath;

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
			journalPath: journalPromptPath,
			...(adapterSessionId ? {adapterSessionId} : {}),
			...(memory ? {runMemoryJson: serializeRunMemory(memory)} : {}),
			...(interruption ? {interruption} : {}),
		};
	}

	let persistenceFailure: Error | undefined;
	function persist(): void {
		try {
			input.persistRunState(snapshot());
		} catch (cause) {
			persistenceFailure = new Error(
				'Workflow state could not be saved; continuation is unsafe.',
				{cause},
			);
			cancelled = true;
			input.abortCurrentTurn?.();
			throw persistenceFailure;
		}
	}

	/**
	 * The step the Journal's Turn Protocol block names after a Turn, reported
	 * only when it changed. Lives beside the Journal read in the interpreter —
	 * it is an observation of the Dossier, not a decision, so the reducer
	 * never sees it (ADR 0016 §1).
	 */
	const phaseTracker = createPhaseTracker();
	function observePhase(journalContent: string, turn: number): void {
		const observation = phaseTracker.observe(journalContent);
		if (observation.kind === 'new_step') {
			const {name, index, total} = observation.step;
			input.onPhaseChange?.({
				runId,
				turn,
				step: name,
				...(index !== undefined ? {stepIndex: index} : {}),
				...(total !== undefined ? {stepTotal: total} : {}),
			});
		} else if (observation.kind === 'malformed' && observation.warning) {
			input.onWarning?.(observation.warning);
		}
	}

	const result = (async (): Promise<WorkflowRunResult> => {
		// Yield to the microtask queue so the caller can capture the handle
		// before we start executing turns. Without this, startTurn would be
		// invoked synchronously inside createWorkflowRunner, before the
		// returned handle is assigned.
		await Promise.resolve();

		// Create journal skeleton if needed
		if (journalAbsPath && input.workflow?.loop?.enabled) {
			const content = substituteVariables(JOURNAL_SKELETON_TEMPLATE, {
				sessionId: input.sessionId,
				journalPath: journalPromptPath,
				input: input.prompt,
			});
			const write = input.createJournal ?? defaultCreateJournal;
			// Write-if-absent: the skeleton belongs to the Session's first Run.
			const journalExisted = fs.existsSync(journalAbsPath);
			write(journalAbsPath, content);
			// A wake continues the same Run, so it opens no new section.
			if (journalExisted && !input.resumeRunId) {
				openRunSection(journalAbsPath, {
					runId,
					goal: input.prompt,
					markers: {
						completionMarker: input.workflow.loop.completionMarker,
						needsHumanMarker: input.workflow.loop.needsHumanMarker,
						blockedMarker: input.workflow.loop.blockedMarker,
					},
				});
			}
		}

		const workflowState = createWorkflowRunState({
			projectDir: input.projectDir,
			sessionId: input.sessionId,
			workflow: input.workflow,
			harness: input.harness,
		});

		const loop = input.workflow?.loop;
		const cfg: StepConfig = {
			runId,
			contextKey: crypto.randomUUID(),
			workflowState,
			initialPrompt: input.prompt,
			loop,
			journalAbsPath,
			journalPromptPath,
		};

		const initial = createInitialRun(cfg, {
			initialContinuation: input.initialContinuation,
			waking: !!(input.resumeRunId && loop?.enabled),
			resumedMemory: input.resumedRunMemory,
			initialSteers: preStartSteers.splice(0),
			parkedInterruption: input.parkedInterruption,
			awaitingAttentionStopReason: input.resumedStopReason,
		});
		let phase: RunPhase = initial.phase;
		memory = initial.memory;
		persist();

		// From here on a Steer goes straight to the reducer: it only queues
		// (same phase, persisted), so applying it while a Turn is in flight is
		// safe and the queue is drained by whichever transition next starts a
		// Turn (#191).
		applySteer = steer => {
			if (isTerminalPhase(phase)) return false;
			const stepResult = step(phase, memory!, {type: 'steer', steer}, cfg);
			phase = stepResult.phase;
			memory = stepResult.memory;
			runSideEffects(stepResult.actions);
			return true;
		};

		// --- action execution -------------------------------------------------

		/** One interpreter seam for live accounting and cancellation. */
		async function executeOperation(
			turn: TurnInput,
		): Promise<
			TurnExecutionResult | Extract<RunEvent, {type: 'resource_exhausted'}>
		> {
			const baseline = {...cumulativeTokens};
			const startTokens = memory!.cumulativeTokens ?? 0;
			let operationTokens = 0;
			let finished = false;
			let openingChecked = false;
			let stopped: ResourceStop | null = null;
			const isStopped = () => stopped !== null;
			let resolveStop!: (
				event: Extract<RunEvent, {type: 'resource_exhausted'}>,
			) => void;
			const stopPromise = new Promise<
				Extract<RunEvent, {type: 'resource_exhausted'}>
			>(resolve => {
				resolveStop = resolve;
			});
			function finalStop(
				event: Extract<RunEvent, {type: 'resource_exhausted'}>,
			) {
				const total = memory!.cumulativeTokens ?? startTokens;
				return {
					...event,
					cumulativeTokens: total,
					stop: {
						...event.stop,
						...(event.stop.cause === 'tokens' ? {used: total} : {}),
					},
				};
			}
			function stop(reason: ResourceStop) {
				if (finished || stopped || cancelled) return;
				stopped = reason;
				const checkpoint = journalAbsPath
					? checkpointFromJournal(readJournal(journalAbsPath))
					: null;
				if (checkpoint) memory = {...memory!, checkpoint};
				input.abortCurrentTurn?.();
				resolveStop({
					type: 'resource_exhausted',
					stop: reason,
					cumulativeTokens: memory!.cumulativeTokens ?? startTokens,
				});
			}
			function observe(usage: TokenUsage, enforce = true) {
				if (finished) return;
				if (
					usage.total !== null &&
					Number.isFinite(usage.total) &&
					usage.total >= 0
				) {
					operationTokens = Math.max(operationTokens, usage.total);
					memory = {
						...memory!,
						cumulativeTokens: startTokens + operationTokens,
					};
					cumulativeTokens = {
						...mergeTokens(baseline, usage),
						total: memory.cumulativeTokens,
					};
					memory = {...memory, usage: cumulativeTokens};
					persist();
				}
				if (!enforce || stopped) return;
				const limit = admitContinuation({
					loop,
					iteration: memory!.iteration,
					tokens: memory!.cumulativeTokens,
				});
				if (limit) {
					stop(limit);
					return;
				}
				// The first actual request supplies opening context. On an initial
				// Turn the configured ceiling is only an estimate, labelled as such.
				if (
					!openingChecked &&
					turn.continuation.mode === 'fresh' &&
					usage.openingContextSize != null
				) {
					openingChecked = true;
					const previous =
						memory!.contextKey === cfg.contextKey
							? memory!.lastBoundedTurn
							: null;
					const required = memory!.checkpoint
						? 0
						: estimateTokenCount(
								journalAbsPath ? readJournal(journalAbsPath) : '',
							);
					const decision = admitContinuation({
						loop,
						iteration: memory!.iteration,
						tokens: memory!.cumulativeTokens,
						context: {
							opening: usage.openingContextSize,
							required,
							ceiling:
								previous?.lastContextTokens ??
								loop?.maxTurnTokenCount ??
								DEFAULT_MAX_TURN_TOKEN_COUNT,
							source: previous
								? 'conservative prior API occupancy'
								: 'configured ceiling estimate; actual compaction point unknown',
						},
					});
					if (decision) stop(decision);
				}
			}
			try {
				const operation = input.startTurn({
					...turn,
					onUsage: usage => observe(usage),
				});
				const result = await Promise.race([operation, stopPromise]);
				if ('type' in result) {
					// Stop admitting work immediately, but drain reported usage until
					// the harness settles. A broken adapter must not park forever.
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						const final = await Promise.race([
							operation.catch(() => null),
							new Promise<null>(resolve => {
								timer = setTimeout(() => resolve(null), 6000);
							}),
						]);
						if (final) observe(final.tokens, false);
					} finally {
						if (timer) clearTimeout(timer);
					}
					return finalStop(result);
				}
				observe(result.tokens, false);
				if (isStopped()) return finalStop(await stopPromise);

				return result;
			} finally {
				finished = true;
			}
		}

		async function performStartTurn(
			prompt: string,
			continuation: TurnContinuation,
			configOverride: HarnessProcessOverride | undefined,
		): Promise<RunEvent> {
			const turnResult = await executeOperation({
				prompt:
					loop?.enabled &&
					journalAbsPath &&
					(continuation.mode === 'fresh' || memory!.iteration === 1)
						? prompt +
							'\n\n' +
							restartInstructions(journalAbsPath, runId, loop.maxRestartTokens)
						: prompt,
				continuation,
				configOverride,
				iteration: memory!.iteration,
			});
			if ('type' in turnResult) return turnResult;

			// The Turn's measurement (ADR 0018 §6), on every event shape below.
			const measured = {
				openingContextTokens: turnResult.tokens.openingContextSize ?? null,
				lastContextTokens: turnResult.tokens.contextSize,
				toolCalls: input.currentTurnToolCalls?.() ?? null,
			};

			if (cancelled) {
				return {
					type: 'turn_finished',
					cancelled: true,
					hasError: false,
					exitCode: null,
					streamMessage: null,
					transportBroken: false,
					handoverRequestHandle: null,
					interruption: null,
					adapterSessionId: null,
					outcome: null,
					journalContent: '',
					...measured,
					shedIntegrity: null,
					cumulativeTokens: null,
				};
			}

			const runTotal = cumulativeTokens.total;

			// Handover (ADR 0014 §5): checked before interruption and failure
			// classification — the interruption is neither. The Journal is read
			// here as it is on the success path (ADR 0018 §5): the reducer hashes
			// it to judge the Handover productive or not, and the seed prompt can
			// carry the size and shed-integrity nudges.
			const handoverRequest = input.handover?.takeRequest() ?? null;
			if (handoverRequest) {
				const journalContent =
					loop?.enabled && journalAbsPath ? readJournal(journalAbsPath) : '';
				return {
					type: 'turn_finished',
					cancelled: false,
					hasError: false,
					exitCode: null,
					streamMessage: null,
					transportBroken: false,
					handoverRequestHandle: handoverRequest.handle,
					interruption: null,
					adapterSessionId: null,
					outcome: null,
					journalContent,
					checkpoint: journalAbsPath
						? checkpointFromJournal(journalContent)
						: null,
					...measured,
					shedIntegrity: observeShedIntegrity(journalContent),
					cumulativeTokens: runTotal,
				};
			}

			// An Interruption parked this Turn (#189). Checked before failure
			// classification: interrupting ends the harness process abnormally,
			// but the Run is suspended, not failed.
			const interruption = input.checkInterruption?.() ?? null;
			if (interruption) {
				return {
					type: 'turn_finished',
					cancelled: false,
					hasError: false,
					exitCode: null,
					streamMessage: null,
					transportBroken: false,
					handoverRequestHandle: null,
					interruption,
					adapterSessionId: null,
					outcome: null,
					journalContent: '',
					...measured,
					shedIntegrity: null,
					cumulativeTokens: runTotal,
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
					interruption: null,
					adapterSessionId,
					outcome: null,
					journalContent: '',
					...measured,
					shedIntegrity: null,
					cumulativeTokens: runTotal,
				};
			}

			const transport = turnResult.diagnostics?.transport;
			const transportBroken = !!(
				transport &&
				transport.streamToolUses > 0 &&
				transport.preToolUseEvents === 0
			);

			// Looped: one owner (`resolveTurnOutcome`) maps the Journal's end-state
			// to a final Run Status — only consulted on the success path, once the
			// hook transport is known-good, matching the original's lazy read.
			let journalContent = '';
			let outcome = null;
			if (!transportBroken && loop?.enabled && journalAbsPath) {
				journalContent = readJournal(journalAbsPath);
				outcome = resolveTurnOutcome({
					journalPath: journalAbsPath,
					loop,
					iteration: memory!.iteration,
				});
				observePhase(journalContent, memory!.iteration);
			}

			return {
				type: 'turn_finished',
				cancelled: false,
				hasError: false,
				exitCode: turnResult.exitCode,
				streamMessage: turnResult.streamMessage,
				transportBroken,
				handoverRequestHandle: null,
				interruption: null,
				adapterSessionId,
				outcome,
				journalContent,
				checkpoint: checkpointFromJournal(journalContent),
				...measured,
				shedIntegrity:
					journalContent === '' ? null : observeShedIntegrity(journalContent),
				cumulativeTokens: runTotal,
			};
		}

		/**
		 * The shed-integrity observation (ADR 0018 §7): the Dossier's unit
		 * records against the Journal's `## Units` table and headings. An
		 * observation, not a decision — the reducer turns it into a nudge.
		 */
		function observeShedIntegrity(journalContent: string) {
			if (!journalAbsPath || !loop?.enabled) return null;
			try {
				return checkShedIntegrity(
					journalContent,
					readUnitRecords(journalAbsPath),
				);
			} catch {
				return null;
			}
		}

		function checkpointFromJournal(content: string) {
			const contract = readRestartContract(
				content,
				loop?.maxRestartTokens,
				runId,
			);
			return contract && journalAbsPath
				? {path: journalAbsPath, contract}
				: null;
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
			return action.type === 'start_turn' || action.type === 'wait';
		}

		/**
		 * Execute every non-kickoff (side-effect) action in order and return
		 * the kickoff action, if any — a phase's actions always carry at most
		 * one.
		 */
		function runSideEffects(actions: RunAction[]): RunAction | null {
			let kickoff: RunAction | null = null;
			for (const action of actions) {
				if (isKickoffAction(action)) {
					kickoff = action;
					continue;
				}
				// eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- kickoff action types are filtered out above by isKickoffAction and handled by runActions
				switch (action.type) {
					case 'persist':
						persist();
						if (journalAbsPath && input.projectTasks) {
							try {
								const tasks = projectJournalTasks(journalAbsPath);
								if (tasks) input.projectTasks(tasks);
							} catch {
								// A parse miss or a throwing callback can never fail a Turn
								// or a Run (ADR 0015 §7: degrade to no projection).
							}
						}
						break;
					case 'warn':
						input.onWarning?.(action.message);
						break;
					case 'notify_iteration_complete':
						input.onIterationComplete?.(snapshot(), cumulativeTokens);
						break;
					case 'notify_handover_completed':
						input.onHandoverCompleted?.({
							...action.completion,
							tokens: cumulativeTokens,
						});
						break;
					case 'steers_delivered':
						if (journalAbsPath && loop?.enabled) {
							recordSteersInJournal(
								journalAbsPath,
								action.steers,
								action.iteration,
								{
									completionMarker: loop.completionMarker,
									needsHumanMarker: loop.needsHumanMarker,
									blockedMarker: loop.blockedMarker,
								},
							);
						}
						input.onSteerDelivered?.(
							action.steers.map(steer => ({
								...steer,
								iteration: action.iteration,
							})),
						);
						break;
					case 'record_interruption':
						// Ordered before the parked phase's `persist`, so the snapshot
						// that marks the Run awaiting_attention already carries it.
						interruption = action.interruption;
						if (
							journalAbsPath &&
							!(
								action.interruption.kind === 'cap_exhausted' &&
								action.interruption.resource
							)
						) {
							appendInterruptionNote(journalAbsPath, action.interruption);
						}
						break;
				}
			}
			return kickoff;
		}

		/**
		 * Execute every non-kickoff (side-effect) action in order, then the
		 * kickoff action (if any). Returns the event the kickoff action
		 * produced, or `null` for a terminal phase's actions (persist only, no
		 * kickoff).
		 */
		async function runActions(actions: RunAction[]): Promise<RunEvent | null> {
			const kickoff = runSideEffects(actions);
			if (!kickoff) return null;
			// eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- non-kickoff action types are handled in the switch above
			switch (kickoff.type) {
				case 'start_turn':
					return performStartTurn(
						kickoff.prompt,
						kickoff.continuation,
						kickoff.configOverride,
					);
				case 'wait':
					return performWait(kickoff.ms);
				default:
					return null;
			}
		}

		// --- interpreter loop ---------------------------------------------------

		// Wake-from-attention as a row of the transition table (ADR 0016 §7): a
		// resumed Run whose persisted phase is `awaiting_attention` has no
		// kickoff action of its own — the human's reply is what woke it — so
		// the interpreter synthesizes the `woken` event here and runs `step()`
		// once, immediately, using its actions (which include the `persist` that
		// checkpoints the wake before the Turn it kicks off starts) as the
		// bootstrap actions below, exactly like the kickoff actions
		// `createInitialRun` returns for every other initial phase.
		let bootstrapActions: RunAction[] = initial.actions;
		if (
			phase.kind === 'awaiting_attention' &&
			input.resumeRunId &&
			initial.actions.length === 0
		) {
			const wokenEvent: RunEvent = {
				type: 'woken',
				continuation: input.initialContinuation ?? {mode: 'fresh'},
				// Prefer a repaired current-run checkpoint when waking.
				checkpoint: journalAbsPath
					? checkpointFromJournal(readJournal(journalAbsPath))
					: null,
			};
			const stepResult = step(phase, memory, wokenEvent, cfg);
			phase = stepResult.phase;
			memory = stepResult.memory;
			bootstrapActions = stepResult.actions;
		}

		if (isTerminalPhase(phase)) {
			const terminal = terminalPhaseToStatus(phase);
			status = terminal.status;
			stopReason = terminal.stopReason;
		}
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
			...(interruption ? {interruption} : {}),
			tokens: cumulativeTokens,
		};
	})().catch((error: unknown): WorkflowRunResult => {
		if (!persistenceFailure) throw error;
		return {
			runId,
			status: 'failed',
			iterations: memory?.iteration ?? 0,
			stopReason: persistenceFailure.message,
			tokens: cumulativeTokens,
		};
	});

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
		steer(steer) {
			if (applySteer) return applySteer(steer);
			preStartSteers.push(steer);
			return true;
		},
	};
}
