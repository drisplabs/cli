import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {CanonicalFrame} from '@drisp/protocol';
import type {InstanceSocketClient} from '../dashboard/instanceSocketClient';
import type {DashboardClientConfig} from '../../infra/config/dashboardClient';
import {
	ensureRunnerStateDir,
	type RunnerStatePaths,
} from '../../infra/daemon/stateDir';
import {readPidLock} from '../../infra/daemon/pidLock';
import {readRunnerStatusFile} from './runnerStatusFile';
import {
	RunnerStartupError,
	startRunnerProcess,
	type RunnerProcessHandle,
} from './runnerProcess';

const tmpDirs: string[] = [];
const handles: RunnerProcessHandle[] = [];
let statePaths: RunnerStatePaths;

beforeEach(() => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-process-'));
	tmpDirs.push(dir);
	statePaths = ensureRunnerStateDir({XDG_STATE_HOME: dir, HOME: dir});
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json({attachments: []})),
	);
});

afterEach(async () => {
	vi.unstubAllGlobals();
	for (const handle of handles.splice(0)) {
		await handle.stop('test teardown');
	}
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

const stored: DashboardClientConfig = {
	dashboardUrl: 'https://example.com',
	instanceId: 'inst_1',
	refreshToken: 'refresh',
	fingerprint: 'fp',
	pairedAt: 1,
};

function makeFakeSocket() {
	const frameHandlers: Array<(frame: CanonicalFrame) => void> = [];
	const calls = {connect: 0, close: [] as string[]};
	const client: InstanceSocketClient = {
		connect: async () => {
			calls.connect += 1;
		},
		close: (reason?: string) => calls.close.push(reason ?? ''),
		onFrame: handler => {
			frameHandlers.push(handler);
		},
		onClose: () => {},
		wireMode: () => 'legacy',
		sendAssignmentAccepted: () => {},
		sendAssignmentRejected: () => {},
		sendRunEvent: () => {},
		sendNeedsHuman: () => {},
		sendFeedEvent: () => {},
		sendDecisionAck: () => {},
		sendWorkflowsChanged: () => {},
	};
	return {
		client,
		calls,
		emitFrame: (frame: CanonicalFrame) => {
			for (const handler of frameHandlers) handler(frame);
		},
	};
}

async function start(
	overrides: Partial<Parameters<typeof startRunnerProcess>[0]> = {},
): Promise<RunnerProcessHandle> {
	const fake = makeFakeSocket();
	const handle = await startRunnerProcess({
		statePaths,
		readConfig: () => stored,
		refreshAccessToken: async () => ({
			instanceId: 'inst_1',
			accessToken: 'a',
			expiresInSec: 900,
		}),
		makeInstanceSocketClient: () => fake.client,
		executeRemoteAssignment: vi.fn(async () => {}),
		writeMirror: () => {},
		reconnectDelaysMs: [],
		statusIntervalMs: 20,
		...overrides,
	});
	handles.push(handle);
	return handle;
}

describe('startRunnerProcess', () => {
	it('holds the pid file, owns runner.db, and reports itself in the status file until stopped', async () => {
		const handle = await start();
		expect(handle.pid).toBe(process.pid);
		expect(readPidLock(statePaths.pidPath)).toEqual({
			state: 'held',
			pid: process.pid,
		});
		expect(fs.existsSync(statePaths.dbPath)).toBe(true);
		expect(fs.existsSync(statePaths.logPath)).toBe(true);
		expect(readRunnerStatusFile(statePaths.statusPath)).toMatchObject({
			pid: process.pid,
			socketConnected: true,
			instanceId: 'inst_1',
			dashboardUrl: 'https://example.com',
			activeRuns: 0,
			completedRuns: 0,
			runs: [],
		});
		expect(handle.snapshot()).toMatchObject({
			socketConnected: true,
			instanceId: 'inst_1',
		});

		await handle.stop('test');
		handles.splice(0);
		expect(readPidLock(statePaths.pidPath)).toEqual({state: 'absent'});
		expect(fs.existsSync(statePaths.statusPath)).toBe(false);
		expect(fs.readFileSync(statePaths.logPath, 'utf-8')).toMatch(
			/runner stopped: test/,
		);
		// A second stop is a no-op.
		await handle.stop('again');
	});

	it('refuses a second runner with "already running (pid N)" and leaves the first untouched', async () => {
		await start();
		await expect(start()).rejects.toThrow(
			new RegExp(`already running \\(pid ${process.pid}\\)`),
		);
		await expect(start()).rejects.toBeInstanceOf(RunnerStartupError);
		expect(readPidLock(statePaths.pidPath)).toEqual({
			state: 'held',
			pid: process.pid,
		});
		expect(readRunnerStatusFile(statePaths.statusPath)?.pid).toBe(process.pid);
	});

	it('honours a pre-runner dashboard-daemon pid file for one release', async () => {
		fs.writeFileSync(statePaths.legacyPidPath, `${process.pid}\n`);
		await expect(start()).rejects.toThrow(
			new RegExp(`already running \\(pid ${process.pid}\\)`),
		);
		expect(fs.existsSync(statePaths.pidPath)).toBe(false);

		// A stale legacy pid file and its control socket are cleaned up.
		fs.writeFileSync(statePaths.legacyPidPath, '987654321\n');
		fs.writeFileSync(statePaths.legacySocketPath, '');
		await start();
		expect(fs.existsSync(statePaths.legacyPidPath)).toBe(false);
		expect(fs.existsSync(statePaths.legacySocketPath)).toBe(false);
		expect(readPidLock(statePaths.pidPath)).toEqual({
			state: 'held',
			pid: process.pid,
		});
	});

	it('exits with "not paired" and holds nothing when there is no pairing', async () => {
		await expect(start({readConfig: () => null})).rejects.toThrow(/not paired/);
		expect(fs.existsSync(statePaths.pidPath)).toBe(false);
		expect(fs.existsSync(statePaths.statusPath)).toBe(false);
	});

	it('records admitted Runs in the status file', async () => {
		const fake = makeFakeSocket();
		let finishRun: () => void = () => {};
		const running = new Promise<void>(resolve => {
			finishRun = resolve;
		});
		const handle = await start({
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: async () => {
				await running;
			},
		});
		fake.emitFrame({
			type: 'run.start',
			runId: 'run_status_1',
			runSpec: {prompt: 'hello', projectDir: statePaths.dir},
		});
		await vi.waitFor(() => {
			expect(readRunnerStatusFile(statePaths.statusPath)).toMatchObject({
				activeRuns: 1,
				runs: [expect.objectContaining({runId: 'run_status_1'})],
			});
		});
		expect(handle.listRuns()).toEqual([
			expect.objectContaining({runId: 'run_status_1', status: 'running'}),
		]);
		finishRun();
		await vi.waitFor(() => {
			expect(readRunnerStatusFile(statePaths.statusPath)).toMatchObject({
				activeRuns: 0,
				completedRuns: 1,
				runs: [
					expect.objectContaining({runId: 'run_status_1', status: 'completed'}),
				],
			});
		});
	});
});
