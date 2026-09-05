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
import type {WorkflowRunSnapshot} from '../../infra/sessions/types';
import type {JournalMarkers, JournalTaskProjection} from './journalReader';
import {createWorkflowRunState, resolveJournalPath} from './sessionPlan';
import {resolveTurnOutcome} from './terminalOutcome';
import {
	readJournal,
	JOURNAL_SKELETON_MARKER,
	demoteTerminalMarkers,
	insertAboveTerminalMarker,
	projectJournalTasks,
} from './journalReader';
import {substituteVariables} from './templateVars';
import {handoffSimilarity} from './handoffSimilarity';
import {classifyTurnFailure} from '../runtime/failureTaxonomy';
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
	type RunPhase,
	type RunMemory,
	type RunEvent,
	type RunAction,
	type RunInterruption,
	type StepConfig,
} from './runMachine';

export type TurnInput = {
	prompt: string;
	continuation: TurnContinuation;
	configOverride?: HarnessProcessOverride;
	/**
	 * The Iteration this Turn belongs to (ADR 0018 §8). A Handover fork runs
	 * inside the interrupted Turn's iteration — it is not a Turn of its own —
	 * so the `run.handover` event the caller emits at kill time can name the
	 * iteration it interrupted.
	 */
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
	onIterationComplete?: (snapshot: WorkflowRunSnapshot) => void;
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
	/**
	 * Handover orchestration seam (ADR 0014 §5). The caller intercepts the
	 * harness's `compact.pre`, blocks the compaction, interrupts the Turn, and
	 * records the request; the Runner then forks the live conversation, has
	 * the `handoff` skill write a Handoff file, discards the fork, and starts
	 * a fresh Turn seeded with the Handoff file + Journal — the only
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
 * Prompt for the forked Agent Session: invoke the first-party `handoff` skill
 * (delivered to every Workflow Run via the plugin path) to distill the
 * conversation into a Handoff file at a path the Runner controls.
 */
function buildHandoffInvocationPrompt(handoffPath: string): string {
	return (
		`Invoke the handoff skill to write a Handoff file to ${handoffPath}. ` +
		`Do nothing else: no code changes, no journal updates — only the Handoff file.`
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

/** The newest Handoff file in the chain — the mandatory read — or null when there is none. */
function newestHandoffPath(dir: string): string | null {
	const seq = listHandoffSeqs(dir).at(-1);
	return seq === undefined ? null : handoffPathFor(dir, seq);
}

/**
 * Similarity of the Handoff just written to the one before it in the chain
 * (ADR 0018 §1, §5) — the chain retains two, so the predecessor is on disk.
 * `null` for the first Handover of a Run or when either read fails; a
 * read-only observation, never a write.
 */
function similarityToPreviousHandoff(
	dir: string,
	handoffAbsPath: string,
): number | null {
	const seq = Number(path.basename(handoffAbsPath, '.md'));
	const previousSeq = listHandoffSeqs(dir)
		.filter(s => s < seq)
		.at(-1);
	if (previousSeq === undefined) return null;
	try {
		return handoffSimilarity(
			fs.readFileSync(handoffPathFor(dir, previousSeq), 'utf-8'),
			fs.readFileSync(handoffAbsPath, 'utf-8'),
		);
	} catch {
		return null;
	}
}

/**
 * Allocate the path for the next Handoff file.
 *
 * A fresh sequence number per Handover is what lets `existsSync` prove that
 * *this* fork wrote the file — the job the pre-Handover `rmSync` used to do,
 * at the cost of destroying Handoff N before N+1 was written. Past the second
 * Handover that left the Journal as the sole carrier again, which is the
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
	let cumulativeTokens: TokenUsage = {...NULL_TOKENS};
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

	function persist(): void {
		try {
			input.persistRunState(snapshot());
		} catch {
			// Persistence failure is non-fatal for the runner
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

	function handoffDirFor(): string {
		return path.join(
			journalAbsPath
				? path.dirname(journalAbsPath)
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

		async function performStartTurn(
			prompt: string,
			continuation: TurnContinuation,
			configOverride: HarnessProcessOverride | undefined,
		): Promise<RunEvent> {
			const turnResult = await input.startTurn({
				prompt,
				continuation,
				configOverride,
				iteration: memory!.iteration,
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
					interruption: null,
					adapterSessionId: null,
					outcome: null,
					journalContent: '',
				};
			}

			cumulativeTokens = mergeTokens(cumulativeTokens, turnResult.tokens);

			// Handover (ADR 0014 §5): checked before interruption and failure
			// classification — the interruption is neither. The Journal is read
			// here as it is on the success path (ADR 0018 §5): the reducer hashes
			// it to judge the Handover productive or not, and the seed prompt can
			// carry the size nudge.
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
					interruption: null,
					adapterSessionId: null,
					outcome: null,
					journalContent:
						loop?.enabled && journalAbsPath ? readJournal(journalAbsPath) : '',
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
			// Classified only on failure (ADR 0016 §8) — a successful fork never
			// consults this, so it defaults to non-transient until proven otherwise.
			let transient = false;
			try {
				const forkResult = await input.startTurn({
					prompt: buildHandoffInvocationPrompt(handoffAbsPath),
					continuation: {mode: 'resume', handle},
					configOverride: {...configOverride, forkSession: true},
					// The fork is not a Turn: it runs inside the interrupted one.
					iteration: memory!.iteration,
				});
				cumulativeTokens = mergeTokens(cumulativeTokens, forkResult.tokens);
				forkOk =
					!forkResult.error &&
					(forkResult.exitCode === null || forkResult.exitCode === 0) &&
					fs.existsSync(handoffAbsPath);
				if (!forkOk) {
					transient =
						classifyTurnFailure({
							errorMessage: forkResult.error?.message,
							lastStderr: forkResult.stderrTail ?? forkResult.lastStderr,
							lastMessage: forkResult.streamMessage,
						}).kind === 'transient';
				}
			} catch (e) {
				forkOk = false;
				transient =
					classifyTurnFailure({
						errorMessage: e instanceof Error ? e.message : String(e),
					}).kind === 'transient';
			} finally {
				input.handover?.onForkStateChange?.(false);
			}

			// Fidelity metric (ADR 0015 §8) and progress metric (ADR 0018 §1) —
			// a read-only stat and a read-only compare, never a write, so this
			// never touches the one-owner property (ADR 0004).
			let handoffSizeBytes: number | null = null;
			let similarity: number | null = null;
			if (forkOk) {
				try {
					handoffSizeBytes = fs.statSync(handoffAbsPath).size;
				} catch {
					handoffSizeBytes = null;
				}
				similarity = similarityToPreviousHandoff(handoffDir, handoffAbsPath);
			}

			return {
				type: 'fork_finished',
				ok: forkOk,
				cancelled,
				handoffPath: handoffAbsPath,
				handoffSizeBytes,
				handoffSimilarity: similarity,
				transient,
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
						input.onIterationComplete?.(snapshot());
						break;
					case 'purge_handoffs':
						purgeHandoffs(handoffDirFor(), HANDOFF_RETAIN);
						break;
					case 'degrade_handover':
						input.handover?.onDegraded?.(action.handle);
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
						if (journalAbsPath) {
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
				case 'start_fork_turn':
					return performForkTurn(kickoff.handle, kickoff.configOverride);
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
		if (phase.kind === 'awaiting_attention') {
			const wokenEvent: RunEvent = {
				type: 'woken',
				continuation: input.initialContinuation ?? {mode: 'fresh'},
				// The newest Handoff on disk, for a park that followed a Handover
				// (ADR 0018 §9); the row decides whether the wake names it.
				handoffPath: newestHandoffPath(handoffDirFor()),
			};
			const stepResult = step(phase, memory, wokenEvent, cfg);
			phase = stepResult.phase;
			memory = stepResult.memory;
			bootstrapActions = stepResult.actions;
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
		steer(steer) {
			if (applySteer) return applySteer(steer);
			preStartSteers.push(steer);
			return true;
		},
	};
}
