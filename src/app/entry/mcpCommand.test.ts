import {describe, expect, it, vi} from 'vitest';
import {
	runMcpCommand,
	type McpCommandDeps,
	type McpCommandInput,
} from './mcpCommand';

const TEST_PROJECT_DIR = '/test/project';

const emptyConfig = {
	plugins: [],
	additionalDirectories: [],
};

function runCmd(
	input: Omit<McpCommandInput, 'projectDir'>,
	deps: McpCommandDeps = {},
): number {
	return runMcpCommand(
		{
			serverCommandTokens: [],
			...input,
			projectDir: TEST_PROJECT_DIR,
		},
		deps,
	);
}

describe('runMcpCommand', () => {
	describe('add', () => {
		it('persists a personal MCP server to the global config by default', () => {
			const writeGlobalConfig = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue(emptyConfig);
			const logOut = vi.fn();

			const code = runCmd(
				{
					subcommand: 'add',
					subcommandArgs: ['fs'],
					serverCommandTokens: ['npx', '-y', 'server', '/tmp'],
				},
				{readGlobalConfig, writeGlobalConfig, logOut},
			);

			expect(code).toBe(0);
			expect(writeGlobalConfig).toHaveBeenCalledWith({
				mcpServers: {
					fs: {command: 'npx', args: ['-y', 'server', '/tmp']},
				},
			});
		});

		it('persists to the project config with --project', () => {
			const writeProjectConfig = vi.fn();
			const readProjectConfig = vi.fn().mockReturnValue(emptyConfig);

			const code = runCmd(
				{
					subcommand: 'add',
					subcommandArgs: ['fs', '--project'],
					serverCommandTokens: ['my-server'],
				},
				{readProjectConfig, writeProjectConfig},
			);

			expect(code).toBe(0);
			expect(writeProjectConfig).toHaveBeenCalledWith(TEST_PROJECT_DIR, {
				mcpServers: {fs: {command: 'my-server'}},
			});
		});

		it('captures repeated --env flags as the server env', () => {
			const writeGlobalConfig = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue(emptyConfig);

			const code = runCmd(
				{
					subcommand: 'add',
					subcommandArgs: ['gh', '--env', 'API_KEY=x', '--env', 'FOO=bar'],
					serverCommandTokens: ['gh-mcp'],
				},
				{readGlobalConfig, writeGlobalConfig},
			);

			expect(code).toBe(0);
			expect(writeGlobalConfig).toHaveBeenCalledWith({
				mcpServers: {
					gh: {command: 'gh-mcp', env: {API_KEY: 'x', FOO: 'bar'}},
				},
			});
		});

		it('preserves existing servers and prints a notice when overwriting', () => {
			const writeGlobalConfig = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue({
				...emptyConfig,
				mcpServers: {
					keep: {command: 'keep-cmd'},
					fs: {command: 'old'},
				},
			});
			const logOut = vi.fn();

			const code = runCmd(
				{
					subcommand: 'add',
					subcommandArgs: ['fs'],
					serverCommandTokens: ['new-cmd'],
				},
				{readGlobalConfig, writeGlobalConfig, logOut},
			);

			expect(code).toBe(0);
			expect(writeGlobalConfig).toHaveBeenCalledWith({
				mcpServers: {
					keep: {command: 'keep-cmd'},
					fs: {command: 'new-cmd'},
				},
			});
			expect(
				logOut.mock.calls.some(([msg]) => /overwrote|overwrit/i.test(msg)),
			).toBe(true);
		});

		it('errors when no server command is given', () => {
			const writeGlobalConfig = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue(emptyConfig);
			const logError = vi.fn();

			const code = runCmd(
				{
					subcommand: 'add',
					subcommandArgs: ['fs'],
					serverCommandTokens: [],
				},
				{readGlobalConfig, writeGlobalConfig, logError},
			);

			expect(code).toBe(1);
			expect(writeGlobalConfig).not.toHaveBeenCalled();
			expect(logError).toHaveBeenCalled();
		});

		it('rejects --project and --global together', () => {
			const writeGlobalConfig = vi.fn();
			const logError = vi.fn();

			const code = runCmd(
				{
					subcommand: 'add',
					subcommandArgs: ['fs', '--project', '--global'],
					serverCommandTokens: ['x'],
				},
				{writeGlobalConfig, logError},
			);

			expect(code).toBe(1);
			expect(writeGlobalConfig).not.toHaveBeenCalled();
			expect(logError).toHaveBeenCalled();
		});
	});

	describe('remove', () => {
		it('removes a server from the global config', () => {
			const writeGlobalConfig = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue({
				...emptyConfig,
				mcpServers: {fs: {command: 'x'}, keep: {command: 'y'}},
			});

			const code = runCmd(
				{subcommand: 'remove', subcommandArgs: ['fs']},
				{readGlobalConfig, writeGlobalConfig},
			);

			expect(code).toBe(0);
			expect(writeGlobalConfig).toHaveBeenCalledWith({
				mcpServers: {keep: {command: 'y'}},
			});
		});

		it('removes a server from the project config with --project', () => {
			const writeProjectConfig = vi.fn();
			const readProjectConfig = vi.fn().mockReturnValue({
				...emptyConfig,
				mcpServers: {fs: {command: 'x'}},
			});

			const code = runCmd(
				{subcommand: 'remove', subcommandArgs: ['fs', '--project']},
				{readProjectConfig, writeProjectConfig},
			);

			expect(code).toBe(0);
			expect(writeProjectConfig).toHaveBeenCalledWith(TEST_PROJECT_DIR, {
				mcpServers: {},
			});
		});

		it('errors and does not write when the server is not found', () => {
			const writeGlobalConfig = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue({
				...emptyConfig,
				mcpServers: {other: {command: 'x'}},
			});
			const logError = vi.fn();

			const code = runCmd(
				{subcommand: 'remove', subcommandArgs: ['fs']},
				{readGlobalConfig, writeGlobalConfig, logError},
			);

			expect(code).toBe(1);
			expect(writeGlobalConfig).not.toHaveBeenCalled();
			expect(logError).toHaveBeenCalled();
		});
	});

	describe('list', () => {
		const globalCfg = {
			...emptyConfig,
			mcpServers: {
				shared: {command: 'global-cmd'},
				onlyGlobal: {command: 'g'},
			},
		};
		const projectCfg = {
			...emptyConfig,
			mcpServers: {
				shared: {command: 'project-cmd', env: {SECRET: 'topsecret'}},
				onlyProject: {command: 'p'},
			},
		};

		function listLines(args: string[]): {code: number; out: string} {
			const logOut = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue(globalCfg);
			const readProjectConfig = vi.fn().mockReturnValue(projectCfg);
			const code = runCmd(
				{subcommand: 'list', subcommandArgs: args},
				{readGlobalConfig, readProjectConfig, logOut},
			);
			const out = logOut.mock.calls.map(([m]) => m).join('\n');
			return {code, out};
		}

		it('shows the effective merge with source layers by default', () => {
			const {code, out} = listLines([]);
			expect(code).toBe(0);
			// project overrides global for the shared name
			expect(out).toMatch(/shared.*\[project\]/);
			expect(out).toMatch(/onlyGlobal.*\[global\]/);
			expect(out).toMatch(/onlyProject.*\[project\]/);
		});

		it('never prints env values', () => {
			const {out} = listLines([]);
			expect(out).not.toContain('topsecret');
			expect(out).not.toContain('SECRET');
		});

		it('lists only the global layer with --global', () => {
			const {code, out} = listLines(['--global']);
			expect(code).toBe(0);
			expect(out).toContain('shared');
			expect(out).toContain('onlyGlobal');
			expect(out).not.toContain('onlyProject');
		});

		it('lists only the project layer with --project', () => {
			const {code, out} = listLines(['--project']);
			expect(code).toBe(0);
			expect(out).toContain('onlyProject');
			expect(out).not.toContain('onlyGlobal');
		});

		it('reports a none-state when nothing is configured', () => {
			const logOut = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue(emptyConfig);
			const readProjectConfig = vi.fn().mockReturnValue(emptyConfig);
			const code = runCmd(
				{subcommand: 'list', subcommandArgs: []},
				{readGlobalConfig, readProjectConfig, logOut},
			);
			expect(code).toBe(0);
			const out = logOut.mock.calls.map(([m]) => m).join('\n');
			expect(out).toMatch(/none|no personal mcp/i);
		});
	});
});
