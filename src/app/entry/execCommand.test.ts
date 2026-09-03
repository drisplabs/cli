import {describe, expect, it, vi} from 'vitest';
import {runExecCommand, type ExecRuntimeConfig} from './execCommand';
import {RUN_EXIT_CODE} from '../exec';

const BASE_RUNTIME_CONFIG: ExecRuntimeConfig = {
	harness: 'claude-code' as const,
	isolationConfig: {},
	pluginMcpConfig: undefined,
	workflow: undefined,
	workflowPlan: undefined,
	personalMcpServers: [],
	personalSkills: [],
	capabilityConflicts: {mcpServers: [], skills: []},
	permissionGraceMs: 60_000,
};

const BASE_FLAGS = {
	continueFlag: undefined,
	json: false,
	outputLastMessage: undefined,
	ephemeral: false,
	timeoutMs: undefined,
	verbose: false,
};

describe('runExecCommand', () => {
	it('fails usage on invalid timeout', async () => {
		const logError = vi.fn();
		const runExecFn = vi.fn();

		const code = await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'hello',
				flags: {...BASE_FLAGS, timeoutMs: 0},
				runtimeConfig: BASE_RUNTIME_CONFIG,
			},
			{logError, runExecFn: runExecFn as never},
		);

		expect(code).toBe(RUN_EXIT_CODE.USAGE);
		expect(runExecFn).not.toHaveBeenCalled();
		expect(logError).toHaveBeenCalled();
	});

	it('fails usage on --ephemeral with --continue', async () => {
		const logError = vi.fn();
		const runExecFn = vi.fn();

		const code = await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'hello',
				flags: {...BASE_FLAGS, ephemeral: true, continueFlag: ''},
				runtimeConfig: BASE_RUNTIME_CONFIG,
			},
			{logError, runExecFn: runExecFn as never},
		);

		expect(code).toBe(RUN_EXIT_CODE.USAGE);
		expect(runExecFn).not.toHaveBeenCalled();
		expect(logError).toHaveBeenCalled();
	});

	it('fails runtime when --continue has no prior sessions', async () => {
		const logError = vi.fn();
		const runExecFn = vi.fn();

		const code = await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'hello',
				flags: {...BASE_FLAGS, continueFlag: ''},
				runtimeConfig: BASE_RUNTIME_CONFIG,
			},
			{
				logError,
				runExecFn: runExecFn as never,
				getMostRecentSessionFn: () => null,
			},
		);

		expect(code).toBe(RUN_EXIT_CODE.RUNTIME);
		expect(runExecFn).not.toHaveBeenCalled();
		expect(logError).toHaveBeenCalled();
	});

	it('fails runtime when explicit --continue id is unknown', async () => {
		const logError = vi.fn();
		const runExecFn = vi.fn();

		const code = await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'hello',
				flags: {...BASE_FLAGS, continueFlag: 'unknown-id'},
				runtimeConfig: BASE_RUNTIME_CONFIG,
			},
			{
				logError,
				runExecFn: runExecFn as never,
				getSessionMetaFn: () => null,
			},
		);

		expect(code).toBe(RUN_EXIT_CODE.RUNTIME);
		expect(runExecFn).not.toHaveBeenCalled();
		expect(logError).toHaveBeenCalled();
	});

	it('fails runtime when continue resolution throws', async () => {
		const logError = vi.fn();
		const runExecFn = vi.fn();

		const code = await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'hello',
				flags: {...BASE_FLAGS, continueFlag: ''},
				runtimeConfig: BASE_RUNTIME_CONFIG,
			},
			{
				logError,
				runExecFn: runExecFn as never,
				getMostRecentSessionFn: () => {
					throw new Error('registry unavailable');
				},
			},
		);

		expect(code).toBe(RUN_EXIT_CODE.RUNTIME);
		expect(runExecFn).not.toHaveBeenCalled();
		expect(logError).toHaveBeenCalledWith(
			expect.stringContaining('Failed to resolve --continue session'),
		);
	});

	it('rejects --answer without --continue', async () => {
		const logError = vi.fn();
		const runExecFn = vi.fn();
		const code = await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'hello',
				flags: {...BASE_FLAGS, answer: 'allow'},
				runtimeConfig: BASE_RUNTIME_CONFIG,
			},
			{runExecFn, logError},
		);
		expect(code).toBe(RUN_EXIT_CODE.USAGE);
		expect(runExecFn).not.toHaveBeenCalled();
		expect(logError).toHaveBeenCalledWith(
			expect.stringContaining('--answer only applies with --continue'),
		);
	});

	it('rejects an --answer that is neither allow nor deny, and a negative grace window', async () => {
		const logError = vi.fn();
		const runExecFn = vi.fn();
		expect(
			await runExecCommand(
				{
					projectDir: '/tmp',
					prompt: 'hello',
					flags: {...BASE_FLAGS, continueFlag: 'athena-1', answer: 'maybe'},
					runtimeConfig: BASE_RUNTIME_CONFIG,
				},
				{runExecFn, logError},
			),
		).toBe(RUN_EXIT_CODE.USAGE);
		expect(
			await runExecCommand(
				{
					projectDir: '/tmp',
					prompt: 'hello',
					flags: {...BASE_FLAGS, permissionGraceMs: -1},
					runtimeConfig: BASE_RUNTIME_CONFIG,
				},
				{runExecFn, logError},
			),
		).toBe(RUN_EXIT_CODE.USAGE);
		expect(runExecFn).not.toHaveBeenCalled();
	});

	it('forwards the configured grace window, lets the flag override it, and turns --answer into a stored decision (#190)', async () => {
		const runExecFn = vi
			.fn()
			.mockResolvedValue({exitCode: RUN_EXIT_CODE.SUCCESS});
		const getSessionMetaFn = vi.fn(() => ({
			id: 'athena-1',
			projectDir: '/tmp',
			createdAt: 1,
			updatedAt: 1,
			adapterSessionIds: ['adapter-1'],
		}));

		await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'go ahead',
				flags: {...BASE_FLAGS},
				runtimeConfig: {...BASE_RUNTIME_CONFIG, permissionGraceMs: 12_000},
			},
			{runExecFn},
		);
		expect(runExecFn).toHaveBeenLastCalledWith(
			expect.objectContaining({permissionGraceMs: 12_000}),
		);
		expect(runExecFn.mock.calls.at(-1)![0]).not.toHaveProperty('storedAnswer');

		await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'go ahead',
				flags: {
					...BASE_FLAGS,
					continueFlag: 'athena-1',
					answer: 'deny',
					permissionGraceMs: 0,
				},
				runtimeConfig: {...BASE_RUNTIME_CONFIG, permissionGraceMs: 12_000},
			},
			{runExecFn, getSessionMetaFn},
		);
		expect(runExecFn).toHaveBeenLastCalledWith(
			expect.objectContaining({
				athenaSessionId: 'athena-1',
				permissionGraceMs: 0,
				storedAnswer: {
					type: 'json',
					source: 'user',
					intent: expect.objectContaining({kind: 'permission_deny'}),
				},
			}),
		);
	});

	it('runs exec with resolved resume info and returns exit code', async () => {
		const runExecFn = vi
			.fn()
			.mockResolvedValue({exitCode: RUN_EXIT_CODE.RUNTIME});

		const code = await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'hello',
				flags: {...BASE_FLAGS},
				runtimeConfig: BASE_RUNTIME_CONFIG,
			},
			{
				runExecFn,
				createSessionId: () => 'athena-new',
			},
		);

		expect(code).toBe(RUN_EXIT_CODE.RUNTIME);
		expect(runExecFn).toHaveBeenCalledWith(
			expect.objectContaining({
				athenaSessionId: 'athena-new',
			}),
		);
	});

	it('queues --steer texts as local steers, in order, on a steer queue (#191)', async () => {
		const runExecFn = vi.fn().mockResolvedValue({exitCode: 0});

		await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'hello',
				flags: {
					...BASE_FLAGS,
					steers: ['use the other branch', '  ', 'be brief'],
				},
				runtimeConfig: BASE_RUNTIME_CONFIG,
			},
			{runExecFn, now: () => 4_242},
		);

		const options = runExecFn.mock.calls[0]![0] as {
			steerQueue?: {subscribe: (listener: (s: unknown) => void) => void};
		};
		expect(options.steerQueue).toBeDefined();
		const received: unknown[] = [];
		options.steerQueue!.subscribe(steer => received.push(steer));
		expect(received).toEqual([
			{text: 'use the other branch', origin: 'local', receivedAt: 4_242},
			{text: 'be brief', origin: 'local', receivedAt: 4_242},
		]);
	});

	it('passes no steer queue when --steer is absent', async () => {
		const runExecFn = vi.fn().mockResolvedValue({exitCode: 0});

		await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'hello',
				flags: {...BASE_FLAGS},
				runtimeConfig: BASE_RUNTIME_CONFIG,
			},
			{runExecFn},
		);

		expect(runExecFn.mock.calls[0]![0]).not.toHaveProperty('steerQueue');
	});

	it('forwards a stripped personal capabilities summary (name + layer only)', async () => {
		const runExecFn = vi
			.fn()
			.mockResolvedValue({exitCode: RUN_EXIT_CODE.SUCCESS});

		await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'hello',
				flags: {...BASE_FLAGS},
				runtimeConfig: {
					...BASE_RUNTIME_CONFIG,
					personalMcpServers: [
						{
							name: 'db',
							command: 'npx',
							args: ['-y', 'server'],
							env: {API_KEY: 'topsecret'},
							sourceLayer: 'project',
						},
					],
					personalSkills: [
						{
							name: 'greet',
							source: './skills/greet',
							path: '/abs/secret/path/greet',
							sourceLayer: 'global',
						},
					],
				},
			},
			{runExecFn, createSessionId: () => 'athena-new'},
		);

		expect(runExecFn).toHaveBeenCalledWith(
			expect.objectContaining({
				personalCapabilities: {
					mcpServers: [{name: 'db', sourceLayer: 'project'}],
					skills: [{name: 'greet', sourceLayer: 'global'}],
				},
			}),
		);

		const passed = JSON.stringify(runExecFn.mock.calls[0]![0]);
		expect(passed).not.toContain('topsecret');
		expect(passed).not.toContain('/abs/secret/path/greet');
		expect(passed).not.toContain('API_KEY');
	});

	it('forwards a stripped capability-conflicts summary (name + layer only)', async () => {
		const runExecFn = vi
			.fn()
			.mockResolvedValue({exitCode: RUN_EXIT_CODE.SUCCESS});

		await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'hello',
				flags: {...BASE_FLAGS},
				runtimeConfig: {
					...BASE_RUNTIME_CONFIG,
					capabilityConflicts: {
						mcpServers: [
							{
								name: 'db',
								command: 'npx',
								args: ['-y', 'server'],
								env: {API_KEY: 'topsecret'},
								sourceLayer: 'project',
							},
						],
						skills: [
							{
								name: 'greet',
								source: './skills/greet',
								path: '/abs/secret/path/greet',
								sourceLayer: 'global',
							},
						],
					},
				},
			},
			{runExecFn, createSessionId: () => 'athena-new'},
		);

		expect(runExecFn).toHaveBeenCalledWith(
			expect.objectContaining({
				capabilityConflicts: {
					mcpServers: [{name: 'db', sourceLayer: 'project'}],
					skills: [{name: 'greet', sourceLayer: 'global'}],
				},
			}),
		);

		const passed = JSON.stringify(runExecFn.mock.calls[0]![0]);
		expect(passed).not.toContain('topsecret');
		expect(passed).not.toContain('/abs/secret/path/greet');
		expect(passed).not.toContain('API_KEY');
	});

	it('uses most recent session when bare --continue is provided', async () => {
		const runExecFn = vi
			.fn()
			.mockResolvedValue({exitCode: RUN_EXIT_CODE.SUCCESS});

		await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'hello',
				flags: {...BASE_FLAGS, continueFlag: ''},
				runtimeConfig: BASE_RUNTIME_CONFIG,
			},
			{
				runExecFn,
				getMostRecentSessionFn: () => ({
					id: 'athena-1',
					adapterSessionIds: ['a-1', 'a-2'],
					projectDir: '/tmp',
					createdAt: 0,
					updatedAt: 0,
				}),
			},
		);

		expect(runExecFn).toHaveBeenCalledWith(
			expect.objectContaining({
				athenaSessionId: 'athena-1',
				adapterResumeSessionId: 'a-2',
			}),
		);
	});
});
