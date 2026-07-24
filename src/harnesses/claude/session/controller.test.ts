import {describe, expect, it, vi} from 'vitest';
import {EventEmitter} from 'node:events';
import type {ChildProcess} from 'node:child_process';
import {createClaudeSessionController} from './controller';
import type {CreateSessionControllerInput} from '../../contracts/session';

type SpawnCallbacks = {
	onStdout?: (data: string) => void;
	onStderr?: (data: string) => void;
	onExit?: (code: number | null) => void;
	onError?: (error: Error) => void;
};

function makeChild(): ChildProcess {
	const child = new EventEmitter() as ChildProcess;
	child.kill = vi.fn().mockReturnValue(true) as ChildProcess['kill'];
	return child;
}

/**
 * Builds a controller with an injected `spawnProcess` that records the options
 * it was called with (so the test can drive stdout/stderr/exit/error) and hands
 * back a killable fake child.
 */
function setup(overrides: Partial<CreateSessionControllerInput> = {}) {
	const child = makeChild();
	let options: Record<string, unknown> = {};
	const callbacks: SpawnCallbacks = {};
	const spawnProcess = vi.fn((opts: unknown) => {
		options = opts as Record<string, unknown>;
		callbacks.onStdout = options['onStdout'] as SpawnCallbacks['onStdout'];
		callbacks.onStderr = options['onStderr'] as SpawnCallbacks['onStderr'];
		callbacks.onExit = options['onExit'] as SpawnCallbacks['onExit'];
		callbacks.onError = options['onError'] as SpawnCallbacks['onError'];
		return child;
	});

	const controller = createClaudeSessionController({
		projectDir: '/project',
		instanceId: 7,
		spawnProcess: spawnProcess as never,
		...overrides,
	});

	return {
		controller,
		child,
		spawnProcess,
		getOptions: () => options,
		callbacks,
	};
}

