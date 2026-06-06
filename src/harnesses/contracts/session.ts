import type {ChildProcess} from 'node:child_process';
import type {
	HarnessProcessConfig,
	HarnessProcessOptions,
	HarnessProcessOverride,
	HarnessProcessPreset,
	TurnContinuation,
	TurnExecutionResult,
} from '../../core/runtime/process';
import type {Runtime} from '../../core/runtime/types';
import type {WorkflowConfig, WorkflowPlan} from '../../core/workflows';
import type {TokenUsage} from '../../shared/types/headerMetrics';

export type SessionControllerTurnInput<
	ConfigOverride = HarnessProcessOverride,
> = {
	prompt: string;
	continuation?: TurnContinuation;
	configOverride?: ConfigOverride;
	onStderrLine?: (message: string) => void;
};

export type SessionControllerTurnResult = TurnExecutionResult;

export type SessionController<ConfigOverride = HarnessProcessOverride> = {
	startTurn: (
		input: SessionControllerTurnInput<ConfigOverride>,
	) => Promise<SessionControllerTurnResult>;
	interrupt: () => void;
	kill: () => Promise<void>;
};

/**
 * The per-Turn vendor session/thread on the harness seam.
 *
 * Each Turn runs in a **fresh Agent Session that is never resumed** (no
 * `--resume`) — continuity lives in the Tracker, not the vendor session. This is
 * a documented glossary alias over the structural {@link SessionController}; the
 * two are interchangeable. See ADR 0003
 * (docs/adr/0003-execution-unit-terminology.md).
 */
export type AgentSession<ConfigOverride = HarnessProcessOverride> =
	SessionController<ConfigOverride>;

export type UseSessionControllerResult<
	ConfigOverride = HarnessProcessOverride,
> = {
	startTurn: (
		prompt: string,
		continuation?: TurnContinuation,
		configOverride?: ConfigOverride,
	) => Promise<SessionControllerTurnResult>;
	isRunning: boolean;
	interrupt: () => void;
	kill: () => Promise<void>;
	usage: TokenUsage;
};

export type UseSessionControllerInput = {
	projectDir: string;
	instanceId: number;
	processConfig?: HarnessProcessConfig | HarnessProcessPreset;
	pluginMcpConfig?: string;
	verbose?: boolean;
	workflow?: WorkflowConfig;
	workflowPlan?: WorkflowPlan;
	ephemeral?: boolean;
	options?: HarnessProcessOptions;
	runtime?: Runtime | null;
};

export type CreateSessionControllerInput = UseSessionControllerInput & {
	spawnProcess?: ((options: unknown) => ChildProcess) | undefined;
};

export type UseSessionController = (
	input: UseSessionControllerInput,
) => UseSessionControllerResult;

export type CreateSessionController = (
	input: CreateSessionControllerInput,
) => SessionController;
