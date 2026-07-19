import type {AthenaHarness} from '../../infra/plugins/config';
import type {
	HarnessProcessConfig,
	HarnessProcessPreset,
} from '../../core/runtime/process';

export type BuildHarnessConfigInput = {
	projectDir: string;
	isolationPreset: HarnessProcessPreset;
	additionalDirectories: string[];
	pluginDirs: string[];
	verbose: boolean;
	configuredModel?: string;
	configuredEffort?: string;
};

export type ResolveHarnessModelInput = {
	projectDir: string;
	configuredModel?: string;
};

/**
 * How a harness receives plugins and their MCP config. Claude registers plugins
 * as isolation artifact dirs and threads one MCP config to the process; Codex
 * takes no artifact dirs and receives workflow plugins as a generated MCP config
 * carried on the plan. Pure data — the app orchestrates registration off it.
 */
export type PluginDeliveryPolicy = {
	/** Merge workflow plugin dirs into the registered plugin dirs. */
	mergeWorkflowPluginDirs: boolean;
	/** Whether plugin registration also builds the process MCP config (vs the harness receiving MCP separately). */
	registrationBuildsMcpConfig: boolean;
	/** Where workflow-plugin MCP comes from: plugin registration, or a config generated for the plan. */
	workflowPluginsVia: 'registration' | 'generated-mcp';
};

export type HarnessConfigProfile = {
	harness: AthenaHarness;
	buildIsolationConfig: (
		input: BuildHarnessConfigInput,
	) => HarnessProcessConfig;
	resolveModelName: (input: ResolveHarnessModelInput) => string | null;
	pluginDelivery: PluginDeliveryPolicy;
};
