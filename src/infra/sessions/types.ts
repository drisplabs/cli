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
import {InterruptionSchema, type Interruption} from '@drisp/protocol';

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
	/**
	 * The structured Interruption a Run parked in `awaiting_attention` carries
	 * (#190: a permission request deferred after the grace window — its
	 * request id, the tool, and the input summary). Absent on a running or
	 * ended Run, and cleared when a parked Run is woken.
	 */
	interruption?: Interruption;
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
	/** The Interruption a parked Run carries (#190); see `WorkflowRunSnapshot`. */
	interruption?: Interruption;
};

/**
 * Parse a persisted `interruption_json` column. Tolerant: a row written by a
 * newer runner with an Interruption kind this build does not know, or a
 * corrupt value, reads as "no Interruption" rather than failing the whole
 * run read — the `stop_reason` sentence still describes the park.
 */
export function parsePersistedInterruption(
	json: unknown,
): Interruption | undefined {
	if (typeof json !== 'string' || json.length === 0) return undefined;
	try {
		const parsed = InterruptionSchema.safeParse(JSON.parse(json));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}