describe('createClaudeSessionController', () => {
	it('starts a fresh Claude turn (no session id) and finalizes on exit', async () => {
		const {controller, spawnProcess, getOptions, callbacks} = setup();

		const turn = controller.startTurn({prompt: 'hello'});
		expect(spawnProcess).toHaveBeenCalledTimes(1);
		expect(getOptions()).toEqual(
			expect.objectContaining({
				prompt: 'hello',
				projectDir: '/project',
				instanceId: 7,
				sessionId: undefined,
			}),
		);

		callbacks.onExit?.(0);
		const result = await turn;
		expect(result.exitCode).toBe(0);
		expect(result.error).toBeNull();
	});

	it('forwards a resume continuation handle as the session id', async () => {
		const {controller, getOptions, callbacks} = setup();

		const turn = controller.startTurn({
			prompt: 'continue',
			continuation: {mode: 'resume', handle: 'sess-abc'},
		});
		expect(getOptions()).toEqual(
			expect.objectContaining({sessionId: 'sess-abc'}),
		);

		callbacks.onExit?.(0);
		await turn;
	});

	it('finalizes with an error when reuse-current continuation is requested', async () => {
		const {controller} = setup();

		const result = await controller.startTurn({
			prompt: 'reuse',
			continuation: {mode: 'reuse-current'},
		});

		expect(result.exitCode).toBeNull();
		expect(result.error?.message).toBe(
			'Claude harness does not support reuse-current continuation',
		);
	});

	it('maps an explicit workflow maxTurnTokenCount onto the Claude autocompact env knob', async () => {
		const {controller, getOptions, callbacks} = setup({
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				env: {CUSTOM: 'yes'},
				loop: {enabled: true, maxIterations: 5, maxTurnTokenCount: 120000},
			},
		});

		const turn = controller.startTurn({prompt: 'p'});
		expect(getOptions()['env']).toEqual({
			CUSTOM: 'yes',
			CLAUDE_CODE_AUTO_COMPACT_WINDOW: '120000',
		});

		callbacks.onExit?.(0);
		await turn;
	});

	it('injects no autocompact env when maxTurnTokenCount is unconfigured (spawn default applies)', async () => {
		const {controller, getOptions, callbacks} = setup({
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				env: {CUSTOM: 'yes'},
				loop: {enabled: true, maxIterations: 5},
			},
		});

		const turn = controller.startTurn({prompt: 'p'});
		expect(getOptions()['env']).toEqual({CUSTOM: 'yes'});

		callbacks.onExit?.(0);
		await turn;
	});

	it('lets plugin MCP config win over a per-command mcpConfig override', async () => {
		const {controller, getOptions, callbacks} = setup({
			processConfig: 'strict',
			pluginMcpConfig: '/plugin-mcp.json',
		});

		const turn = controller.startTurn({
			prompt: 'p',
			configOverride: {mcpConfig: '/per-command.json'} as never,
		});
		expect(getOptions()).toEqual(
			expect.objectContaining({
				isolation: expect.objectContaining({mcpConfig: '/plugin-mcp.json'}),
			}),
		);

		callbacks.onExit?.(0);
		await turn;
	});

	it('passes the base preset through unchanged when there is nothing to merge', async () => {
		const {controller, getOptions, callbacks} = setup({
			processConfig: 'strict',
		});

		const turn = controller.startTurn({prompt: 'p'});
		expect(getOptions()).toEqual(
			expect.objectContaining({isolation: 'strict'}),
		);

		callbacks.onExit?.(0);
		await turn;
	});

	it('accumulates the assistant message and token usage across stdout chunks', async () => {
		const {controller, callbacks} = setup();

		const turn = controller.startTurn({prompt: 'p'});
		callbacks.onStdout?.(
			'{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi there"}]}}\n',
		);
		callbacks.onStdout?.(
			'{"type":"message","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":2,"cache_creation_input_tokens":1}}\n',
		);
		callbacks.onExit?.(0);

		const result = await turn;
		expect(result.streamMessage).toBe('Hi there');
		expect(result.tokens).toEqual(
			expect.objectContaining({
				input: 10,
				output: 5,
				cacheRead: 2,
				cacheWrite: 1,
				total: 18,
			}),
		);
	});

	it('keeps the first stderr line as the root cause', async () => {
		const {controller, callbacks} = setup();

		const turn = controller.startTurn({prompt: 'p'});
		callbacks.onStderr?.('  first failure  ');
		callbacks.onStderr?.('cascading failure');
		callbacks.onExit?.(1);

		const result = await turn;
		expect(result.exitCode).toBe(1);
		expect(result.lastStderr).toBe('first failure');
	});

	it('forwards stderr lines to onStderrLine only when verbose', async () => {
		const verboseLines: string[] = [];
		const verbose = setup({verbose: true});
		const verboseTurn = verbose.controller.startTurn({
			prompt: 'p',
			onStderrLine: line => verboseLines.push(line),
		});
		verbose.callbacks.onStderr?.('  noisy  ');
		verbose.callbacks.onExit?.(0);
		await verboseTurn;
		expect(verboseLines).toEqual(['noisy']);

		const quietLines: string[] = [];
		const quiet = setup({verbose: false});
		const quietTurn = quiet.controller.startTurn({
			prompt: 'p',
			onStderrLine: line => quietLines.push(line),
		});
		quiet.callbacks.onStderr?.('noisy');
		quiet.callbacks.onExit?.(0);
		await quietTurn;
		expect(quietLines).toEqual([]);
	});

	it('finalizes with the error when the process emits onError', async () => {
		const {controller, callbacks} = setup();

		const turn = controller.startTurn({prompt: 'p'});
		callbacks.onError?.(new Error('boom'));

		const result = await turn;
		expect(result.exitCode).toBeNull();
		expect(result.error?.message).toBe('boom');
	});

	it('finalizes with the error when spawn throws synchronously', async () => {
		const spawnProcess = vi.fn(() => {
			throw new Error('spawn claude ENOENT');
		});
		const controller = createClaudeSessionController({
			projectDir: '/project',
			instanceId: 7,
			spawnProcess: spawnProcess as never,
		});

		const result = await controller.startTurn({prompt: 'p'});
		expect(result.exitCode).toBeNull();
		expect(result.error?.message).toBe('spawn claude ENOENT');
	});

	it('sends SIGINT to the active child on interrupt', async () => {
		const {controller, child, callbacks} = setup();

		const turn = controller.startTurn({prompt: 'p'});
		controller.interrupt();
		expect(child.kill).toHaveBeenCalledWith('SIGINT');

		callbacks.onExit?.(0);
		await turn;
	});

	it('kills the child and awaits turn settlement on kill', async () => {
		const {controller, child, callbacks} = setup();

		const turn = controller.startTurn({prompt: 'p'});
		const killPromise = controller.kill();
		expect(child.kill).toHaveBeenCalled();

		// kill() awaits the active turn promise, which only settles on exit.
		callbacks.onExit?.(0);
		await killPromise;
		await turn;
	});

	it('is a no-op to interrupt or kill with no active turn', async () => {
		const {controller, child} = setup();
		expect(() => controller.interrupt()).not.toThrow();
		await expect(controller.kill()).resolves.toBeUndefined();
		expect(child.kill).not.toHaveBeenCalled();
	});

	it('resets transport diagnostics on turn start and reads them on settle', async () => {
		const beginTurn = vi.fn();
		const getTransportStats = vi.fn(() => ({
			streamToolUses: 3,
			preToolUseEvents: 2,
		}));
		const feedStdout = vi.fn();
		const {controller, callbacks} = setup({
			runtime: {beginTurn, getTransportStats, feedStdout} as never,
		});

		const turn = controller.startTurn({prompt: 'p'});
		expect(beginTurn).toHaveBeenCalledTimes(1);

		callbacks.onStdout?.('chunk');
		expect(feedStdout).toHaveBeenCalledWith('chunk');

		callbacks.onExit?.(0);
		const result = await turn;
		expect(result.diagnostics).toEqual({
			transport: {streamToolUses: 3, preToolUseEvents: 2},
		});
	});

	it('omits diagnostics when the runtime does not support them', async () => {
		const {controller, callbacks} = setup();
		const turn = controller.startTurn({prompt: 'p'});
		callbacks.onExit?.(0);
		const result = await turn;
		expect(result.diagnostics).toBeUndefined();
	});
});
