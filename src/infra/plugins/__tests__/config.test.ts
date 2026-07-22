import {describe, it, expect, vi, beforeEach} from 'vitest';

const files: Record<string, string> = {};

vi.mock('node:fs', () => ({
	default: {
		existsSync: (p: string) => p in files,
		readFileSync: (p: string) => {
			if (!(p in files)) throw new Error(`ENOENT: ${p}`);
			return files[p];
		},
		mkdirSync: () => undefined,
		writeFileSync: (p: string, content: string) => {
			files[p] = content;
		},
	},
}));

vi.mock('node:os', () => ({
	default: {
		homedir: () => '/home/testuser',
	},
}));

// No `../marketplace` mock: readConfig no longer resolves marketplace refs
// (that is `resolvePluginDirs`' job), so parsing config never spawns git. The
// real, pure `isMarketplaceRef` regex decides which entries are left raw.

// Import after mocks are set up
const {readConfig, readGlobalConfig, writeGlobalConfig, writeProjectConfig} =
	await import('../config');

beforeEach(() => {
	for (const key of Object.keys(files)) {
		delete files[key];
	}
});

describe('readConfig', () => {
	it('returns empty plugins when config file does not exist', () => {
		expect(readConfig('/project')).toEqual({
			plugins: [],
			additionalDirectories: [],
		});
	});

	it('reads plugins from .athena/config.json', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: ['/absolute/plugin'],
		});

		expect(readConfig('/project')).toEqual({
			plugins: ['/absolute/plugin'],
			additionalDirectories: [],
		});
	});

	it('resolves relative paths against projectDir', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: ['relative/plugin'],
		});

		const result = readConfig('/project');

		expect(result.plugins).toEqual(['/project/relative/plugin']);
	});

	it('passes through absolute paths unchanged', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: ['/absolute/plugin', 'relative/one'],
		});

		const result = readConfig('/project');

		expect(result.plugins).toEqual([
			'/absolute/plugin',
			'/project/relative/one',
		]);
	});

	it('returns empty plugins when plugins key is missing', () => {
		files['/project/.athena/config.json'] = JSON.stringify({});

		expect(readConfig('/project')).toEqual({
			plugins: [],
			additionalDirectories: [],
		});
	});

	it('reads additionalDirectories and resolves relative paths', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: [],
			additionalDirectories: ['/absolute/dir', 'relative/dir'],
		});

		expect(readConfig('/project')).toEqual({
			plugins: [],
			additionalDirectories: ['/absolute/dir', '/project/relative/dir'],
		});
	});
});

describe('model field', () => {
	it('reads model from project config', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			model: 'claude-opus-4-6',
		});

		expect(readConfig('/project').model).toBe('claude-opus-4-6');
	});

	it('reads model from global config', () => {
		files['/home/testuser/.config/athena/config.json'] = JSON.stringify({
			model: 'sonnet',
		});

		expect(readGlobalConfig().model).toBe('sonnet');
	});

	it('returns undefined model when not set', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: [],
		});

		expect(readConfig('/project').model).toBeUndefined();
	});
});

describe('readGlobalConfig', () => {
	it('returns empty plugins when global config does not exist', () => {
		expect(readGlobalConfig()).toEqual({
			plugins: [],
			additionalDirectories: [],
		});
	});

	it('reads plugins from ~/.config/athena/config.json', () => {
		files['/home/testuser/.config/athena/config.json'] = JSON.stringify({
			plugins: ['/absolute/global-plugin'],
		});

		expect(readGlobalConfig()).toEqual({
			plugins: ['/absolute/global-plugin'],
			additionalDirectories: [],
		});
	});

	it('resolves relative paths against home directory', () => {
		files['/home/testuser/.config/athena/config.json'] = JSON.stringify({
			plugins: ['my-plugins/custom'],
		});

		const result = readGlobalConfig();

		expect(result.plugins).toEqual(['/home/testuser/my-plugins/custom']);
	});

	it('returns empty plugins when plugins key is missing', () => {
		files['/home/testuser/.config/athena/config.json'] = JSON.stringify({});

		expect(readGlobalConfig()).toEqual({
			plugins: [],
			additionalDirectories: [],
		});
	});

	it('reads telemetryDiagnostics from global config', () => {
		files['/home/testuser/.config/athena/config.json'] = JSON.stringify({
			telemetryDiagnostics: true,
		});

		expect(readGlobalConfig().telemetryDiagnostics).toBe(true);
	});
});

