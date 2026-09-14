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
	onUsage?: (usage: TokenUsage) => void;
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
 * An Agent Session may span resumed Turns. A fresh restart replaces the
 * conversation; the Journal carries durable continuity across replacements.
 * This alias uses the same structural interface as SessionController.
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
		onUsage?: (usage: TokenUsage) => void,
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
