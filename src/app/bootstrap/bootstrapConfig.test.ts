import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const readGlobalConfigMock = vi.fn();
const readConfigMock = vi.fn();
const registerPluginsMock = vi.fn();
const buildPluginMcpConfigMock = vi.fn();
const resolveWorkflowMock = vi.fn();
const installWorkflowPluginsMock = vi.fn();
const resolveWorkflowPluginsMock = vi.fn();
const readClaudeSettingsModelMock = vi.fn();
const resolvePluginDirsMock = vi.fn();

vi.mock('../../infra/plugins/index', async () => {
	const actual = await vi.importActual<
		typeof import('../../infra/plugins/index')
	>('../../infra/plugins/index');
	return {
		...actual,
		readGlobalConfig: () => readGlobalConfigMock(),
		readConfig: (projectDir: string) => readConfigMock(projectDir),
		registerPlugins: (
			dirs: string[],
			mcpServerOptions?: Record<string, Record<string, string>>,
			includeMcpConfig?: boolean,
			personalMcpServers?: unknown[],
			personalSkills?: unknown[],
		) =>
			registerPluginsMock(
				dirs,
				mcpServerOptions,
				includeMcpConfig,
				personalMcpServers,
				personalSkills,
			),
		buildPluginMcpConfig: (
			dirs: string[],
			mcpServerOptions?: Record<string, Record<string, string>>,
		) => buildPluginMcpConfigMock(dirs, mcpServerOptions),
		resolvePluginDirs: (entries: string[]) => resolvePluginDirsMock(entries),
	};
});

vi.mock('../../core/workflows/index', () => ({
	resolveWorkflow: (name: string) => resolveWorkflowMock(name),
	installWorkflowPlugins: (workflow: unknown) =>
		installWorkflowPluginsMock(workflow),
	resolveWorkflowPlugins: (workflow: unknown) =>
		resolveWorkflowPluginsMock(workflow),
	compileWorkflowPlan: ({
		workflow,
		resolvedPlugins,
		localPlugins,
		codexPlugins,
		pluginMcpConfig,
	}: {
		workflow?: unknown;
		resolvedPlugins?: Array<{
			ref: string;
			pluginName: string;
			claudeArtifactDir: string;
			codexMarketplacePath: string;
		}>;
		localPlugins?: unknown[];
		codexPlugins?: unknown[];
		pluginMcpConfig?: string;
	}) => {
		if (!workflow) return undefined;
		const resolved = resolveWorkflowPluginsMock(workflow);
		const rp = resolvedPlugins ?? resolved?.resolvedPlugins ?? [];
		const lp =
			localPlugins ??
			rp.map((plugin: {ref: string; claudeArtifactDir: string}) => ({
				ref: plugin.ref,
				pluginDir: plugin.claudeArtifactDir,
			})) ??
			resolved?.localPlugins ??
			[];
		const cp =
			codexPlugins ??
			rp.map(
				(plugin: {
					ref: string;
					pluginName: string;
					codexMarketplacePath: string;
				}) => ({
					ref: plugin.ref,
					pluginName: plugin.pluginName,
					marketplacePath: plugin.codexMarketplacePath,
				}),
			) ??
			resolved?.codexPlugins ??
			[];
		return {
			workflow,
			resolvedPlugins: rp,
			localPlugins: lp,
			agentRoots: (rp as Array<{claudeArtifactDir: string}>).map(
				plugin => `${plugin.claudeArtifactDir}/agents`,
			),
			codexPlugins: cp,
			pluginMcpConfig,
		};
	},
}));

vi.mock('../../harnesses/claude/config/readSettingsModel', () => ({
	readClaudeSettingsModel: (projectDir: string) =>
		readClaudeSettingsModelMock(projectDir),
}));

const ensureHandoffSkillPluginMock = vi.fn();

vi.mock('../../core/workflows/builtins/handoffSkill', () => ({
	ensureHandoffSkillPlugin: () => ensureHandoffSkillPluginMock(),
}));

const {bootstrapRuntimeConfig} = await import('./bootstrapConfig');

const emptyConfig = {plugins: [], additionalDirectories: []};
const initialAnthropicModel = process.env['ANTHROPIC_MODEL'];

