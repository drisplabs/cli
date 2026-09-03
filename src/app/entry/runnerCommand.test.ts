import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {runRunnerCommand} from './runnerCommand';
import type {executeRemoteAssignment} from '../dashboard/remoteRunExecutor';
import type {DashboardClientConfig} from '../../infra/config/dashboardClient';

function captureLogs() {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		logOut: (m: string) => out.push(m),
		logError: (m: string) => err.push(m),
	};
}

function jsonResponse(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response;
}

const STATIC_FINGERPRINT = 'fp-static';
const tmpDirs: string[] = [];
const originalXdgStateHome = process.env['XDG_STATE_HOME'];
const originalHome = process.env['HOME'];

afterEach(() => {
	if (originalXdgStateHome === undefined) {
		delete process.env['XDG_STATE_HOME'];
	} else {
		process.env['XDG_STATE_HOME'] = originalXdgStateHome;
	}
	if (originalHome === undefined) {
		delete process.env['HOME'];
	} else {
		process.env['HOME'] = originalHome;
	}
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

function makeDeps(overrides: {
	fetchMock?: ReturnType<typeof vi.fn>;
	stored?: DashboardClientConfig | null;
	written?: DashboardClientConfig[];
	removed?: {count: number};
	now?: number;
}) {
	const writes = overrides.written ?? [];
	const stored = {value: overrides.stored ?? null};
	const removed = overrides.removed ?? {count: 0};
	const cap = captureLogs();
	const stateDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-state-'));
	tmpDirs.push(stateDirPath);
	process.env['XDG_STATE_HOME'] = stateDirPath;
	return {
		cap,
		writes,
		stored,
		removed,
		deps: {
			fetch: overrides.fetchMock as unknown as typeof fetch,
			now: () => overrides.now ?? 1_700_000_000_000,
			fingerprint: () => STATIC_FINGERPRINT,
			hostInfo: () => ({
				hostname: 'test-host',
				user: 'tester',
				name: 'test-host',
			}),
			packageVersion: '9.9.9-test',
			readConfig: () => stored.value,
			writeConfig: (c: DashboardClientConfig) => {
				stored.value = c;
				writes.push(c);
			},
			writeMirror: vi.fn(),
			fetchAttachments: vi.fn(async () => []),
			removeConfig: () => {
				stored.value = null;
				removed.count += 1;
			},
			removeMirror: vi.fn(),
			startDetachedRunner: vi.fn(async () => ({
				ok: true,
				connected: true,
				message: 'connected',
			})),
			configPath: () => '/tmp/athena/dashboard.json',
			logOut: cap.logOut,
			logError: cap.logError,
		},
	};
}

describe('runRunnerCommand: usage', () => {
	it('runs the runner in the foreground on no subcommand: not paired exits 1', async () => {
		const {deps, cap} = makeDeps({});
		const code = await runRunnerCommand(
			{subcommand: '', subcommandArgs: [], flags: {}},
			deps,
		);
		expect(code).toBe(1);
		expect(cap.err.join('\n')).toContain('not paired');
		expect(cap.out.join('\n')).not.toContain('Usage: drisp runner');
	});

	it('prints usage on help', async () => {
		const {deps, cap} = makeDeps({});
		const code = await runRunnerCommand(
			{subcommand: 'help', subcommandArgs: [], flags: {}},
			deps,
		);
		expect(code).toBe(0);
		expect(cap.out.join('\n')).toContain('Usage: drisp runner');
		expect(cap.out.join('\n')).not.toContain('console link');
	});

	it('rejects unknown subcommand', async () => {
		const {deps, cap} = makeDeps({});
		const code = await runRunnerCommand(
			{subcommand: 'wat', subcommandArgs: [], flags: {}},
			deps,
		);
		expect(code).toBe(2);
		expect(cap.err.join('\n')).toContain('Unknown runner subcommand');
	});
});

describe('runRunnerCommand: pair', () => {
	it('requires a pairing token', async () => {
		const {deps, cap} = makeDeps({});
		const code = await runRunnerCommand(
			{
				subcommand: 'pair',
				subcommandArgs: [],
				flags: {url: 'http://localhost:5173'},
			},
			deps,
		);
		expect(code).toBe(2);
		expect(cap.err.join('\n')).toContain('missing pairing token');
	});

	it('requires --url', async () => {
		const {deps, cap} = makeDeps({});
		const code = await runRunnerCommand(
			{subcommand: 'pair', subcommandArgs: ['tok_1'], flags: {}},
			deps,
		);
		expect(code).toBe(2);
		expect(cap.err.join('\n')).toContain('--url');
	});

	it('rejects malformed --url', async () => {
		const {deps, cap} = makeDeps({});
		const code = await runRunnerCommand(
			{
				subcommand: 'pair',
				subcommandArgs: ['tok_1'],
				flags: {url: 'ws://nope'},
			},
			deps,
		);
		expect(code).toBe(2);
		expect(cap.err.join('\n')).toContain('http:// or https://');
	});

	it('posts to /api/instances/pair with fingerprint, hostInfo, capabilities', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				instanceId: 'inst_1',
				refreshToken: 'refresh_1',
				jti: 'jti_1',
			}),
		);
		const {deps, writes} = makeDeps({fetchMock});

		const code = await runRunnerCommand(
			{
				subcommand: 'pair',
				subcommandArgs: ['tok_1'],
				flags: {url: 'http://localhost:5173/app/instances'},
			},
			deps,
		);

		expect(code).toBe(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe('http://localhost:5173/api/instances/pair');
		const reqBody = JSON.parse((init as RequestInit).body as string);
		expect(reqBody).toMatchObject({
			token: 'tok_1',
			fingerprint: STATIC_FINGERPRINT,
			hostInfo: {hostname: 'test-host'},
			capabilities: {
				instanceSocket: true,
				runtimeDaemon: true,
				version: '9.9.9-test',
			},
		});
		expect(writes).toHaveLength(1);
		expect(writes[0]).toEqual({
			dashboardUrl: 'http://localhost:5173',
			instanceId: 'inst_1',
			refreshToken: 'refresh_1',
			fingerprint: STATIC_FINGERPRINT,
			pairedAt: 1_700_000_000_000,
		});
	});

	it('starts the runner after pairing and reports bound runners', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				instanceId: 'inst_1',
				refreshToken: 'refresh_1',
				runners: [
					{
						runnerId: 'runner_1',
						name: 'Nightly QA',
						executionTarget: 'remote',
						remoteInstanceId: 'inst_1',
					},
				],
			}),
		);
		const startDetachedRunner = vi.fn(async () => ({
			ok: true,
			alreadyRunning: false,
			connected: true,
			message: 'connected',
		}));
		const {deps, cap} = makeDeps({fetchMock});

		const code = await runRunnerCommand(
			{
				subcommand: 'pair',
				subcommandArgs: ['tok_1'],
				flags: {url: 'http://localhost:5173'},
			},
			{...deps, startDetachedRunner},
		);

		expect(code).toBe(0);
		expect(startDetachedRunner).toHaveBeenCalledTimes(1);
		expect(cap.out.join('\n')).toContain('runner connected');
		expect(cap.out.join('\n')).toContain('bound runner Nightly QA (runner_1)');
	});

	it('does not write console sidecars after pairing', async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-home-'));
		tmpDirs.push(home);
		process.env['HOME'] = home;
		const channelDir = path.join(home, '.config', 'athena', 'channels');
		try {
			const fetchMock = vi.fn().mockResolvedValue(
				jsonResponse(200, {
					instanceId: 'inst_1',
					refreshToken: 'refresh_1',
					runners: [
						{runnerId: 'r1', name: 'one'},
						{runnerId: 'r2', name: 'two'},
					],
				}),
			);
			// Stale dashboard-managed sidecar for a runner no longer attached.
			fs.mkdirSync(channelDir, {recursive: true});
			fs.writeFileSync(
				path.join(channelDir, 'console-rOld.json'),
				JSON.stringify({
					kind: 'console',
					instance_id: 'console:rOld',
					broker_url: 'wss://old',
					runner_id: 'rOld',
					dashboard_config: true,
				}),
			);
			const {deps} = makeDeps({fetchMock});

			const code = await runRunnerCommand(
				{
					subcommand: 'pair',
					subcommandArgs: ['tok_1'],
					flags: {url: 'http://localhost:5173'},
				},
				deps,
			);

			expect(code).toBe(0);
			expect(fs.existsSync(path.join(channelDir, 'console-r1.json'))).toBe(
				false,
			);
			expect(fs.existsSync(path.join(channelDir, 'console-r2.json'))).toBe(
				false,
			);
			expect(fs.existsSync(path.join(channelDir, 'console-rOld.json'))).toBe(
				true,
			);
		} finally {
			fs.rmSync(home, {recursive: true, force: true});
		}
	});

	it('does not log refresh token in human output', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				instanceId: 'inst_1',
				refreshToken: 'super-secret-refresh',
			}),
		);
		const {deps, cap} = makeDeps({fetchMock});

		await runRunnerCommand(
			{
				subcommand: 'pair',
				subcommandArgs: ['tok_1'],
				flags: {url: 'http://localhost:5173'},
			},
			deps,
		);

		const everything = [...cap.out, ...cap.err].join('\n');
		expect(everything).not.toContain('super-secret-refresh');
		expect(cap.out.join('\n')).toContain(
			'paired to http://localhost:5173 as inst_1',
		);
	});

	it('reports HTTP error and exits 1 without writing config', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse(401, {error: 'invalid token'}));
		const {deps, cap, writes} = makeDeps({fetchMock});

		const code = await runRunnerCommand(
			{
				subcommand: 'pair',
				subcommandArgs: ['bad_token'],
				flags: {url: 'http://localhost:5173'},
			},
			deps,
		);

		expect(code).toBe(1);
		expect(writes).toHaveLength(0);
		expect(cap.err.join('\n')).toContain('401');
		expect(cap.err.join('\n')).toContain('invalid token');
	});

	it('rejects malformed pair response', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse(200, {instanceId: 'i_1'}));
		const {deps, cap, writes} = makeDeps({fetchMock});

		const code = await runRunnerCommand(
			{
				subcommand: 'pair',
				subcommandArgs: ['tok_1'],
				flags: {url: 'http://localhost:5173'},
			},
			deps,
		);

		expect(code).toBe(1);
		expect(writes).toHaveLength(0);
		expect(cap.err.join('\n')).toContain('invalid response');
	});

	it('emits structured JSON when --json is set', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				instanceId: 'inst_1',
				refreshToken: 'refresh_1',
			}),
		);
		const {deps, cap} = makeDeps({fetchMock});

		await runRunnerCommand(
			{
				subcommand: 'pair',
				subcommandArgs: ['tok_1'],
				flags: {url: 'http://localhost:5173', json: true},
			},
			deps,
		);

		const parsed = JSON.parse(cap.out.join('\n'));
		expect(parsed).toMatchObject({
			ok: true,
			instanceId: 'inst_1',
			dashboardUrl: 'http://localhost:5173',
		});
		// JSON pair output must not contain the refresh token.
		expect(cap.out.join('\n')).not.toContain('refresh_1');
	});

	it('exits 0 with a warning when the runner spawn fails', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				instanceId: 'inst_1',
				refreshToken: 'refresh_1',
			}),
		);
		const {deps, cap, writes} = makeDeps({fetchMock});
		const startDetachedRunner = vi.fn(async () => ({
			ok: false,
			message: 'spawn ENOENT',
		}));

		const code = await runRunnerCommand(
			{
				subcommand: 'pair',
				subcommandArgs: ['tok_1'],
				flags: {url: 'http://localhost:5173'},
			},
			{...deps, startDetachedRunner},
		);

		// Daemon failure is a warning, not a pair failure — pairing on disk is
		// the source of truth.
		expect(code).toBe(0);
		expect(writes).toHaveLength(1);
		expect(cap.err.join('\n')).toContain('runner did not start');
		expect(cap.out.join('\n')).toContain('pairing succeeded; start the runner');
	});

	it('exits 1 when the dashboard requires a newer cli', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				instanceId: 'inst_1',
				refreshToken: 'refresh_1',
				requiredCliVersion: '99.0.0',
			}),
		);
		const {deps, cap, writes} = makeDeps({fetchMock});
		const startDetachedRunner = vi.fn();

		const code = await runRunnerCommand(
			{
				subcommand: 'pair',
				subcommandArgs: ['tok_1'],
				flags: {url: 'http://localhost:5173'},
			},
			{...deps, startDetachedRunner},
		);

		expect(code).toBe(1);
		// Refusing the pair before writing config or starting the daemon avoids
		// leaving the user with a half-broken setup.
		expect(writes).toHaveLength(0);
		expect(startDetachedRunner).not.toHaveBeenCalled();
		expect(cap.err.join('\n')).toContain("older than the dashboard's required");
	});

	it('reports verified socket from the detached start probe result', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				instanceId: 'inst_1',
				refreshToken: 'refresh_1',
			}),
		);
		const {deps, cap} = makeDeps({fetchMock});
		const startDetachedRunner = vi.fn(
			async (opts: {log: (msg: string) => void}) => {
				opts.log('runner: socket verified (pid 4123)');
				return {
					ok: true,
					connected: true,
					pid: 4123,
					message: 'started, socket verified',
				};
			},
		);

		const code = await runRunnerCommand(
			{
				subcommand: 'pair',
				subcommandArgs: ['tok_1'],
				flags: {url: 'http://localhost:5173'},
			},
			{...deps, startDetachedRunner},
		);

		expect(code).toBe(0);
		expect(startDetachedRunner).toHaveBeenCalledTimes(1);
		expect(cap.out.join('\n')).toContain(
			'runner connected (verified socket open)',
		);
		expect(cap.out.join('\n')).toContain('socket verified (pid 4123)');
	});

	it('sends both cliVersion and legacy version capability fields', async () => {
		let capturedBody: unknown = null;
		const fetchMock = vi.fn(async (_url: string, init?: {body?: string}) => {
			if (init?.body) capturedBody = JSON.parse(init.body);
			return jsonResponse(200, {
				instanceId: 'inst_1',
				refreshToken: 'refresh_1',
			});
		});
		const {deps} = makeDeps({
			fetchMock: fetchMock as unknown as ReturnType<typeof vi.fn>,
		});

		await runRunnerCommand(
			{
				subcommand: 'pair',
				subcommandArgs: ['tok_1'],
				flags: {url: 'http://localhost:5173'},
			},
			deps,
		);

		expect(capturedBody).toMatchObject({
			capabilities: {
				cliVersion: '9.9.9-test',
				version: '9.9.9-test',
				runtimeDaemon: true,
			},
		});
	});
});

