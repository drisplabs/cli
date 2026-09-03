import fs from 'node:fs';
import {
	runDashboardRuntimeDaemon,
	type RunDashboardRuntimeDaemonOptions,
	type RuntimeDaemonHandle,
	type RuntimeDaemonRunRecord,
	type RuntimeDaemonSnapshot,
} from '../dashboard/runtimeDaemon';
import {createDashboardFeedOutbox} from '../dashboard/dashboardFeedPublisher';
import {createPairedFeedPublisher} from '../dashboard/pairedFeedPublisher';
import {createDashboardDecisionInbox} from '../dashboard/dashboardDecisionInbox';
import type {InstanceSocketLogger} from '../dashboard/instanceSocketClient';
import {refreshDashboardAccessToken} from '../../infra/config/dashboardAuth';
import {readDashboardClientConfig} from '../../infra/config/dashboardClient';
import {
	acquirePidLock,
	alreadyRunningMessage,
	readPidLock,
	type PidLockHandle,
} from '../../infra/daemon/pidLock';
import {openDaemonLog, type DaemonLogWriter} from '../../infra/daemon/logFile';
import {
	ensureRunnerStateDir,
	type RunnerStatePaths,
} from '../../infra/daemon/stateDir';
import {openRunnerDb, type RunnerDb} from './runnerDb';
import {
	createRunnerStatusWriter,
	type RunnerStatusSnapshot,
	type RunnerStatusWriter,
} from './runnerStatusFile';

/**
 * The `drisp runner` process: one long-lived process per machine that pairs
 * with the hub over the instance socket and executes the Runs it assigns.
 *
 * What it owns, in the order it takes them on start (and releases in reverse
 * on stop):
 *
 *   1. the log file (`runner.log`);
 *   2. the pid file (`runner.pid`) — liveness and the single-instance lock. A
 *      second runner on the same machine fails here with
 *      `already running (pid N)`. The pre-runner `dashboard-daemon.pid` is
 *      honoured for one release, and its control socket file removed;
 *   3. `runner.db` — the feed outbox and the decision inbox, one open handle
 *      shared by both (ADR 0006), with the legacy standalone stores imported
 *      on the first open;
 *   4. the instance-socket runtime (`runDashboardRuntimeDaemon`);
 *   5. the status file (`runner.status.json`) — the snapshot, rewritten on
 *      change, that `drisp runner status` reads in place of a control socket.
 *
 * Events leave the machine only over the instance socket; the runner has no
 * second transport. The foreground `drisp runner` and the detached / service
 * unit entry run exactly this; they differ only in where log lines also go.
 */

export class RunnerStartupError extends Error {
	constructor(
		message: string,
		readonly exitCode: number = 1,
	) {
		super(message);
		this.name = 'RunnerStartupError';
	}
}

export type RunnerProcessOptions = Pick<
	RunDashboardRuntimeDaemonOptions,
	| 'readConfig'
	| 'refreshAccessToken'
	| 'makeInstanceSocketClient'
	| 'executeRemoteAssignment'
	| 'fetchAttachments'
	| 'writeMirror'
	| 'retryInitialConnect'
	| 'reconnectDelaysMs'
	| 'projectDir'
	| 'workflowStoreDir'
	| 'cliVersion'
	| 'feedDrainIntervalMs'
	| 'maxConcurrentRuns'
	| 'now'
> & {
	/** Defaults to the runner state dir under XDG_STATE_HOME / ~/.local/state. */
	statePaths?: RunnerStatePaths;
	/**
	 * A second log sink beside the log file. The foreground command mirrors
	 * lines to the terminal through it; the detached entry passes none.
	 */
	log?: InstanceSocketLogger;
	/** How often the status file is checked for a change. Default 1000ms. */
	statusIntervalMs?: number;
};

