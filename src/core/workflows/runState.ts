import type {RunStatus} from './types';
import type {Interruption} from '@drisp/protocol';

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
	/** Versioned identity of the instructions and capabilities used by this Run. */
	executionIdentityJson?: string;
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
	/** Versioned identity of the instructions and capabilities used by this Run. */
	executionIdentityJson?: string;
	/** The Interruption a parked Run carries (#190); see `WorkflowRunSnapshot`. */
	interruption?: Interruption;
};