describe('runRunnerCommand: refresh', () => {
	const stored: DashboardClientConfig = {
		dashboardUrl: 'https://example.com',
		instanceId: 'inst_1',
		refreshToken: 'old-refresh',
		fingerprint: 'fp-stored',
		pairedAt: 1,
	};

	it('errors when not paired', async () => {
		const {deps, cap} = makeDeps({});
		const code = await runRunnerCommand(
			{subcommand: 'refresh', subcommandArgs: [], flags: {}},
			deps,
		);
		expect(code).toBe(1);
		expect(cap.err.join('\n')).toContain('not paired');
	});

	it('delegates to refreshDashboardAccessToken and rotates stored refresh token', async () => {
		const performRefresh = vi.fn().mockImplementation(async () => {
			// The shared helper rotates the on-disk refresh token before
			// returning. Mirror that here so the JSON output sees the new value.
			return {
				instanceId: 'inst_1',
				accessToken: 'access-1',
				expiresInSec: 900,
			};
		});
		const {deps, writes, stored: storedRef} = makeDeps({stored, now: 5_000});
		// Pretend the helper rotated the on-disk value.
		const rotateStored = () => {
			storedRef.value = {...storedRef.value!, refreshToken: 'new-refresh'};
			writes.push(storedRef.value!);
		};
		const code = await runRunnerCommand(
			{subcommand: 'refresh', subcommandArgs: [], flags: {}},
			{
				...deps,
				performRefresh: async label => {
					rotateStored();
					return performRefresh(label);
				},
			},
		);
		expect(code).toBe(0);
		expect(performRefresh).toHaveBeenCalledTimes(1);
		expect(performRefresh.mock.calls[0]![0]).toBe('refresh');
		expect(writes).toHaveLength(1);
		expect(writes[0]?.refreshToken).toBe('new-refresh');
	});

	it('does not print tokens in human output', async () => {
		const {deps, cap} = makeDeps({stored});
		await runRunnerCommand(
			{subcommand: 'refresh', subcommandArgs: [], flags: {}},
			{
				...deps,
				performRefresh: async () => ({
					instanceId: 'inst_1',
					accessToken: 'super-access',
					expiresInSec: 900,
				}),
			},
		);
		const out = cap.out.join('\n');
		expect(out).not.toContain('super-access');
		expect(out).toContain('refreshed access token for instance inst_1');
	});

	it('emits access token and rotated refresh token only when --json is set', async () => {
		const {deps, cap, stored: storedRef} = makeDeps({stored});
		await runRunnerCommand(
			{subcommand: 'refresh', subcommandArgs: [], flags: {json: true}},
			{
				...deps,
				performRefresh: async () => {
					storedRef.value = {
						...storedRef.value!,
						refreshToken: 'new-refresh',
					};
					return {
						instanceId: 'inst_1',
						accessToken: 'access-1',
						expiresInSec: 900,
					};
				},
			},
		);
		const parsed = JSON.parse(cap.out.join('\n'));
		expect(parsed).toMatchObject({
			ok: true,
			instanceId: 'inst_1',
			accessToken: 'access-1',
			refreshToken: 'new-refresh',
			expiresInSec: 900,
		});
	});

	it('reports refresh errors and exits 1', async () => {
		const {deps, cap} = makeDeps({stored});
		const code = await runRunnerCommand(
			{subcommand: 'refresh', subcommandArgs: [], flags: {}},
			{
				...deps,
				performRefresh: async () => {
					throw new Error(
						'dashboard refresh: https://example.com returned 503',
					);
				},
			},
		);
		expect(code).toBe(1);
		expect(cap.err.join('\n')).toContain('503');
	});
});