export type RunnerProcessHandle = {
	readonly pid: number;
	readonly statePaths: RunnerStatePaths;
	snapshot(): RuntimeDaemonSnapshot;
	listRuns(options?: {
		active?: boolean;
		limit?: number;
	}): RuntimeDaemonRunRecord[];
	/** Graceful stop: releases everything in reverse order. Idempotent. */
	stop(reason?: string): Promise<void>;
};

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function removeIfPresent(filePath: string): void {
	try {
		fs.unlinkSync(filePath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}
}

/**
 * The pre-runner dashboard daemon left `dashboard-daemon.pid` and a control
 * socket. A live one counts as "already running"; a stale one is reaped along
 * with the socket file.
 */
function reapLegacyDaemon(paths: RunnerStatePaths, log: InstanceSocketLogger) {
	const legacy = readPidLock(paths.legacyPidPath);
	if (legacy.state === 'held') {
		throw new RunnerStartupError(
			alreadyRunningMessage(legacy.pid, paths.legacyPidPath),
		);
	}
	if (legacy.state === 'stale') {
		removeIfPresent(paths.legacyPidPath);
		log(
			'info',
			`reaped stale dashboard-daemon pid file ${paths.legacyPidPath}`,
		);
	}
	removeIfPresent(paths.legacySocketPath);
}

export async function startRunnerProcess(
	options: RunnerProcessOptions = {},
): Promise<RunnerProcessHandle> {
	const paths = options.statePaths ?? ensureRunnerStateDir();
	fs.mkdirSync(paths.dir, {recursive: true, mode: 0o700});
	const writer: DaemonLogWriter = openDaemonLog(paths.logPath);
	const mirror = options.log ?? (() => {});
	const log: InstanceSocketLogger = (level, message) => {
		writer.write(level, message);
		mirror(level, message);
	};
	const readConfig = options.readConfig ?? (() => readDashboardClientConfig());
	const refreshAccessToken =
		options.refreshAccessToken ?? (async () => refreshDashboardAccessToken({}));
	const now = options.now ?? (() => Date.now());

	let pidLock: PidLockHandle | null = null;
	let runnerDb: RunnerDb | null = null;
	let daemon: RuntimeDaemonHandle | null = null;
	let statusWriter: RunnerStatusWriter | null = null;
	let publisher: ReturnType<typeof createPairedFeedPublisher> | null = null;
	let stopped = false;

	// Release in reverse order of acquisition; every step is best-effort so a
	// failure in one never leaves the pid file behind (a stuck pid file blocks
	// the next start, which is the worst outcome here).
	async function release(reason: string): Promise<void> {
		if (statusWriter) {
			statusWriter.close();
			statusWriter = null;
		}
		if (daemon) {
			try {
				await daemon.stop(reason);
			} catch (err) {
				log('warn', `runtime stop failed: ${errorMessage(err)}`);
			}
			daemon = null;
		}
		publisher?.close();
		publisher = null;
		runnerDb?.close();
		runnerDb = null;
		pidLock?.release();
		pidLock = null;
	}

	async function fail(err: unknown): Promise<never> {
		const message = errorMessage(err);
		log('error', `runner startup: ${message}`);
		await release('startup-failed');
		writer.close();
		throw err instanceof RunnerStartupError
			? err
			: new RunnerStartupError(message);
	}

	try {
		reapLegacyDaemon(paths, log);
		pidLock = acquirePidLock(paths.pidPath);
	} catch (err) {
		return fail(err);
	}

	if (!readConfig()) {
		return fail(
			new RunnerStartupError('not paired. Run "drisp runner pair" first.'),
		);
	}

	try {
		runnerDb = openRunnerDb({dbPath: paths.dbPath, log});
		const outbox = createDashboardFeedOutbox({db: runnerDb.db});
		const decisionInbox = createDashboardDecisionInbox({db: runnerDb.db});
		publisher = createPairedFeedPublisher({
			readConfig,
			outbox,
			now,
			onError: message => log('warn', message),
			...(options.feedDrainIntervalMs !== undefined
				? {drainIntervalMs: options.feedDrainIntervalMs}
				: {}),
		});
		daemon = await runDashboardRuntimeDaemon({
			readConfig,
			refreshAccessToken,
			log,
			pairedFeedPublisher: publisher,
			decisionInbox,
			now,
			...(options.makeInstanceSocketClient
				? {makeInstanceSocketClient: options.makeInstanceSocketClient}
				: {}),
			...(options.executeRemoteAssignment
				? {executeRemoteAssignment: options.executeRemoteAssignment}
				: {}),
			...(options.fetchAttachments
				? {fetchAttachments: options.fetchAttachments}
				: {}),
			...(options.writeMirror ? {writeMirror: options.writeMirror} : {}),
			...(options.retryInitialConnect !== undefined
				? {retryInitialConnect: options.retryInitialConnect}
				: {}),
			...(options.reconnectDelaysMs
				? {reconnectDelaysMs: options.reconnectDelaysMs}
				: {}),
			...(options.projectDir ? {projectDir: options.projectDir} : {}),
			...(options.workflowStoreDir
				? {workflowStoreDir: options.workflowStoreDir}
				: {}),
			...(options.cliVersion ? {cliVersion: options.cliVersion} : {}),
			...(options.maxConcurrentRuns !== undefined
				? {maxConcurrentRuns: options.maxConcurrentRuns}
				: {}),
		});
	} catch (err) {
		return fail(err);
	}

	const pid = pidLock.pid;
	const runtime = daemon;
	const status = (): RunnerStatusSnapshot => ({
		pid,
		...runtime.snapshot(),
		runs: runtime.listRuns(),
	});
	statusWriter = createRunnerStatusWriter({
		path: paths.statusPath,
		status,
		now,
		onError: message => log('warn', message),
		...(options.statusIntervalMs !== undefined
			? {intervalMs: options.statusIntervalMs}
			: {}),
	});
	statusWriter.flush();
	log('info', `runner started (pid ${pid}); state in ${paths.dir}`);

	return {
		pid,
		statePaths: paths,
		snapshot: () => runtime.snapshot(),
		listRuns: opts => runtime.listRuns(opts),
		async stop(reason = 'stopped') {
			if (stopped) return;
			stopped = true;
			log('info', `runner stopping: ${reason}`);
			await release(reason);
			log('info', `runner stopped: ${reason}`);
			writer.close();
		},
	};
}
