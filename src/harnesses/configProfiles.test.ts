import {describe, it, expect, vi, beforeEach} from 'vitest';

const resolveClaudeModelMock = vi.fn();

vi.mock('./claude/config/modelResolver', () => ({
	resolveClaudeModel: (input: {projectDir: string; configuredModel?: string}) =>
		resolveClaudeModelMock(input),
}));

const {resolveHarnessConfigProfile} = await import('./configProfiles');

describe('resolveHarnessConfigProfile', () => {
	beforeEach(() => {
		resolveClaudeModelMock.mockReset();
		resolveClaudeModelMock.mockReturnValue('claude-settings-model');
	});

	it('uses Claude model resolver for claude-code profile', () => {
		const profile = resolveHarnessConfigProfile('claude-code');
		const model = profile.resolveModelName({
			projectDir: '/project',
			configuredModel: undefined,
		});

		expect(model).toBe('claude-settings-model');
		expect(resolveClaudeModelMock).toHaveBeenCalledWith({
			projectDir: '/project',
			configuredModel: undefined,
		});
	});

	it('does not use Claude model resolver for non-claude harnesses', () => {
		const profile = resolveHarnessConfigProfile('openai-codex');

		expect(
			profile.resolveModelName({
				projectDir: '/project',
			}),
		).toBeNull();
		expect(
			profile.resolveModelName({
				projectDir: '/project',
				configuredModel: 'gpt-5-codex',
			}),
		).toBe('gpt-5-codex');
		expect(resolveClaudeModelMock).not.toHaveBeenCalled();
	});

	it('builds a harness isolation config with neutral inputs', () => {
		const profile = resolveHarnessConfigProfile('claude-code');
		expect(
			profile.buildIsolationConfig({
				projectDir: '/project',
				isolationPreset: 'minimal',
				additionalDirectories: ['/global-dir', '/project-dir'],
				pluginDirs: [],
				verbose: true,
				configuredModel: 'opus',
			}),
		).toEqual({
			preset: 'minimal',
			additionalDirectories: ['/global-dir', '/project-dir'],
			pluginDirs: undefined,
			debug: true,
			model: 'opus',
		});
	});

	it('threads a valid configured effort onto the isolation config', () => {
		const profile = resolveHarnessConfigProfile('claude-code');
		const config = profile.buildIsolationConfig({
			projectDir: '/project',
			isolationPreset: 'strict',
			additionalDirectories: [],
			pluginDirs: [],
			verbose: false,
			configuredEffort: 'high',
		});
		expect(config.effort).toBe('high');
	});

	it('omits an unsupported configured effort (no override)', () => {
		const profile = resolveHarnessConfigProfile('claude-code');
		const config = profile.buildIsolationConfig({
			projectDir: '/project',
			isolationPreset: 'strict',
			additionalDirectories: [],
			pluginDirs: [],
			verbose: false,
			configuredEffort: 'turbo',
		});
		expect(config.effort).toBeUndefined();
	});

	it('declares Claude plugin delivery as registration that builds the MCP config', () => {
		expect(resolveHarnessConfigProfile('claude-code').pluginDelivery).toEqual({
			mergeWorkflowPluginDirs: true,
			registrationBuildsMcpConfig: true,
			workflowPluginsVia: 'registration',
		});
	});

	it('declares Codex plugin delivery as a separately generated MCP config', () => {
		expect(resolveHarnessConfigProfile('openai-codex').pluginDelivery).toEqual({
			mergeWorkflowPluginDirs: false,
			registrationBuildsMcpConfig: false,
			workflowPluginsVia: 'generated-mcp',
		});
	});
});
