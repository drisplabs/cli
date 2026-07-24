import type {ChildProcess} from 'node:child_process';
import type {Writable} from 'node:stream';
import type {AthenaHarness} from '../../infra/plugins/config';
import type {WorkflowConfig, WorkflowPlan} from '../../core/workflows';
import type {HarnessProcessConfig} from '../../core/runtime/process';
import type {TokenUsage} from '../../shared/types/headerMetrics';
import type {SessionStore} from '../../infra/sessions/store';
import type {RuntimeFactory} from '../runtime/createRuntime';
import type {SpawnClaudeOptions} from '../../harnesses/claude/process/types';
import type {SessionBridge} from '../channels/sessionBridge';
import type {StartSessionBridgeOptions} from '../channels/sessionBridgeLifecycle';
import type {DashboardFeedOrigin} from '../dashboard/dashboardFeedPublisher';
import type {FeedSink} from '../dashboard/pairedFeedPublisher';
import type {DashboardDecisionReader} from '../dashboard/dashboardDecisionInbox';
import type {FeedEvent} from '../../core/feed/types';
import type {CapabilitySourceLayer} from '../../infra/capabilities/effective';

/**
 * A reporting-only summary of an active personal capability: name + source
 * layer ONLY. Command/args/env (MCP) and path (skills) are stripped at the
 * call site so secret-bearing fields never reach the startup notice or the
 * `exec.started` event.
 */
export type PersonalCapabilitySummaryEntry = {
	name: string;
	sourceLayer: CapabilitySourceLayer;
};

export type PersonalCapabilitiesSummary = {
	mcpServers: ReadonlyArray<PersonalCapabilitySummaryEntry>;
	skills: ReadonlyArray<PersonalCapabilitySummaryEntry>;
};

export const EXEC_EXIT_CODE = {
	SUCCESS: 0,
	USAGE: 2,
	BOOTSTRAP: 3,
	RUNTIME: 4,
	// 5 was POLICY (removed when exec dropped --on-permission/--on-question);
	// the slot is intentionally left as a numeric gap to keep external scripts
	// that special-case 5 from getting a new meaning.
	TIMEOUT: 6,
	OUTPUT: 7,
	WORKFLOW_BLOCKED: 8,
	WORKFLOW_EXHAUSTED: 9,
} as const;

export type ExecExitCode = (typeof EXEC_EXIT_CODE)[keyof typeof EXEC_EXIT_CODE];

export type ExecRunOptions = {
	prompt: string;
	projectDir: string;
	harness: AthenaHarness;
	instanceId?: number;
	athenaSessionId?: string;
	adapterResumeSessionId?: string;
	isolationConfig: HarnessProcessConfig;
	pluginMcpConfig?: string;
	workflow?: WorkflowConfig;
	workflowPlan?: WorkflowPlan;
	verbose?: boolean;
	json?: boolean;
	outputLastMessagePath?: string;
	ephemeral?: boolean;
	timeoutMs?: number;
	signal?: AbortSignal;
	/**
	 * Channel ids passed via `--channel`. When non-empty, exec connects to the
	 * gateway daemon and relays permission/question requests through it. When
	 * empty, exec runs without a bridge — permission requests block until
	 * `timeoutMs` (or forever if no timeout).
	 */
	channels?: readonly string[];
	/**
	 * Reporting-only summary of the effective personal capabilities active for
	 * this session (name + source layer only). Surfaced in the `exec.started`
	 * event and a human-facing startup notice; does NOT affect what loads.
	 */
	personalCapabilities?: PersonalCapabilitiesSummary;
	/**
	 * Reporting-only summary of personal capabilities shadowed by a same-named
	 * workflow plugin (plugin wins, personal skipped). Name + source layer only.
	 * Surfaced in the `exec.started` event and a human-facing conflict warning;
	 * does NOT affect what loads.
	 */
	capabilityConflicts?: PersonalCapabilitiesSummary;
	stdout?: Pick<Writable, 'write'>;
	stderr?: Pick<Writable, 'write'>;
	runtimeFactory?: RuntimeFactory;
	spawnProcess?: (options: SpawnClaudeOptions) => ChildProcess;
	sessionStoreFactory?: (opts: {
		sessionId: string;
		projectDir: string;
		dbPath: string;
		label?: string;
	}) => SessionStore;
	dashboardFeedPublisher?: FeedSink;
	dashboardOrigin?: DashboardFeedOrigin;
	dashboardDecisionInbox?: DashboardDecisionReader;
	dashboardDecisionPollIntervalMs?: number;
	beforeTerminalCompletion?: (input: {
		result: ExecRunResult;
		runId: string | null;
	}) => Promise<readonly FeedEvent[] | void>;
	/** Test seam: override the gateway connect step. */
	bridgeFactory?: (
		opts: StartSessionBridgeOptions,
	) => Promise<SessionBridge | null>;
	now?: () => number;
};

/**
 * Historical workflow-failure states. Since ADR 0014 a declared block and the
 * iteration ceiling suspend the Run (`awaiting_attention`) instead of failing
 * it, so exec no longer constructs `kind: 'workflow'` failures — the shape and
 * its exit codes (8/9) are kept so external consumers of the JSON contract
 * retain their meaning.
 */
export type ExecWorkflowFailureState =
	| 'blocked'
	| 'exhausted'
	| 'missing_tracker';

export type ExecRunFailure =
	| {
			kind: 'process' | 'timeout' | 'output';
			message: string;
	  }
	| {
			kind: 'workflow';
			state: ExecWorkflowFailureState;
			message: string;
	  };

export type ExecRunResult = {
	success: boolean;
	exitCode: ExecExitCode;
	athenaSessionId: string | null;
	adapterSessionId: string | null;
	finalMessage: string | null;
	tokens: TokenUsage;
	durationMs: number;
	failure?: ExecRunFailure;
};