describe('runRunnerCommand: status', () => {
	it('reports not paired', async () => {
		const {deps, cap} = makeDeps({});
		const code = await runRunnerCommand(
			{subcommand: 'status', subcommandArgs: [], flags: {}},
			deps,
		);
		expect(code).toBe(1);
		expect(cap.out.join('\n')).toContain('not paired');
	});

	it('prints pairing, runner-down, and exits non-zero', async () => {
		const stored: DashboardClientConfig = {
			dashboardUrl: 'https://example.com',
			instanceId: 'inst_1',
			refreshToken: 'do-not-print',
			fingerprint: 'fp-stored',
			pairedAt: 1,
		};
		const {deps, cap} = makeDeps({stored});

		const code = await runRunnerCommand(
			{subcommand: 'status', subcommandArgs: [], flags: {}},
			{
				...deps,
				readRunnerStatus: () => ({
					running: false,
					error: 'runner not running',
				}),
			},
		);
		// Paired but runner down → unhealthy axis → exit 1.
		expect(code).toBe(1);
		expect(cap.out.join('\n')).toContain(
			'paired to https://example.com as inst_1',
		);
		expect(cap.out.join('\n')).toContain('NOT running');
		expect(cap.out.join('\n')).not.toContain('do-not-print');
	});

	it('reports a healthy runner and exits 0', async () => {
		const stored: DashboardClientConfig = {
			dashboardUrl: 'https://example.com',
			instanceId: 'inst_1',
			refreshToken: 'do-not-print',
			fingerprint: 'fp-stored',
			pairedAt: 1,
		};
		const {deps, cap} = makeDeps({stored});

		const code = await runRunnerCommand(
			{subcommand: 'status', subcommandArgs: [], flags: {}},
			{
				...deps,
				readRunnerStatus: () => ({
					running: true,
					status: {
						pid: 4123,
						startedAt: Date.now() - 2_000,
						updatedAt: Date.now(),
						socketConnected: true,
						wireMode: 'canonical',
						activeRuns: 0,
						completedRuns: 2,
						instanceId: 'inst_1',
						dashboardUrl: 'https://example.com',
						runs: [],
					},
				}),
			},
		);
		expect(code).toBe(0);
		expect(cap.out.join('\n')).toMatch(/runner:\s+running \(pid 4123/);
		expect(cap.out.join('\n')).toContain(
			'socket:    connected (canonical frame names)',
		);
	});

	it('emits JSON without tokens', async () => {
		const stored: DashboardClientConfig = {
			dashboardUrl: 'https://example.com',
			instanceId: 'inst_1',
			refreshToken: 'do-not-print',
			fingerprint: 'fp-stored',
			pairedAt: 1,
			lastRefreshAt: 2,
		};
		const {deps, cap} = makeDeps({stored});

		await runRunnerCommand(
			{subcommand: 'status', subcommandArgs: [], flags: {json: true}},
			{
				...deps,
				readRunnerStatus: () => ({
					running: true,
					status: {
						pid: 1,
						startedAt: 0,
						updatedAt: 5,
						socketConnected: true,
						activeRuns: 0,
						completedRuns: 0,
						runs: [],
					},
				}),
			},
		);
		const parsed = JSON.parse(cap.out.join('\n'));
		expect(parsed).toMatchObject({
			ok: true,
			paired: true,
			instanceId: 'inst_1',
			dashboardUrl: 'https://example.com',
			lastRefreshAt: 2,
			runner: {running: true, pid: 1, socketConnected: true, updatedAt: 5},
		});
		expect(cap.out.join('\n')).not.toContain('do-not-print');
	});
});

type FakeFrame = import('@drisp/protocol').CanonicalFrame;
type FakeRunEvent = {
	runId: string;
	seq: number;
	ts: number;
	kind: string;
	payload?: unknown;
};

function makeFakeSocket(connectFn?: () => Promise<void>) {
	const calls = {connect: 0, closed: [] as string[]};
	const closeHandlers: Array<(reason: string) => void> = [];
	const frameHandlers: Array<(frame: FakeFrame) => void> = [];
	const runEvents: FakeRunEvent[] = [];
	const assignmentAccepted: string[] = [];
	const assignmentRejected: Array<{
		runId: string;
		reason: string;
		message?: string;
	}> = [];
	let lastOpts: {
		dashboardUrl: string;
		instanceId: string;
		accessToken: string;
	} | null = null;
	const factory = (o: {
		dashboardUrl: string;
		instanceId: string;
		accessToken: string;
	}) => {
		lastOpts = o;
		return {
			connect: async () => {
				calls.connect += 1;
				if (connectFn) await connectFn();
			},
			close: (reason?: string) => calls.closed.push(reason ?? ''),
			onFrame: (h: (f: FakeFrame) => void) => {
				frameHandlers.push(h);
			},
			onClose: (h: (reason: string) => void) => {
				closeHandlers.push(h);
			},
			sendAssignmentAccepted: (runId: string) => {
				assignmentAccepted.push(runId);
			},
			sendAssignmentRejected: (input: {
				runId: string;
				reason: string;
				message?: string;
			}) => {
				assignmentRejected.push(input);
			},
			sendRunEvent: (event: FakeRunEvent) => runEvents.push(event),
			sendFeedEvent: () => {},
			sendDecisionAck: () => {},
		};
	};
	return {
		factory,
		calls,
		runEvents,
		assignmentAccepted,
		assignmentRejected,
		lastOpts: () => lastOpts,
		emitClose: (reason: string) => {
			for (const h of closeHandlers) h(reason);
		},
		emitFrame: (frame: FakeFrame) => {
			for (const h of frameHandlers) h(frame);
		},
	};
}

describe('runRunnerCommand: foreground (no subcommand)', () => {
	const stored: DashboardClientConfig = {
		dashboardUrl: 'https://example.com',
		instanceId: 'inst_1',
		refreshToken: 'old-refresh',
		fingerprint: 'fp-stored',
		pairedAt: 1,
	};

	const happyRefresh = async () => ({
		instanceId: 'inst_1',
		accessToken: 'fresh-access',
		expiresInSec: 900,
	});

	it('errors when not paired', async () => {
		const {deps, cap} = makeDeps({});
		const code = await runRunnerCommand(
			{subcommand: '', subcommandArgs: [], flags: {}},
			deps,
		);
		expect(code).toBe(1);
		expect(cap.err.join('\n')).toContain('not paired');
	});

	it('runs the runner process in the foreground until shutdown', async () => {
		const fakeSocket = makeFakeSocket();
		const {deps, cap} = makeDeps({stored});
		const code = await runRunnerCommand(
			{subcommand: '', subcommandArgs: [], flags: {}},
			{
				...deps,
				performRefresh: happyRefresh,
				makeInstanceSocketClient: fakeSocket.factory,
				waitForShutdown: async () => 'SIGINT',
			},
		);

		expect(code).toBe(0);
		expect(fakeSocket.calls.connect).toBe(1);
		expect(fakeSocket.lastOpts()).toEqual({
			dashboardUrl: 'https://example.com',
			instanceId: 'inst_1',
			accessToken: 'fresh-access',
			log: expect.any(Function),
			installedWorkflows: expect.any(Function),
		});
		expect(cap.out.join('\n')).toContain('foreground runtime connected');
		expect(cap.out.join('\n')).toContain('stopped (SIGINT)');
	});

	it('exits 1 when refresh fails and never opens socket', async () => {
		const fakeSocket = makeFakeSocket();
		const {deps} = makeDeps({stored});
		const code = await runRunnerCommand(
			{subcommand: '', subcommandArgs: [], flags: {}},
			{
				...deps,
				performRefresh: async () => {
					throw new Error('expired');
				},
				makeInstanceSocketClient: fakeSocket.factory,
				waitForShutdown: async () => 'SIGINT',
			},
		);
		expect(code).toBe(1);
		expect(fakeSocket.calls.connect).toBe(0);
	});

	it('reports socket connect failure and exits 1', async () => {
		const {deps, cap} = makeDeps({stored});
		const code = await runRunnerCommand(
			{subcommand: '', subcommandArgs: [], flags: {}},
			{
				...deps,
				performRefresh: happyRefresh,
				makeInstanceSocketClient: () => ({
					connect: async () => {
						throw new Error('refused');
					},
					close: () => {},
					onFrame: () => {},
					onClose: () => {},
					sendAssignmentAccepted: () => {},
					sendAssignmentRejected: () => {},
					sendRunEvent: () => {},
					sendFeedEvent: () => {},
					sendDecisionAck: () => {},
				}),
				waitForShutdown: async () => 'SIGINT',
			},
		);
		expect(code).toBe(1);
		expect(cap.err.join('\n')).toContain('refused');
	});
});

describe('runRunnerCommand: foreground → executeRemoteAssignment', () => {
	const stored: DashboardClientConfig = {
		dashboardUrl: 'https://example.com',
		instanceId: 'inst_1',
		refreshToken: 'old-refresh',
		fingerprint: 'fp-stored',
		pairedAt: 1,
	};

	const happyRefresh = async () => ({
		instanceId: 'inst_1',
		accessToken: 'a',
		expiresInSec: 900,
	});

	it('routes run.start frames to the executor and de-dups runIds in flight', async () => {
		const fake = makeFakeSocket();
		const executor = vi.fn(async () => {});

		const {deps} = makeDeps({stored});
		const pending = runRunnerCommand(
			{subcommand: '', subcommandArgs: [], flags: {}},
			{
				...deps,
				performRefresh: happyRefresh,
				makeInstanceSocketClient: fake.factory,
				executeRemoteAssignment:
					executor as unknown as typeof executeRemoteAssignment,
				waitForShutdown: async () => 'SIGINT',
			},
		);

		await new Promise(r => setTimeout(r, 0));
		const frame: FakeFrame = {
			type: 'run.start',
			runId: 'run_1',
			runSpec: {prompt: 'hi'},
		};
		fake.emitFrame(frame);
		fake.emitFrame(frame);

		await pending;
		expect(executor).toHaveBeenCalledTimes(1);
		expect(executor.mock.calls[0]![0]).toMatchObject({
			assignment: expect.objectContaining({runId: 'run_1', frame}),
		});
	});

	it('aborts in-flight assignments on stop', async () => {
		const fake = makeFakeSocket();
		let signalStarted: () => void = () => {};
		const startedPromise = new Promise<void>(r => {
			signalStarted = r;
		});
		let seenSignal: AbortSignal | undefined;
		const executor = vi.fn(async (input: {abortSignal?: AbortSignal}) => {
			seenSignal = input.abortSignal;
			signalStarted();
			await new Promise<void>(resolve => {
				input.abortSignal?.addEventListener('abort', () => resolve());
			});
		});

		const {deps} = makeDeps({stored});
		const pending = runRunnerCommand(
			{subcommand: '', subcommandArgs: [], flags: {}},
			{
				...deps,
				performRefresh: happyRefresh,
				makeInstanceSocketClient: fake.factory,
				executeRemoteAssignment:
					executor as unknown as typeof executeRemoteAssignment,
				waitForShutdown: () => startedPromise.then(() => 'SIGINT'),
			},
		);

		await new Promise(r => setTimeout(r, 0));
		fake.emitFrame({
			type: 'run.start',
			runId: 'run_drain',
			runSpec: {prompt: 'x'},
		});

		const code = await pending;
		expect(code).toBe(0);
		expect(executor).toHaveBeenCalledTimes(1);
		expect(seenSignal?.aborted).toBe(true);
		expect(fake.calls.closed.length).toBe(1);
	});

	it('ignores non-assignment frames', async () => {
		const fake = makeFakeSocket();
		const executor = vi.fn(async () => {});
		const {deps} = makeDeps({stored});
		const pending = runRunnerCommand(
			{subcommand: '', subcommandArgs: [], flags: {}},
			{
				...deps,
				performRefresh: happyRefresh,
				makeInstanceSocketClient: fake.factory,
				executeRemoteAssignment:
					executor as unknown as typeof executeRemoteAssignment,
				waitForShutdown: async () => 'SIGINT',
			},
		);
		await new Promise(r => setTimeout(r, 0));
		fake.emitFrame({type: 'ping', ts: 1});
		fake.emitFrame({type: 'stop', runId: 'x'});
		await pending;
		expect(executor).not.toHaveBeenCalled();
	});
});

describe('runRunnerCommand: doctor', () => {
	const stored: DashboardClientConfig = {
		dashboardUrl: 'https://example.com',
		instanceId: 'inst_1',
		refreshToken: 'old-refresh',
		fingerprint: 'fp-stored',
		pairedAt: 100,
		lastRefreshAt: 200,
	};

	const happyRefresh = async () => ({
		instanceId: 'inst_1',
		accessToken: 'access-token',
		expiresInSec: 900,
	});

	it('errors when not paired', async () => {
		const {deps, cap} = makeDeps({});
		const code = await runRunnerCommand(
			{subcommand: 'doctor', subcommandArgs: [], flags: {}},
			deps,
		);
		expect(code).toBe(1);
		expect(cap.out.join('\n')).toContain('not paired');
	});

	it('returns 0 when paired and no --runner is given', async () => {
		const {deps, cap} = makeDeps({stored});
		const code = await runRunnerCommand(
			{subcommand: 'doctor', subcommandArgs: [], flags: {}},
			{...deps, performRefresh: happyRefresh},
		);
		expect(code).toBe(0);
		expect(cap.out.join('\n')).toContain('paired to https://example.com');
	});

	it('passes when runner reports executionTarget=remote and remoteInstanceId matches', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				id: 'r1',
				executionTarget: 'remote',
				remoteInstanceId: 'inst_1',
			}),
		);
		const {deps, cap} = makeDeps({fetchMock, stored});
		const code = await runRunnerCommand(
			{subcommand: 'doctor', subcommandArgs: [], flags: {runner: 'r1'}},
			{...deps, performRefresh: happyRefresh},
		);
		expect(code).toBe(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe('https://example.com/api/runners/r1');
		expect((init as RequestInit).headers).toMatchObject({
			authorization: 'Bearer access-token',
		});
		expect(cap.out.join('\n')).toContain('runner r1 bound to this instance');
	});

	it('fails with a specific reason when remoteInstanceId mismatches', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				id: 'r1',
				executionTarget: 'remote',
				remoteInstanceId: 'inst_other',
			}),
		);
		const {deps, cap} = makeDeps({fetchMock, stored});
		const code = await runRunnerCommand(
			{subcommand: 'doctor', subcommandArgs: [], flags: {runner: 'r1'}},
			{...deps, performRefresh: happyRefresh},
		);
		expect(code).toBe(1);
		expect(cap.err.join('\n')).toContain('remoteInstanceId is "inst_other"');
	});

	it('fails with a specific reason when executionTarget is not remote', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				id: 'r1',
				executionTarget: 'local',
				remoteInstanceId: 'inst_1',
			}),
		);
		const {deps, cap} = makeDeps({fetchMock, stored});
		const code = await runRunnerCommand(
			{subcommand: 'doctor', subcommandArgs: [], flags: {runner: 'r1'}},
			{...deps, performRefresh: happyRefresh},
		);
		expect(code).toBe(1);
		expect(cap.err.join('\n')).toContain('executionTarget is "local"');
	});

	it('reports endpoint-missing on 404 from runner GET', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse(404, {error: 'not found'}));
		const {deps, cap} = makeDeps({fetchMock, stored});
		const code = await runRunnerCommand(
			{subcommand: 'doctor', subcommandArgs: [], flags: {runner: 'r1'}},
			{...deps, performRefresh: happyRefresh},
		);
		expect(code).toBe(1);
		expect(cap.err.join('\n')).toContain('runner not found');
	});

	it('emits structured JSON when --json is set', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				executionTarget: 'remote',
				remoteInstanceId: 'inst_1',
			}),
		);
		const {deps, cap} = makeDeps({fetchMock, stored});
		await runRunnerCommand(
			{
				subcommand: 'doctor',
				subcommandArgs: [],
				flags: {runner: 'r1', json: true},
			},
			{...deps, performRefresh: happyRefresh},
		);
		const parsed = JSON.parse(cap.out.join('\n'));
		expect(parsed).toMatchObject({
			ok: true,
			paired: true,
			instanceId: 'inst_1',
			dashboardUrl: 'https://example.com',
			runner: {id: 'r1', matches: true},
		});
	});
});