describe('marketplace refs (left raw for resolvePluginDirs)', () => {
	it('leaves a marketplace ref unresolved and never spawns git', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: ['my-plugin@owner/repo'],
		});

		expect(readConfig('/project').plugins).toEqual(['my-plugin@owner/repo']);
	});

	it('resolves local paths but leaves marketplace refs raw, preserving order', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: ['/absolute/plugin', 'my-plugin@owner/repo', 'relative/plugin'],
		});

		expect(readConfig('/project').plugins).toEqual([
			'/absolute/plugin',
			'my-plugin@owner/repo',
			'/project/relative/plugin',
		]);
	});
});

describe('activeWorkflow field', () => {
	it('reads activeWorkflow name from project config', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			activeWorkflow: 'e2e-testing',
		});

		expect(readConfig('/project').activeWorkflow).toBe('e2e-testing');
	});

	it('reads activeWorkflow name from global config', () => {
		files['/home/testuser/.config/athena/config.json'] = JSON.stringify({
			activeWorkflow: 'code-review',
		});

		expect(readGlobalConfig().activeWorkflow).toBe('code-review');
	});

	it('returns undefined activeWorkflow when not set', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: [],
		});

		expect(readConfig('/project').activeWorkflow).toBeUndefined();
	});
});

describe('workflowSelections field', () => {
	it('reads workflowSelections from config', () => {
		files['/home/testuser/.config/athena/config.json'] = JSON.stringify({
			workflowSelections: {
				'e2e-test-builder': {
					mcpServerOptions: {
						'agent-web-interface': {AWI_HEADLESS: 'true'},
					},
				},
			},
		});

		expect(readGlobalConfig().workflowSelections).toEqual({
			'e2e-test-builder': {
				mcpServerOptions: {
					'agent-web-interface': {AWI_HEADLESS: 'true'},
				},
			},
		});
	});
});

describe('setupComplete and harness fields', () => {
	it('parses setupComplete and harness fields', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: [],
			setupComplete: true,
			harness: 'claude-code',
		});
		const config = readConfig('/project');
		expect(config.setupComplete).toBe(true);
		expect(config.harness).toBe('claude-code');
	});

	it('returns undefined when not set', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: [],
		});
		const config = readConfig('/project');
		expect(config.setupComplete).toBeUndefined();
		expect(config.harness).toBeUndefined();
	});
});

describe('writeGlobalConfig', () => {
	it('writeGlobalConfig merges with existing config', () => {
		files['/home/testuser/.config/athena/config.json'] = JSON.stringify({
			plugins: ['existing'],
			theme: 'dark',
		});
		writeGlobalConfig({setupComplete: true, harness: 'claude-code'});
		const written = JSON.parse(
			files['/home/testuser/.config/athena/config.json']!,
		);
		expect(written.plugins).toEqual(['existing']);
		expect(written.setupComplete).toBe(true);
		expect(written.harness).toBe('claude-code');
	});

	it('writes telemetryDiagnostics preference to global config', () => {
		writeGlobalConfig({telemetryDiagnostics: false});

		const written = JSON.parse(
			files['/home/testuser/.config/athena/config.json']!,
		) as Record<string, unknown>;
		expect(written['telemetryDiagnostics']).toBe(false);
	});

	it('creates config when none exists', () => {
		writeGlobalConfig({harness: 'openai-codex'});
		const written = JSON.parse(
			files['/home/testuser/.config/athena/config.json']!,
		);
		expect(written.harness).toBe('openai-codex');
	});

	it('deep-merges workflowSelections by workflow key', () => {
		files['/home/testuser/.config/athena/config.json'] = JSON.stringify({
			workflowSelections: {
				workflowA: {
					mcpServerOptions: {
						serverA: {A: 'true'},
					},
				},
			},
		});

		writeGlobalConfig({
			workflowSelections: {
				workflowB: {
					mcpServerOptions: {
						serverB: {B: 'true'},
					},
				},
			},
		});

		const written = JSON.parse(
			files['/home/testuser/.config/athena/config.json']!,
		);
		expect(written.workflowSelections).toEqual({
			workflowA: {
				mcpServerOptions: {
					serverA: {A: 'true'},
				},
			},
			workflowB: {
				mcpServerOptions: {
					serverB: {B: 'true'},
				},
			},
		});
	});

	it('removes deprecated workflow and top-level mcpServerOptions keys', () => {
		files['/home/testuser/.config/athena/config.json'] = JSON.stringify({
			workflow: 'legacy-workflow',
			mcpServerOptions: {legacyServer: {LEGACY: 'true'}},
			activeWorkflow: 'e2e-test-builder',
		});

		writeGlobalConfig({theme: 'dark'});

		const written = JSON.parse(
			files['/home/testuser/.config/athena/config.json']!,
		);
		expect(written).not.toHaveProperty('workflow');
		expect(written).not.toHaveProperty('mcpServerOptions');
		expect(written.activeWorkflow).toBe('e2e-test-builder');
		expect(written.theme).toBe('dark');
	});

	it('throws when reading config with legacy codex harness', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: [],
			harness: 'codex',
		});
		expect(() => readConfig('/project')).toThrow(
			/field "harness" must be one of/,
		);
	});

	it('throws when reading config with deprecated workflowMarketplaceSource', () => {
		files['/home/testuser/.config/athena/config.json'] = JSON.stringify({
			workflowMarketplaceSource: 'owner/repo',
		});

		expect(() => readGlobalConfig()).toThrow(
			/deprecated "workflowMarketplaceSource"/,
		);
	});

	it('throws when workflowMarketplaceSources is not an array of strings', () => {
		files['/home/testuser/.config/athena/config.json'] = JSON.stringify({
			workflowMarketplaceSources: ['owner/repo', 123],
		});

		expect(() => readGlobalConfig()).toThrow(
			/workflowMarketplaceSources" must be an array of strings/,
		);
	});
});

