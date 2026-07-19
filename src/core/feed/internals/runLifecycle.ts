// src/core/feed/internals/runLifecycle.ts

import type {RuntimeEvent} from '../../runtime/types';
import type {Session, Run} from '../entities';
import type {MapperBootstrap} from '../bootstrap';
import type {FeedEvent} from '../types';
import type {FeedEventBuilder} from './projection';

/**
 * Owns Session and Run identity, sequence allocation, per-run counters, and the
 * Run boundary: starting a new Run closes the current one when needed, resets
 * per-run FeedMapper state through its explicit collaborators, opens the next
 * Run, and emits the run.start / run.end lifecycle FeedEvents through one
 * interface (beginRun / closeRunIntoEvent). Callers request a boundary; they no
 * longer own the close → reset → open → emit choreography.
 *
 * Sequence semantics:
 *   - `seq` is a monotonic counter across the entire mapper lifetime; allocateSeq()
 *     is the only thing that increments it.
 *   - `runSeq` is the run number within the session, used to build run_id strings
 *     of the form `{session_id}:R{runSeq}`.
 *   - On bootstrap restore, both counters resume from the highest value observed
 *     in stored events.
 *
 * Counters are derived from emitted-event kinds in the orchestrator and pushed in
 * via incrementCounter. The lifecycle FeedEvents are built via the injected
 * makeEvent, and per-run state is cleared via the injected resetPerRunState — so
 * RunLifecycle owns *when* the boundary fires without knowing *how* each
 * collaborator resets itself.
 */
export type RunLifecycleCounter =
	| 'tool_uses'
	| 'tool_failures'
	| 'permission_requests'
	| 'blocks';

/**
 * Collaborators the Run boundary drives: makeEvent builds the run.start/run.end
 * FeedEvents, resetPerRunState clears per-run state across the FeedMapper seams
 * (tool/decision correlation, agent message stream, subagent tracker).
 */
export type RunBoundaryDeps = {
	makeEvent: FeedEventBuilder;
	resetPerRunState: () => void;
};

export type RunLifecycle = {
	allocateSeq(): number;
	getRunId(): string;
	getSession(): Session | null;
	getCurrentRun(): Run | null;
	setSession(session: Session): void;
	endSession(ts: number): void;
	clearSession(): void;
	incrementCounter(name: RunLifecycleCounter): void;
	closeRun(ts: number, status: 'completed' | 'failed' | 'aborted'): Run | null;
	openNewRun(
		ts: number,
		sessionId: string,
		triggerType: Run['trigger']['type'],
		promptPreview: string | undefined,
	): Run;
	/** Close the current Run (if any) into a run.end FeedEvent. */
	closeRunIntoEvent(
		runtimeEvent: RuntimeEvent,
		status: 'completed' | 'failed' | 'aborted',
	): FeedEvent | null;
	/**
	 * Ensure a Run is open for the incoming event, rolling over when triggered.
	 * For an implicit ('other') trigger this is a no-op while a Run is already
	 * open; otherwise it closes the current Run, resets per-run state, opens the
	 * next Run, and returns the run.end (if any) followed by the run.start event.
	 */
	beginRun(
		runtimeEvent: RuntimeEvent,
		triggerType?: Run['trigger']['type'],
		promptPreview?: string,
	): FeedEvent[];
	restoreFrom(bootstrap: MapperBootstrap): void;
};