describe('runRunnerCommand: console migration stubs', () => {
	const stored: DashboardClientConfig = {
		dashboardUrl: 'http://localhost:3000',
		instanceId: 'inst_1',
		refreshToken: 'r',
		fingerprint: 'fp',
		pairedAt: 1,
	};

	it('returns a migration message for console link without writing sidecars', async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'console-stub-home-'));
		tmpDirs.push(home);
		process.env['HOME'] = home;
		const channelDir = path.join(home, '.config', 'athena', 'channels');
		const {deps, cap} = makeDeps({stored});
		const code = await runRunnerCommand(
			{subcommand: 'console', subcommandArgs: ['link', 'r1'], flags: {}},
			deps,
		);
		expect(code).toBe(1);
		expect(fs.existsSync(channelDir)).toBe(false);
		expect(cap.err.join('\n')).toContain('dashboard console is deprecated');
		expect(cap.err.join('\n')).toContain('paired dashboard feed sync');
	});

	it('returns the same migration message for console enable without probing runner health', async () => {
		const fetchMock = vi.fn();
		const {deps, cap} = makeDeps({stored});
		const code = await runRunnerCommand(
			{subcommand: 'console', subcommandArgs: ['enable', 'r1'], flags: {}},
			{...deps, fetch: fetchMock as unknown as typeof fetch},
		);
		expect(code).toBe(1);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(cap.err.join('\n')).toContain('dashboard console is deprecated');
	});

	it('emits structured migration JSON for console commands', async () => {
		const {deps, cap} = makeDeps({stored});
		const code = await runRunnerCommand(
			{
				subcommand: 'console',
				subcommandArgs: ['link', 'r1'],
				flags: {json: true},
			},
			deps,
		);
		expect(code).toBe(1);
		expect(JSON.parse(cap.out.join('\n'))).toEqual({
			ok: false,
			deprecated: true,
			message:
				'dashboard console is deprecated; paired dashboard feed sync now routes dashboard UI and channel decisions.',
		});
	});
});

