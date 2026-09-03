import type {ChildProcess} from 'node:child_process';
import type {Writable} from 'node:stream';
import type {AthenaHarness} from '../../infra/plugins/config';
import type {WorkflowConfig, WorkflowPlan} from '../../core/workflows';
import type {HarnessProcessConfig} from '../../core/runtime/process';
import type {RuntimeDecision} from '../../core/runtime/types';
import type {TokenUsage} from '../../shared/types/headerMetrics';
import type {SessionStore} from '../../infra/sessions/store';
import type {RuntimeFactory} from '../runtime/createRuntime';
import type {SpawnClaudeOptions} from '../../harnesses/claude/process/types';
import type {DashboardFeedOrigin} from '../dashboard/dashboardFeedPublisher';
import type {FeedSink} from '../dashboard/pairedFeedPublisher';
import type {DashboardDecisionReader} from '../dashboard/dashboardDecisionInbox';
import type {FeedEvent} from '../../core/feed/types';
import type {CapabilitySourceLayer} from '../../infra/capabilities/effective';
import type {SteerQueue} from '../../core/workflows/steer';

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

export const RUN_EXIT_CODE = {
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

export type RunExitCode = (typeof RUN_EXIT_CODE)[keyof typeof RUN_EXIT_CODE];

export type ExecRunOptions = {
	prompt: string;
	projectDir: string;
	harness: AthenaHarness;
	instanceId?: number;
	athenaSessionId?: string;
	adapterResumeSessionId?: string;
	/**
	 * Workflow Run id to resume (ADR 0014 human-resume): the runner reuses it
	 * so the suspended Run returns to `running` instead of minting a new run.
	 */
	resumeRunId?: string;
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
	 * Permission grace window (#190): how long a permission request no rule
	 * answers is held for an attached hub before it is refused as "deferred"
	 * and the Run parks. Defaults to `DEFAULT_PERMISSION_GRACE_MS`. Only runs
	 * while a `dashboardDecisionInbox` is attached — with no hub, nothing can
	 * answer, so the request is deferred immediately.
	 */
	permissionGraceMs?: number;
	/**
	 * An answer given locally for the Interruption the resumed Run parked on
	 * (`drisp run --continue --answer=allow|deny`, #190). Replayed into the
	 * re-issued call without a prompt; ignored when the Run did not park on a
	 * deferred permission or the agent asks for something else.
	 */
	storedAnswer?: RuntimeDecision;
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
	/**
	 * Steers (#191) for this Run — from the hub's `steer` frame via the
	 * dashboard daemon, or a local `--steer`. Each is queued on the Runner and
	 * delivered at the head of the next Turn's prompt, never mid-Turn; the
	 * runner emits `run.steer.queued` on receipt and `run.steer` on delivery.
	 */
	steerQueue?: SteerQueue;
	beforeTerminalCompletion?: (input: {
		result: ExecRunResult;
		runId: string | null;
	}) => Promise<readonly FeedEvent[] | void>;
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
	// The Journal was the "Tracker" before #185; the persisted JSON value keeps
	// its historical spelling, like the `blocked` status.
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
	exitCode: RunExitCode;
	athenaSessionId: string | null;
	adapterSessionId: string | null;
	finalMessage: string | null;
	tokens: TokenUsage;
	durationMs: number;
	failure?: ExecRunFailure;
};