export function createRunLifecycle(boundary: RunBoundaryDeps): RunLifecycle {
	const {makeEvent, resetPerRunState} = boundary;
	let currentSession: Session | null = null;
	let currentRun: Run | null = null;
	let seq = 0;
	let runSeq = 0;
	// The Prompt (Claude `prompt_id`) the currently-open Run belongs to. Undefined
	// during the pre-prompt bootstrap phase and on harnesses/versions that don't
	// emit prompt_id, in which case the heuristic trigger bounds Runs (ADR 0009).
	let currentPromptId: string | undefined;

	function getRunId(): string {
		const sessId = currentSession?.session_id ?? 'unknown';
		return `${sessId}:R${runSeq}`;
	}

	function allocateSeq(): number {
		return ++seq;
	}

	function getCurrentRun(): Run | null {
		return currentRun;
	}

	function closeRun(
		ts: number,
		status: 'completed' | 'failed' | 'aborted',
	): Run | null {
		if (!currentRun) return null;
		currentRun.status = status;
		currentRun.ended_at = ts;
		const closed = currentRun;
		currentRun = null;
		return closed;
	}

	function openNewRun(
		ts: number,
		sessionId: string,
		triggerType: Run['trigger']['type'],
		promptPreview: string | undefined,
	): Run {
		runSeq++;
		currentRun = {
			run_id: getRunId(),
			session_id: sessionId,
			started_at: ts,
			trigger: {type: triggerType, prompt_preview: promptPreview},
			status: 'running',
			actors: {root_agent_id: 'agent:root', subagent_ids: []},
			counters: {
				tool_uses: 0,
				tool_failures: 0,
				permission_requests: 0,
				blocks: 0,
			},
		};
		return currentRun;
	}

	function closeRunIntoEvent(
		runtimeEvent: RuntimeEvent,
		status: 'completed' | 'failed' | 'aborted',
	): FeedEvent | null {
		const closed = closeRun(runtimeEvent.timestamp, status);
		if (!closed) return null;
		return makeEvent(
			'run.end',
			'info',
			'system',
			{status, counters: {...closed.counters}},
			runtimeEvent,
		);
	}

	function beginRun(
		runtimeEvent: RuntimeEvent,
		triggerType: Run['trigger']['type'] = 'other',
		promptPreview?: string,
	): FeedEvent[] {
		const promptId = runtimeEvent.promptId;

		// `resume`/`clear`/`compact` are explicit context-lifecycle events, not
		// implicit ones: the harness rebuilt the context underneath the Run, so the
		// Run must roll over (and per-run state reset) even when the Prompt is
		// unchanged — auto-compact fires mid-Prompt and would otherwise leak state
		// across the compaction.
		const isExplicitContextTrigger =
			triggerType === 'resume' ||
			triggerType === 'clear' ||
			triggerType === 'compact';

		if (promptId !== undefined && !isExplicitContextTrigger) {
			// Prompt-driven boundary (ADR 0009): the Run rolls over when the Prompt
			// _changes_, not when a specific trigger event is observed. Any event
			// carrying a new prompt_id can establish the boundary, and any other
			// event re-stating the current Prompt is a no-op.
			if (currentRun && promptId === currentPromptId) return [];
		} else if (
			promptId === undefined &&
			currentRun &&
			triggerType === 'other'
		) {
			// Heuristic fallback: bootstrap phase / harnesses without prompt_id.
			// Implicit ('other') triggers never roll over an open Run.
			return [];
		}

		const results: FeedEvent[] = [];

		const closeEvt = closeRunIntoEvent(runtimeEvent, 'completed');
		if (closeEvt) results.push(closeEvt);

		// Reset all per-run state across the seams before opening the next Run.
		resetPerRunState();

		openNewRun(
			runtimeEvent.timestamp,
			runtimeEvent.sessionId,
			triggerType,
			promptPreview,
		);
		// Bind the new Run to the Prompt that opened it (undefined on the heuristic
		// path); a later event re-stating this Prompt is then a no-op.
		currentPromptId = promptId;

		results.push(
			makeEvent(
				'run.start',
				'info',
				'system',
				{trigger: {type: triggerType, prompt_preview: promptPreview}},
				runtimeEvent,
			),
		);

		return results;
	}

	return {
		allocateSeq,
		getRunId,
		getSession() {
			return currentSession;
		},
		getCurrentRun,
		setSession(session) {
			currentSession = session;
		},
		endSession(ts) {
			if (currentSession) currentSession.ended_at = ts;
		},
		clearSession() {
			currentSession = null;
		},
		incrementCounter(name) {
			if (currentRun) currentRun.counters[name]++;
		},
		closeRun,
		openNewRun,
		closeRunIntoEvent,
		beginRun,
		restoreFrom(bootstrap) {
			for (const e of bootstrap.feedEvents) {
				if (e.seq > seq) seq = e.seq;
				const m = e.run_id.match(/:R(\d+)$/);
				if (m) {
					const n = parseInt(m[1]!, 10);
					if (n > runSeq) runSeq = n;
				}
			}

			const lastAdapterId = bootstrap.adapterSessionIds.at(-1);
			if (lastAdapterId) {
				currentSession = {
					session_id: lastAdapterId,
					started_at: bootstrap.createdAt,
					source: 'resume',
				};
			}

			let lastRunStart: FeedEvent | undefined;
			let lastRunEnd: FeedEvent | undefined;
			for (const e of bootstrap.feedEvents) {
				if (e.kind === 'run.start') lastRunStart = e;
				if (e.kind === 'run.end') lastRunEnd = e;
			}
			if (lastRunStart && (!lastRunEnd || lastRunEnd.seq < lastRunStart.seq)) {
				const triggerData = lastRunStart.data as {
					trigger: {type: string; prompt_preview?: string};
				};
				currentRun = {
					run_id: lastRunStart.run_id,
					session_id: lastRunStart.session_id,
					started_at: lastRunStart.ts,
					trigger: triggerData.trigger as Run['trigger'],
					status: 'running',
					actors: {root_agent_id: 'agent:root', subagent_ids: []},
					counters: {
						tool_uses: 0,
						tool_failures: 0,
						permission_requests: 0,
						blocks: 0,
					},
				};
				for (const e of bootstrap.feedEvents) {
					if (e.run_id !== currentRun.run_id) continue;
					if (e.kind === 'tool.pre') currentRun.counters.tool_uses++;
					if (e.kind === 'tool.failure') currentRun.counters.tool_failures++;
					if (e.kind === 'permission.request')
						currentRun.counters.permission_requests++;
					// Resume the Prompt the restored Run belongs to (feedEvents are
					// seq-ordered) so a continuation event re-stating it does not
					// spuriously roll the Run over.
					if (e.prompt_id !== undefined) currentPromptId = e.prompt_id;
				}
			}
		},
	};
}
