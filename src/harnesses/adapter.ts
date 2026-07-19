import type {Runtime} from '../core/runtime/types';
import type {WorkflowConfig} from '../core/workflows/types';
import type {AthenaHarness} from '../infra/plugins/config';
import type {HarnessConfigProfile} from './contracts/config';
import type {
	CreateSessionController,
	UseSessionController,
} from './contracts/session';
import type {HarnessVerificationResult} from './types';

export type HarnessRuntimeFactoryInput = {
	projectDir: string;
	instanceId: number;
	workflow?: WorkflowConfig;
};

export type HarnessCapabilities = {
	conversationModel: 'fresh_per_turn' | 'persistent_thread';
	killWaitsForTurnSettlement: boolean;
	supportsEphemeralSessions: boolean;
	supportsConfigurableIsolation: boolean;
};

/** One selectable model a harness exposes. Owned by the harness seam. */
export type HarnessModelOption = {
	value: string;
	label: string;
	description: string;
	isDefault?: boolean;
};

export type HarnessAdapter = {
	id: AthenaHarness;
	label: string;
	enabled: boolean;
	capabilities: HarnessCapabilities;
	verify?: () => HarnessVerificationResult;
	createRuntime: (input: HarnessRuntimeFactoryInput) => Runtime;
	createSessionController: CreateSessionController;
	useSessionController: UseSessionController;
	resolveConfigProfile: () => HarnessConfigProfile;
	/**
	 * The model catalog this harness offers. Claude serves a static list; Codex
	 * fetches from its live Runtime. The caller passes the active Runtime when it
	 * has one.
	 */
	listModels: (runtime?: Runtime | null) => Promise<HarnessModelOption[]>;
};
