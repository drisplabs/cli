import {
	registerPlugins,
	buildPluginMcpConfig,
	readConfig,
	readGlobalConfig,
	resolveActiveWorkflow,
	resolvePluginDirs,
	type AthenaConfig,
	type AthenaHarness,
	type CapabilityConflicts,
} from '../../infra/plugins/index';
import {resolveEffectiveCapabilities} from '../../infra/capabilities/effective';
import type {
	EffectiveMcpServer,
	EffectiveSkill,
} from '../../infra/capabilities/effective';
import {shouldResolveWorkflow} from '../../setup/shouldResolveWorkflow';
import type {
	HarnessProcessConfig,
	HarnessProcessPreset,
} from '../../core/runtime/process';
import {
	compileWorkflowPlan,
	resolveWorkflowPlugins,
	resolveWorkflow,
} from '../../core/workflows/index';
import type {
	ResolvedWorkflowPlugin,
	WorkflowConfig,
	WorkflowPlan,
} from '../../core/workflows';
import {DEFAULT_HARNESS} from '../runtime/createRuntime';
import {resolveHarnessConfigProfile} from '../../harnesses/configProfiles';

export type RuntimeBootstrapInput = {
	projectDir: string;
	showSetup: boolean;
	pluginFlags?: string[];
	isolationPreset: HarnessProcessPreset;
	verbose?: boolean;
	globalConfig?: AthenaConfig;
	projectConfig?: AthenaConfig;
	/** CLI --harness override (highest priority). */
	harnessOverride?: AthenaHarness;
	/** CLI --workflow override (highest priority for workflow selection). */
	workflowOverride?: string;
};

export type RuntimeBootstrapOutput = {
	globalConfig: AthenaConfig;
	projectConfig: AthenaConfig;
	harness: AthenaHarness;
	isolationConfig: HarnessProcessConfig;
	pluginMcpConfig?: string;
	workflowRef?: string;
	workflow?: WorkflowConfig;
	workflowPlan?: WorkflowPlan;
	modelName: string | null;
	/** Effective personal MCP servers injected into the session (claude-code only; codex → []). */
	personalMcpServers: EffectiveMcpServer[];
	/** Effective personal skills injected into the session (claude-code only; codex → []). */
	personalSkills: EffectiveSkill[];
	/**
	 * Personal capabilities shadowed by a same-named workflow plugin (plugin
	 * wins, personal skipped). Empty when there are no collisions or no
	 * personal capabilities (codex → empty).
	 */
	capabilityConflicts: CapabilityConflicts;
	warnings: string[];
};

function mergePluginDirs({
	workflowPluginDirs,
	globalPlugins,
	projectPlugins,
	pluginFlags,
}: {
	workflowPluginDirs: string[];
	globalPlugins: string[];
	projectPlugins: string[];
	pluginFlags: string[];
}): string[] {
	return [
		...new Set([
			...workflowPluginDirs,
			...globalPlugins,
			...projectPlugins,
			...pluginFlags,
		]),
	];
}