describe('personal mcpServers field', () => {
	it('round-trips a personal MCP server through global config (AC1)', () => {
		writeGlobalConfig({
			mcpServers: {
				weather: {command: 'npx', args: ['-y', 'weather-mcp'], env: {KEY: 'v'}},
			},
		});

		expect(readGlobalConfig().mcpServers).toEqual({
			weather: {command: 'npx', args: ['-y', 'weather-mcp'], env: {KEY: 'v'}},
		});
	});

	it('round-trips a personal MCP server through project config (AC2)', () => {
		writeProjectConfig('/project', {
			mcpServers: {db: {command: 'db-mcp'}},
		});

		expect(readConfig('/project').mcpServers).toEqual({
			db: {command: 'db-mcp'},
		});
	});

	it('returns undefined mcpServers when not set', () => {
		files['/project/.athena/config.json'] = JSON.stringify({plugins: []});
		expect(readConfig('/project').mcpServers).toBeUndefined();
	});
});

describe('personal skills field', () => {
	it('round-trips personal skills through global config (AC3)', () => {
		writeGlobalConfig({
			skills: [{name: 'fmt', source: 'owner/repo', path: '/abs/fmt'}],
		});

		expect(readGlobalConfig().skills).toEqual([
			{name: 'fmt', source: 'owner/repo', path: '/abs/fmt'},
		]);
	});

	it('round-trips personal skills through project config (AC3)', () => {
		writeProjectConfig('/project', {
			skills: [
				{name: 'lint', source: './local', path: '/project/.skills/lint'},
			],
		});

		expect(readConfig('/project').skills).toEqual([
			{name: 'lint', source: './local', path: '/project/.skills/lint'},
		]);
	});

	it('does NOT relative-resolve skill path against baseDir (R1)', () => {
		// A relative-looking path is stored opaque; Issue 3 resolves at install.
		files['/project/.athena/config.json'] = JSON.stringify({
			skills: [{name: 's', source: 'src', path: 'relative/skill'}],
		});

		expect(readConfig('/project').skills).toEqual([
			{name: 's', source: 'src', path: 'relative/skill'},
		]);
	});

	it('returns undefined skills when not set', () => {
		files['/project/.athena/config.json'] = JSON.stringify({plugins: []});
		expect(readConfig('/project').skills).toBeUndefined();
	});
});

describe('personal capabilities do not clobber existing fields (AC5)', () => {
	it('writing mcpServers preserves workflowSelections and vice versa', () => {
		writeGlobalConfig({
			workflowSelections: {wf: {mcpServerOptions: {s: {A: 'true'}}}},
		});
		writeGlobalConfig({mcpServers: {db: {command: 'db-mcp'}}});

		const config = readGlobalConfig();
		expect(config.workflowSelections).toEqual({
			wf: {mcpServerOptions: {s: {A: 'true'}}},
		});
		expect(config.mcpServers).toEqual({db: {command: 'db-mcp'}});

		writeGlobalConfig({
			workflowSelections: {wf2: {mcpServerOptions: {s2: {B: 'true'}}}},
		});
		const after = readGlobalConfig();
		expect(after.mcpServers).toEqual({db: {command: 'db-mcp'}});
		expect(after.skills).toBeUndefined();
	});
});