describe('runRunnerCommand: unpair', () => {
	const storedConfig: DashboardClientConfig = {
		dashboardUrl: 'https://example.com',
		instanceId: 'inst_1',
		refreshToken: 'tok',
		fingerprint: 'fp',
		pairedAt: 1,
	};

	it('reports nothing-to-do when not paired', async () => {
		const {deps, cap, removed} = makeDeps({});
		const code = await runRunnerCommand(
			{subcommand: 'unpair', subcommandArgs: [], flags: {}},
			deps,
		);
		expect(code).toBe(0);
		expect(removed.count).toBe(0);
		expect(cap.out.join('\n')).toContain('not paired');
	});

	it('stops the runner, revokes server-side, and removes config', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({}),
			text: async () => '',
		});
		const {deps, cap, removed} = makeDeps({
			stored: storedConfig,
			fetchMock: fetchMock as unknown as ReturnType<typeof vi.fn>,
		});
		const stopRunner = vi.fn(async () => ({
			ok: true,
			wasRunning: true,
		}));
		const performRefresh = vi.fn(async () => ({
			instanceId: 'inst_1',
			accessToken: 'tok-access',
			expiresInSec: 900,
		}));

		const code = await runRunnerCommand(
			{subcommand: 'unpair', subcommandArgs: [], flags: {}},
			{...deps, stopRunner, performRefresh},
		);
		expect(code).toBe(0);
		expect(stopRunner).toHaveBeenCalledTimes(1);
		expect(removed.count).toBe(1);
		// Revoke endpoint hit with the correct instance id.
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/instances/inst_1/revoke'),
			expect.objectContaining({method: 'POST'}),
		);
		expect(cap.out.join('\n')).toContain('runner: stopped');
		expect(cap.out.join('\n')).toContain('refresh token revoked');
		expect(cap.out.join('\n')).toContain('credentials removed');
	});

	it('warns and still removes config when revoke fails', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
		const {deps, cap, removed} = makeDeps({
			stored: storedConfig,
			fetchMock: fetchMock as unknown as ReturnType<typeof vi.fn>,
		});
		const stopRunner = vi.fn(async () => ({
			ok: true,
			wasRunning: false,
		}));
		const performRefresh = vi.fn(async () => ({
			instanceId: 'inst_1',
			accessToken: 'tok-access',
			expiresInSec: 900,
		}));

		const code = await runRunnerCommand(
			{subcommand: 'unpair', subcommandArgs: [], flags: {}},
			{...deps, stopRunner, performRefresh},
		);
		// Local removal still succeeds — leaving paired-on-disk-but-unreachable
		// is worse UX than a brief server-side residue.
		expect(code).toBe(0);
		expect(removed.count).toBe(1);
		expect(cap.err.join('\n')).toContain('revoke failed');
		expect(cap.out.join('\n')).toContain('credentials removed');
	});
});