export function bootstrapRuntimeConfig({
	projectDir,
	showSetup,
	pluginFlags = [],
	isolationPreset: initialIsolationPreset,
	verbose = false,
	globalConfig: providedGlobalConfig,
	projectConfig: providedProjectConfig,
	harnessOverride,
	workflowOverride,
}: RuntimeBootstrapInput): RuntimeBootstrapOutput {
	const globalConfig = providedGlobalConfig ?? readGlobalConfig();
	const projectConfig = providedProjectConfig ?? readConfig(projectDir);
	const warnings: string[] = [];
	const harness =
		harnessOverride ??
		projectConfig.harness ??
		globalConfig.harness ??
		DEFAULT_HARNESS;
	const harnessConfigProfile = resolveHarnessConfigProfile(harness);
	const pluginDelivery = harnessConfigProfile.pluginDelivery;
	const workflowPluginsAsGeneratedMcp =
		pluginDelivery.workflowPluginsVia === 'generated-mcp';
	const activeWorkflowSelection = resolveActiveWorkflow({
		globalConfig,
		projectConfig,
		override: workflowOverride,
	});
	const configuredActiveWorkflow = activeWorkflowSelection.name;
	const activeWorkflowConfig = activeWorkflowSelection.selectionsLayer;

	let workflowPluginDirs: string[] = [];
	let workflowResolvedPlugins: ResolvedWorkflowPlugin[] = [];
	let resolvedWorkflow: WorkflowConfig | undefined;

	const workflowToResolve = shouldResolveWorkflow({
		showSetup,
		workflowName: configuredActiveWorkflow,
	})
		? configuredActiveWorkflow
		: undefined;

	if (workflowToResolve) {
		resolvedWorkflow = resolveWorkflow(workflowToResolve);
		const plugins = resolveWorkflowPlugins(resolvedWorkflow);
		workflowResolvedPlugins = plugins.resolvedPlugins;
		workflowPluginDirs = workflowResolvedPlugins.map(
			plugin => plugin.claudeArtifactDir,
		);
	}

	// Resolve config plugin refs (Plugin ref resolution) here, at the one place
	// that needs plugin dirs — so reading config elsewhere never spawns git.
	// Warnings for unresolved refs surface through the runtime warnings channel
	// instead of stderr.
	const globalPluginResolution = resolvePluginDirs(globalConfig.plugins);
	const projectPluginResolution = resolvePluginDirs(projectConfig.plugins);
	warnings.push(
		...globalPluginResolution.warnings,
		...projectPluginResolution.warnings,
	);

	const pluginDirs = mergePluginDirs({
		workflowPluginDirs: pluginDelivery.mergeWorkflowPluginDirs
			? workflowPluginDirs
			: [],
		globalPlugins: globalPluginResolution.dirs,
		projectPlugins: projectPluginResolution.dirs,
		pluginFlags,
	});
	// Personal MCP servers (Issue 2) and personal skills (Issue 3) are injected
	// for the claude-code path only. The openai-codex path keeps its separate
	// workflowPluginMcpConfig flow and its own command-registration semantics.
	const effectiveCapabilities =
		harness === 'openai-codex'
			? {mcpServers: [], skills: []}
			: resolveEffectiveCapabilities({globalConfig, projectConfig});
	const personalMcpServers = effectiveCapabilities.mcpServers;
	const personalSkills = effectiveCapabilities.skills;
	const pluginResult =
		pluginDirs.length > 0 ||
		personalMcpServers.length > 0 ||
		personalSkills.length > 0
			? registerPlugins(
					pluginDirs,
					workflowToResolve
						? activeWorkflowConfig.workflowSelections?.[workflowToResolve]
								?.mcpServerOptions
						: undefined,
					pluginDelivery.registrationBuildsMcpConfig,
					personalMcpServers,
					personalSkills,
				)
			: {mcpConfig: undefined, conflicts: {mcpServers: [], skills: []}};
	const workflowPluginMcpConfig = workflowPluginsAsGeneratedMcp
		? buildPluginMcpConfig(
				workflowPluginDirs,
				workflowToResolve
					? activeWorkflowConfig.workflowSelections?.[workflowToResolve]
							?.mcpServerOptions
					: undefined,
			).mcpConfig
		: undefined;
	const pluginMcpConfig = workflowPluginsAsGeneratedMcp
		? undefined
		: pluginResult.mcpConfig;

	const activeWorkflow: WorkflowConfig | undefined = resolvedWorkflow;

	const additionalDirectories = [
		...globalConfig.additionalDirectories,
		...projectConfig.additionalDirectories,
	];
	const workflowPlan = compileWorkflowPlan({
		workflow: activeWorkflow,
		resolvedPlugins:
			activeWorkflow && resolvedWorkflow?.name === activeWorkflow.name
				? workflowResolvedPlugins
				: undefined,
		pluginMcpConfig:
			workflowPluginsAsGeneratedMcp &&
			activeWorkflow &&
			resolvedWorkflow?.name === activeWorkflow.name
				? workflowPluginMcpConfig
				: pluginResult.mcpConfig,
	});

	const configModel =
		projectConfig.model || globalConfig.model || activeWorkflow?.model;
	const configEffort = activeWorkflow?.effort;

	let isolationPreset = initialIsolationPreset;
	if (activeWorkflow?.isolation) {
		const presetOrder = ['strict', 'minimal', 'permissive'];
		const workflowIdx = presetOrder.indexOf(activeWorkflow.isolation);
		const userIdx = presetOrder.indexOf(isolationPreset);
		if (workflowIdx > userIdx) {
			warnings.push(
				`Workflow '${activeWorkflow.name}' requires '${activeWorkflow.isolation}' isolation (upgrading from '${isolationPreset}')`,
			);
			isolationPreset = activeWorkflow.isolation as HarnessProcessPreset;
		}
	}

	const isolationConfig: HarnessProcessConfig =
		harnessConfigProfile.buildIsolationConfig({
			projectDir,
			isolationPreset,
			additionalDirectories,
			pluginDirs,
			verbose,
			configuredModel: configModel,
			configuredEffort: configEffort,
		});
	const modelName = harnessConfigProfile.resolveModelName({
		projectDir,
		configuredModel: isolationConfig.model,
	});

	return {
		globalConfig,
		projectConfig,
		harness,
		isolationConfig,
		pluginMcpConfig,
		workflowRef: activeWorkflow?.name,
		workflow: activeWorkflow,
		workflowPlan,
		modelName,
		personalMcpServers,
		personalSkills,
		capabilityConflicts: pluginResult.conflicts,
		warnings,
	};
}