describe('bootstrapRuntimeConfig', () => {
	beforeEach(() => {
		delete process.env['ANTHROPIC_MODEL'];
		readGlobalConfigMock.mockReset();
		readConfigMock.mockReset();
		registerPluginsMock.mockReset();
		registerPluginsMock.mockReturnValue({
			mcpConfig: undefined,
			conflicts: {mcpServers: [], skills: []},
		});
		buildPluginMcpConfigMock.mockReset();
		buildPluginMcpConfigMock.mockReturnValue({
			mcpConfig: undefined,
			conflicts: [],
		});
		resolveWorkflowMock.mockReset();
		installWorkflowPluginsMock.mockReset();
		installWorkflowPluginsMock.mockReturnValue([]);
		resolveWorkflowPluginsMock.mockReset();
		resolveWorkflowPluginsMock.mockReturnValue({
			resolvedPlugins: [],
			localPlugins: [],
			codexPlugins: [],
		});
		readClaudeSettingsModelMock.mockReset();
		ensureHandoffSkillPluginMock.mockReset();
		ensureHandoffSkillPluginMock.mockReturnValue('/builtin-handoff-plugin');
		resolvePluginDirsMock.mockReset();
		// Default: identity resolution (fixtures are already absolute dirs).
		resolvePluginDirsMock.mockImplementation((entries: string[]) => ({
			dirs: entries,
			warnings: [],
		}));
	});

	afterEach(() => {
		if (initialAnthropicModel === undefined) {
			delete process.env['ANTHROPIC_MODEL'];
		} else {
			process.env['ANTHROPIC_MODEL'] = initialAnthropicModel;
		}
	});

	it('threads unresolved-plugin-ref warnings into warnings[]', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			plugins: ['bad-plugin@owner/repo'],
		});
		readConfigMock.mockReturnValue(emptyConfig);
		resolvePluginDirsMock.mockImplementation((entries: string[]) => ({
			dirs: entries.filter(entry => !entry.includes('@')),
			warnings: entries
				.filter(entry => entry.includes('@'))
				.map(entry => `Skipping plugin "${entry}": not found in marketplace`),
		}));

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			isolationPreset: 'strict',
		});

		expect(resolvePluginDirsMock).toHaveBeenCalledWith([
			'bad-plugin@owner/repo',
		]);
		expect(result.warnings).toContain(
			'Skipping plugin "bad-plugin@owner/repo": not found in marketplace',
		);
	});

	it('re-resolves configured workflow and installs workflow plugins when setup is not shown', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			plugins: ['/global-plugin'],
			additionalDirectories: ['/global-dir'],
			activeWorkflow: 'e2e-test-builder',
			workflowSelections: {
				'e2e-test-builder': {
					mcpServerOptions: {
						'agent-web-interface': {AWI_HEADLESS: 'true'},
					},
				},
			},
		});
		readConfigMock.mockReturnValue({
			...emptyConfig,
			plugins: ['/project-plugin'],
			additionalDirectories: ['/project-dir'],
			model: 'opus',
		});
		resolveWorkflowMock.mockReturnValue({
			name: 'e2e-test-builder',
			plugins: [],
			promptTemplate: '{input}',
			isolation: 'minimal',
		});
		resolveWorkflowPluginsMock.mockReturnValue({
			resolvedPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginName: 'plugin',
					marketplaceName: 'marketplace',
					pluginDir: '/workflow-plugin',
					claudeArtifactDir: '/workflow-plugin',
					codexPluginDir: '/workflow-plugin',
					codexMarketplacePath:
						'/workflow-marketplace/.agents/plugins/marketplace.json',
				},
			],
			localPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginDir: '/workflow-plugin',
				},
			],
			codexPlugins: [],
		});
		registerPluginsMock.mockReturnValue({
			mcpConfig: '/tmp/mcp.json',
			workflows: [],
		});
		readClaudeSettingsModelMock.mockReturnValue('claude-settings-model');

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			pluginFlags: ['/cli-plugin'],
			isolationPreset: 'strict',
			verbose: true,
		});

		expect(resolveWorkflowMock).toHaveBeenCalledWith('e2e-test-builder');
		expect(registerPluginsMock).toHaveBeenCalledWith(
			[
				'/workflow-plugin',
				'/builtin-handoff-plugin',
				'/global-plugin',
				'/project-plugin',
				'/cli-plugin',
			],
			{
				'agent-web-interface': {AWI_HEADLESS: 'true'},
			},
			true,
			[],
			[],
		);
		expect(result.workflow?.name).toBe('e2e-test-builder');
		expect(result.workflowRef).toBe('e2e-test-builder');
		expect(result.workflowPlan).toEqual({
			workflow: result.workflow,
			resolvedPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginName: 'plugin',
					marketplaceName: 'marketplace',
					pluginDir: '/workflow-plugin',
					claudeArtifactDir: '/workflow-plugin',
					codexPluginDir: '/workflow-plugin',
					codexMarketplacePath:
						'/workflow-marketplace/.agents/plugins/marketplace.json',
				},
			],
			localPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginDir: '/workflow-plugin',
				},
			],
			agentRoots: ['/workflow-plugin/agents'],
			codexPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginName: 'plugin',
					marketplacePath:
						'/workflow-marketplace/.agents/plugins/marketplace.json',
				},
			],
			pluginMcpConfig: '/tmp/mcp.json',
		});
		expect(result.harness).toBe('claude-code');
		expect(result.isolationConfig.preset).toBe('minimal');
		expect(result.isolationConfig.additionalDirectories).toEqual([
			'/global-dir',
			'/project-dir',
		]);
		expect(result.isolationConfig.model).toBe('opus');
		expect(result.modelName).toBe('opus');
		expect(result.warnings).toEqual([
			"Workflow 'e2e-test-builder' requires 'minimal' isolation (upgrading from 'strict')",
		]);
	});

	it('skips resolving configured workflow while setup is shown', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			plugins: ['/global-plugin'],
			activeWorkflow: 'e2e-test-builder',
		});
		readConfigMock.mockReturnValue(emptyConfig);
		resolveWorkflowMock.mockReturnValue({
			name: 'e2e-test-builder',
			plugins: [],
			promptTemplate: '{input}',
		});
		registerPluginsMock.mockReturnValue({
			mcpConfig: undefined,
		});
		readClaudeSettingsModelMock.mockReturnValue('claude-settings-model');

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: true,
			isolationPreset: 'strict',
		});

		expect(resolveWorkflowMock).toHaveBeenCalledWith('e2e-test-builder');
		expect(result.workflow?.name).toBe('e2e-test-builder');
		expect(result.workflowRef).toBe('e2e-test-builder');
		expect(result.workflowPlan).toEqual({
			workflow: result.workflow,
			resolvedPlugins: [],
			localPlugins: [],
			agentRoots: [],
			codexPlugins: [],
			pluginMcpConfig: undefined,
		});
		expect(result.harness).toBe('claude-code');
		expect(result.modelName).toBe('claude-settings-model');
	});

	it('does not fall back to plugin-discovered workflows', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			plugins: ['/global-plugin'],
		});
		readConfigMock.mockReturnValue(emptyConfig);
		resolveWorkflowMock.mockReturnValue({
			name: 'default',
			plugins: [],
			promptTemplate: '{input}',
		});
		registerPluginsMock.mockReturnValue({
			mcpConfig: undefined,
		});
		readClaudeSettingsModelMock.mockReturnValue('claude-settings-model');

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: true,
			isolationPreset: 'strict',
		});

		expect(resolveWorkflowMock).toHaveBeenCalledWith('default');
		expect(result.workflowRef).toBe('default');
		expect(result.warnings).toEqual([]);
	});

	it('defaults to "default" workflow when no active workflow is configured', () => {
		const defaultWorkflow = {
			name: 'default',
			plugins: [],
			promptTemplate: '{input}',
		};
		readGlobalConfigMock.mockReturnValue(emptyConfig);
		readConfigMock.mockReturnValue(emptyConfig);
		resolveWorkflowMock.mockReturnValue(defaultWorkflow);
		installWorkflowPluginsMock.mockReturnValue([]);

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			isolationPreset: 'strict',
		});

		expect(resolveWorkflowMock).toHaveBeenCalledWith('default');
		expect(result.workflowRef).toBe('default');
	});

	it('prefers project activeWorkflow over global activeWorkflow', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			plugins: ['/global-plugin'],
			activeWorkflow: 'global-workflow',
			workflowSelections: {
				'global-workflow': {
					mcpServerOptions: {globalServer: {GLOBAL: 'true'}},
				},
			},
		});
		readConfigMock.mockReturnValue({
			...emptyConfig,
			plugins: ['/project-plugin'],
			activeWorkflow: 'project-workflow',
			workflowSelections: {
				'project-workflow': {
					mcpServerOptions: {projectServer: {PROJECT: 'true'}},
				},
			},
		});
		resolveWorkflowMock.mockReturnValue({
			name: 'project-workflow',
			plugins: [],
			promptTemplate: '{input}',
		});
		installWorkflowPluginsMock.mockReturnValue([]);
		registerPluginsMock.mockReturnValue({
			mcpConfig: undefined,
		});
		readClaudeSettingsModelMock.mockReturnValue('claude-settings-model');

		bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			isolationPreset: 'strict',
		});

		expect(resolveWorkflowMock).toHaveBeenCalledWith('project-workflow');
		expect(registerPluginsMock).toHaveBeenCalledWith(
			['/builtin-handoff-plugin', '/global-plugin', '/project-plugin'],
			{projectServer: {PROJECT: 'true'}},
			true,
			[],
			[],
		);
	});

	it('delivers the first-party handoff skill plugin to Workflow Runs (claude only)', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			activeWorkflow: 'claude-workflow',
		});
		readConfigMock.mockReturnValue(emptyConfig);
		resolveWorkflowMock.mockReturnValue({
			name: 'claude-workflow',
			plugins: [],
			promptTemplate: '{input}',
		});
		readClaudeSettingsModelMock.mockReturnValue('claude-settings-model');

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			isolationPreset: 'strict',
		});

		expect(ensureHandoffSkillPluginMock).toHaveBeenCalled();
		expect(result.isolationConfig.pluginDirs).toContain(
			'/builtin-handoff-plugin',
		);
	});

	it('degrades to a warning when the handoff skill plugin cannot be materialized', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			activeWorkflow: 'claude-workflow',
		});
		readConfigMock.mockReturnValue(emptyConfig);
		resolveWorkflowMock.mockReturnValue({
			name: 'claude-workflow',
			plugins: [],
			promptTemplate: '{input}',
		});
		ensureHandoffSkillPluginMock.mockImplementation(() => {
			throw new Error('read-only home');
		});
		readClaudeSettingsModelMock.mockReturnValue('claude-settings-model');

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			isolationPreset: 'strict',
		});

		expect(result.warnings).toEqual([
			expect.stringContaining('handoff skill plugin'),
		]);
		expect(result.isolationConfig.pluginDirs ?? []).not.toContain(
			'/builtin-handoff-plugin',
		);
	});

	it('does not deliver the handoff skill plugin to codex sessions', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			harness: 'openai-codex',
			activeWorkflow: 'codex-workflow',
		});
		readConfigMock.mockReturnValue(emptyConfig);
		resolveWorkflowMock.mockReturnValue({
			name: 'codex-workflow',
			plugins: [],
			promptTemplate: '{input}',
		});

		bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			isolationPreset: 'strict',
		});

		expect(ensureHandoffSkillPluginMock).not.toHaveBeenCalled();
	});

	it('injects effective personal MCP servers even with no plugin dirs', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			mcpServers: {fs: {command: 'npx', args: ['-y', 'server']}},
		});
		readConfigMock.mockReturnValue({...emptyConfig});
		registerPluginsMock.mockReturnValue({mcpConfig: '/tmp/personal-mcp.json'});
		readClaudeSettingsModelMock.mockReturnValue('claude-settings-model');

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			isolationPreset: 'strict',
		});

		// gate fires despite zero plugin dirs; resolved personal servers forwarded
		expect(registerPluginsMock).toHaveBeenCalledWith(
			[],
			undefined,
			true,
			[
				{
					name: 'fs',
					command: 'npx',
					args: ['-y', 'server'],
					sourceLayer: 'global',
				},
			],
			[],
		);
		expect(result.pluginMcpConfig).toBe('/tmp/personal-mcp.json');
	});

	it('injects effective personal skills even with no plugin dirs', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			skills: [{name: 'greet', source: './greet', path: '/abs/greet'}],
		});
		readConfigMock.mockReturnValue({...emptyConfig});
		registerPluginsMock.mockReturnValue({mcpConfig: undefined});
		readClaudeSettingsModelMock.mockReturnValue('claude-settings-model');

		bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			isolationPreset: 'strict',
		});

		// gate fires despite zero plugin dirs + zero personal MCP; skills forwarded
		expect(registerPluginsMock).toHaveBeenCalledWith(
			[],
			undefined,
			true,
			[],
			[
				{
					name: 'greet',
					source: './greet',
					path: '/abs/greet',
					sourceLayer: 'global',
				},
			],
		);
	});

	it('exposes resolved personal MCP servers and skills on the output (AC1)', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			mcpServers: {fs: {command: 'npx', args: ['-y', 'server']}},
		});
		readConfigMock.mockReturnValue({
			...emptyConfig,
			skills: [{name: 'greet', source: './greet', path: '/abs/greet'}],
		});
		registerPluginsMock.mockReturnValue({mcpConfig: undefined});
		readClaudeSettingsModelMock.mockReturnValue('claude-settings-model');

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			isolationPreset: 'strict',
		});

		expect(result.personalMcpServers).toEqual([
			{
				name: 'fs',
				command: 'npx',
				args: ['-y', 'server'],
				sourceLayer: 'global',
			},
		]);
		expect(result.personalSkills).toEqual([
			{
				name: 'greet',
				source: './greet',
				path: '/abs/greet',
				sourceLayer: 'project',
			},
		]);
	});

	it('exposes empty personal capability lists for the codex harness (AC1)', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			mcpServers: {fs: {command: 'npx', args: ['-y', 'server']}},
			skills: [{name: 'greet', source: './greet', path: '/abs/greet'}],
		});
		readConfigMock.mockReturnValue({...emptyConfig});
		registerPluginsMock.mockReturnValue({mcpConfig: undefined});

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			isolationPreset: 'strict',
			harnessOverride: 'openai-codex',
		});

		expect(result.personalMcpServers).toEqual([]);
		expect(result.personalSkills).toEqual([]);
	});

	it('surfaces capability conflicts from registerPlugins on the output (AC3)', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			mcpServers: {shared: {command: 'personal-cmd'}},
			skills: [{name: 'dup', source: './dup', path: '/abs/dup'}],
		});
		readConfigMock.mockReturnValue(emptyConfig);
		registerPluginsMock.mockReturnValue({
			mcpConfig: undefined,
			conflicts: {
				mcpServers: [
					{name: 'shared', command: 'personal-cmd', sourceLayer: 'global'},
				],
				skills: [
					{
						name: 'dup',
						source: './dup',
						path: '/abs/dup',
						sourceLayer: 'global',
					},
				],
			},
		});

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			isolationPreset: 'strict',
		});

		expect(result.capabilityConflicts).toEqual({
			mcpServers: [
				{name: 'shared', command: 'personal-cmd', sourceLayer: 'global'},
			],
			skills: [
				{name: 'dup', source: './dup', path: '/abs/dup', sourceLayer: 'global'},
			],
		});
	});

	it('exposes empty capability conflicts when nothing is configured (AC3 none)', () => {
		readGlobalConfigMock.mockReturnValue(emptyConfig);
		readConfigMock.mockReturnValue(emptyConfig);

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			isolationPreset: 'strict',
		});

		expect(result.capabilityConflicts).toEqual({mcpServers: [], skills: []});
	});

	it('does not probe Claude-specific model sources for non-claude harnesses', () => {
		process.env['ANTHROPIC_MODEL'] = 'anthropic-env-model';
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			harness: 'openai-codex',
			activeWorkflow: 'non-claude-workflow',
		});
		readConfigMock.mockReturnValue(emptyConfig);
		resolveWorkflowMock.mockReturnValue({
			name: 'non-claude-workflow',
			plugins: [],
			promptTemplate: '{input}',
		});
		installWorkflowPluginsMock.mockReturnValue([]);
		registerPluginsMock.mockReturnValue({
			mcpConfig: undefined,
		});
		readClaudeSettingsModelMock.mockReturnValue('claude-settings-model');

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			isolationPreset: 'strict',
		});

		expect(result.harness).toBe('openai-codex');
		expect(result.modelName).toBeNull();
		expect(readClaudeSettingsModelMock).not.toHaveBeenCalled();
	});

	it('uses harnessOverride when provided, ignoring config', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			harness: 'openai-codex',
		});
		readConfigMock.mockReturnValue(emptyConfig);
		registerPluginsMock.mockReturnValue({
			mcpConfig: undefined,
		});

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			isolationPreset: 'strict',
			harnessOverride: 'claude-code',
		});

		expect(result.harness).toBe('claude-code');
	});

	it('keeps workflow plugin MCP merging for Claude harnesses', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			activeWorkflow: 'claude-workflow',
		});
		readConfigMock.mockReturnValue(emptyConfig);
		resolveWorkflowMock.mockReturnValue({
			name: 'claude-workflow',
			plugins: [],
			promptTemplate: '{input}',
		});
		installWorkflowPluginsMock.mockReturnValue(['/workflow-plugin']);
		resolveWorkflowPluginsMock.mockReturnValue({
			resolvedPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginName: 'plugin',
					marketplaceName: 'marketplace',
					pluginDir: '/workflow-plugin',
					claudeArtifactDir: '/workflow-plugin',
					codexPluginDir: '/workflow-plugin',
					codexMarketplacePath: '/marketplace/.agents/plugins/marketplace.json',
				},
			],
			localPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginDir: '/workflow-plugin',
				},
			],
			codexPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginName: 'plugin',
					marketplacePath: '/marketplace/.agents/plugins/marketplace.json',
				},
			],
		});
		registerPluginsMock.mockReturnValue({
			mcpConfig: '/tmp/workflow-mcp.json',
		});

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			isolationPreset: 'strict',
		});

		expect(buildPluginMcpConfigMock).not.toHaveBeenCalled();
		expect(result.pluginMcpConfig).toBe('/tmp/workflow-mcp.json');
		expect(result.workflowPlan).toEqual({
			workflow: result.workflow,
			resolvedPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginName: 'plugin',
					marketplaceName: 'marketplace',
					pluginDir: '/workflow-plugin',
					claudeArtifactDir: '/workflow-plugin',
					codexPluginDir: '/workflow-plugin',
					codexMarketplacePath: '/marketplace/.agents/plugins/marketplace.json',
				},
			],
			localPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginDir: '/workflow-plugin',
				},
			],
			agentRoots: ['/workflow-plugin/agents'],
			codexPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginName: 'plugin',
					marketplacePath: '/marketplace/.agents/plugins/marketplace.json',
				},
			],
			pluginMcpConfig: '/tmp/workflow-mcp.json',
		});
	});

	it('limits Codex MCP config to workflow plugin MCP only', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			harness: 'openai-codex',
			activeWorkflow: 'codex-workflow',
			plugins: ['/global-plugin'],
		});
		readConfigMock.mockReturnValue({
			...emptyConfig,
			plugins: ['/project-plugin'],
		});
		resolveWorkflowMock.mockReturnValue({
			name: 'codex-workflow',
			plugins: [],
			promptTemplate: '{input}',
		});
		resolveWorkflowPluginsMock.mockReturnValue({
			resolvedPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginName: 'plugin',
					marketplaceName: 'marketplace',
					pluginDir: '/workflow-plugin',
					claudeArtifactDir: '/workflow-plugin',
					codexPluginDir: '/workflow-plugin',
					codexMarketplacePath: '/marketplace/.agents/plugins/marketplace.json',
				},
			],
			localPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginDir: '/workflow-plugin',
				},
			],
			codexPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginName: 'plugin',
					marketplacePath: '/marketplace/.agents/plugins/marketplace.json',
				},
			],
		});
		registerPluginsMock.mockReturnValue({
			mcpConfig: '/tmp/all-plugin-mcp.json',
			conflicts: {mcpServers: [], skills: []},
		});
		buildPluginMcpConfigMock.mockReturnValue({
			mcpConfig: '/tmp/workflow-only-mcp.json',
			conflicts: [],
		});

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			pluginFlags: ['/cli-plugin'],
			isolationPreset: 'strict',
		});

		expect(registerPluginsMock).toHaveBeenCalledWith(
			['/global-plugin', '/project-plugin', '/cli-plugin'],
			undefined,
			false,
			[],
			[],
		);
		expect(buildPluginMcpConfigMock).toHaveBeenCalledWith(
			['/workflow-plugin'],
			undefined,
		);
		expect(result.pluginMcpConfig).toBeUndefined();
		expect(result.workflowPlan).toEqual({
			workflow: result.workflow,
			resolvedPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginName: 'plugin',
					marketplaceName: 'marketplace',
					pluginDir: '/workflow-plugin',
					claudeArtifactDir: '/workflow-plugin',
					codexPluginDir: '/workflow-plugin',
					codexMarketplacePath: '/marketplace/.agents/plugins/marketplace.json',
				},
			],
			localPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginDir: '/workflow-plugin',
				},
			],
			agentRoots: ['/workflow-plugin/agents'],
			codexPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginName: 'plugin',
					marketplacePath: '/marketplace/.agents/plugins/marketplace.json',
				},
			],
			pluginMcpConfig: '/tmp/workflow-only-mcp.json',
		});
	});
});