describe('runRunnerCommand: runs', () => {
	const stored: DashboardClientConfig = {
		dashboardUrl: 'https://example.com',
		instanceId: 'inst_1',
		refreshToken: 'r',
		fingerprint: 'fp',
		pairedAt: 1,
	};

	it('lists runs from the runner status file', async () => {
		const {deps, cap} = makeDeps({stored});
		const code = await runRunnerCommand(
			{subcommand: 'runs', subcommandArgs: [], flags: {}},
			{
				...deps,
				readRunnerStatus: () => ({
					running: true,
					status: {
						pid: 7,
						startedAt: 0,
						updatedAt: 1,
						socketConnected: true,
						activeRuns: 1,
						completedRuns: 1,
						runs: [
							{
								runId: 'run_1',
								startedAt: Date.now() - 30_000,
								endedAt: Date.now() - 10_000,
								status: 'completed',
							},
							{
								runId: 'run_2',
								startedAt: Date.now() - 5_000,
								status: 'running',
							},
						],
					},
				}),
			},
		);
		expect(code).toBe(0);
		expect(cap.out.join('\n')).toContain('run_1');
		expect(cap.out.join('\n')).toContain('run_2');
		expect(cap.out.join('\n')).toContain('running');
		expect(cap.out.join('\n')).toContain('completed');
	});

	it('exits 1 when the runner is not running', async () => {
		const {deps, cap} = makeDeps({stored});
		const code = await runRunnerCommand(
			{subcommand: 'runs', subcommandArgs: [], flags: {}},
			{
				...deps,
				readRunnerStatus: () => ({
					running: false,
					error: 'runner not running',
				}),
			},
		);
		expect(code).toBe(1);
		expect(cap.err.join('\n')).toContain('runner not running');
	});
});

