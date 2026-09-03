import type {FeedEvent} from '../../core/feed/types';
import type {TokenUsage} from '../../shared/types/headerMetrics';

export type AthenaSession = {
	id: string;
	projectDir: string;
	createdAt: number;
	updatedAt: number;
	label?: string;
	eventCount?: number;
	firstPrompt?: string;
	adapterSessionIds: string[];
};

/** Raw database row from the `session` table. */
export type SessionRow = {
	id: string;
	project_dir: string;
	created_at: number;
	updated_at: number;
	label: string | null;
	event_count: number | null;
};

export function rowToAthenaSession(
	row: SessionRow,
	adapterSessionIds: string[],
	firstPrompt?: string,
): AthenaSession {
	return {
		id: row.id,
		projectDir: row.project_dir,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		label: row.label ?? undefined,
		eventCount: row.event_count ?? 0,
		firstPrompt,
		adapterSessionIds,
	};
}

export type AdapterSessionRecord = {
	sessionId: string;
	startedAt: number;
	endedAt?: number;
	model?: string;
	source?: string;
	tokens?: TokenUsage;
};

export type StoredSession = {
	session: AthenaSession;
	feedEvents: FeedEvent[];
	adapterSessions: AdapterSessionRecord[];
};

import type {RunStatus} from '../../core/workflows/types';

export type WorkflowRunSnapshot = {
	runId: string;
	sessionId: string;
	workflowName?: string;
	iteration: number;
	maxIterations?: number;
	status: RunStatus;
	stopReason?: string;
	journalPath?: string;
	/**
	 * Vendor session id (Claude Code session / Codex thread) of the most recent
	 * Turn's Agent Session. Absent until the harness reports one; every resume-
	 * and fork-based transition depends on it (ADR 0014).
	 */
	adapterSessionId?: string;
	/**
	 * Opaque JSON snapshot of the run-loop reducer's `RunMemory` (nudge/retry
	 * streaks, last journal hash, in-flight stop prompt/continuation), so a
	 * resumed process can rehydrate the reducer instead of restarting its
	 * counters (ADR 0016). Serialized/parsed by `src/core/workflows/runMachine`
	 * — this layer stores and returns it as an opaque string, never inspects
	 * its shape.
	 */
	runMemoryJson?: string;
};

export type PersistedWorkflowRun = {
	id: string;
	sessionId: string;
	workflowName?: string;
	startedAt: number;
	endedAt?: number;
	iteration: number;
	maxIterations: number;
	status: RunStatus;
	stopReason?: string;
	journalPath?: string;
	/** Vendor session id of the Run's most recent Agent Session (ADR 0014). */
	adapterSessionId?: string;
	/** Opaque JSON snapshot of the run-loop reducer's `RunMemory` (ADR 0016). */
	runMemoryJson?: string;
};