describe('runRunnerCommand: --detach / stop / restart', () => {
	const stored: DashboardClientConfig = {
		dashboardUrl: 'https://example.com',
		instanceId: 'inst_1',
		refreshToken: 'r',
		fingerprint: 'fp',
		pairedAt: 1,
	};

	it('--detach spawns the runner and reports verified connection', async () => {
		const {deps, cap} = makeDeps({stored});
		const startDetachedRunner = vi.fn(async () => ({
			ok: true,
			connected: true,
			pid: 4123,
		}));
		const code = await runRunnerCommand(
			{subcommand: '', subcommandArgs: [], flags: {detach: true}},
			{...deps, startDetachedRunner},
		);
		expect(code).toBe(0);
		expect(startDetachedRunner).toHaveBeenCalledTimes(1);
		expect(cap.out.join('\n')).toContain('started and connected');
	});

	it('stop reports not-running when no pid file is held', async () => {
		const {deps, cap} = makeDeps({stored});
		const stopRunner = vi.fn(async () => ({
			ok: true,
			wasRunning: false,
			message: 'runner not running',
		}));
		const code = await runRunnerCommand(
			{subcommand: 'stop', subcommandArgs: [], flags: {}},
			{...deps, stopRunner},
		);
		expect(code).toBe(0);
		expect(cap.out.join('\n')).toContain('not running');
	});

	it('restart calls stop then start', async () => {
		const {deps} = makeDeps({stored});
		const stopRunner = vi.fn(async () => ({
			ok: true,
			wasRunning: true,
		}));
		const startDetachedRunner = vi.fn(async () => ({
			ok: true,
			connected: true,
		}));
		const code = await runRunnerCommand(
			{subcommand: 'restart', subcommandArgs: [], flags: {}},
			{...deps, stopRunner, startDetachedRunner},
		);
		expect(code).toBe(0);
		expect(stopRunner).toHaveBeenCalledTimes(1);
		expect(startDetachedRunner).toHaveBeenCalledTimes(1);
	});
});
