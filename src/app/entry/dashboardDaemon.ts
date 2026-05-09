import {runDashboardRuntimeDaemon} from '../dashboard/runtimeDaemon';
import {refreshDashboardAccessToken} from '../../infra/config/dashboardAuth';
import {readDashboardClientConfig} from '../../infra/config/dashboardClient';
import {acquirePidLock} from '../../infra/daemon/pidLock';
import {openDaemonLog} from '../../infra/daemon/logFile';
import {ensureDaemonStateDir} from '../../infra/daemon/stateDir';
import {
	startUdsServer,
	type UdsHandler,
	type UdsResponse,
} from '../../infra/daemon/udsIpc';

/**
 * Dedicated daemon entry. Boots the dashboard runtime daemon as a long-running
 * background process: acquires the pid lock, opens the rotating log, runs the
 * runtime, and serves UDS IPC for `dashboard status|logs|runs|stop` etc.
 *
 * Process model:
 *   - exit 0 on graceful shutdown (SIGTERM/SIGINT or UDS `stop`)
 *   - exit 1 on fatal startup failure (lock contention, config missing, …)
 *   - the supervising launchd/systemd unit restart-loops on non-zero
 */
export async function runDashboardDaemonEntry(): Promise<number> {
	const stateDir = ensureDaemonStateDir();
	const writer = openDaemonLog(stateDir.logPath);
	const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
		writer.write(level, message);

	let pidLock;
	try {
		pidLock = acquirePidLock(stateDir.pidPath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', `daemon startup: ${message}`);
		writer.close();
		process.stderr.write(`drisp dashboard daemon: ${message}\n`);
		return 1;
	}

	const config = readDashboardClientConfig();
	if (!config) {
		log('error', 'daemon startup: not paired');
		pidLock.release();
		writer.close();
		process.stderr.write(
			'drisp dashboard daemon: not paired. Run "drisp dashboard pair" first.\n',
		);
		return 1;
	}

	let stopReason = 'sigterm';
	const stopSignal = createDeferred<string>();

	let daemonHandle: Awaited<
		ReturnType<typeof runDashboardRuntimeDaemon>
	> | null = null;
	try {
		daemonHandle = await runDashboardRuntimeDaemon({
			log,
			refreshAccessToken: async () => refreshDashboardAccessToken({}),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log('error', `runtime startup failed: ${message}`);
		pidLock.release();
		writer.close();
		process.stderr.write(`drisp dashboard daemon: ${message}\n`);
		return 1;
	}

	const handler: UdsHandler = req => {
		if (!daemonHandle) {
			return {ok: false, error: 'daemon shutting down'} satisfies UdsResponse;
		}
		switch (req.cmd) {
			case 'status': {
				const snap = daemonHandle.snapshot();
				return {
					ok: true,
					cmd: 'status',
					pid: pidLock.pid,
					...snap,
				} satisfies UdsResponse;
			}
			case 'runs': {
				const runs = daemonHandle.listRuns({
					...(req.active === true ? {active: true} : {}),
					...(typeof req.limit === 'number' ? {limit: req.limit} : {}),
				});
				return {ok: true, cmd: 'runs', runs} satisfies UdsResponse;
			}
			case 'reload': {
				// No persistent in-memory state currently warrants a reload beyond
				// what reconnect does. Accepted as a no-op for forward
				// compatibility.
				return {ok: true, cmd: 'reload'} satisfies UdsResponse;
			}
			case 'restart': {
				stopReason = req.cmd;
				stopSignal.resolve('restart');
				return {ok: true, cmd: 'restart'} satisfies UdsResponse;
			}
			case 'stop': {
				stopReason = req.reason ?? 'stop';
				stopSignal.resolve('stop');
				return {ok: true, cmd: 'stop'} satisfies UdsResponse;
			}
			default: {
				const _exhaustive: never = req;
				return {
					ok: false,
					error: `unknown command: ${JSON.stringify(_exhaustive)}`,
				} satisfies UdsResponse;
			}
		}
	};

	const udsServer = await startUdsServer(stateDir.socketPath, handler, log);
	log('info', `dashboard daemon listening on ${stateDir.socketPath}`);

	const onSignal = (signal: NodeJS.Signals): void => {
		log('info', `received ${signal}`);
		stopReason = signal;
		stopSignal.resolve(signal);
	};
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);

	const reason = await stopSignal.promise;
	process.off('SIGINT', onSignal);
	process.off('SIGTERM', onSignal);

	log('info', `daemon stopping: ${reason}`);
	// Always release the pid lock and close the log writer, even if the
	// runtime stop or UDS close throws. A stuck pid file is the worst
	// outcome here — it blocks the next daemon start.
	try {
		await daemonHandle.stop(reason);
	} catch (err) {
		log(
			'warn',
			`runtime stop failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	try {
		await udsServer.close();
	} catch (err) {
		log(
			'warn',
			`uds close failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	pidLock.release();
	log('info', `daemon stopped: ${stopReason}`);
	writer.close();

	// Exit 0 on stop/restart/signal; supervisor restart-loops on non-zero.
	return 0;
}

type Deferred<T> = {
	promise: Promise<T>;
	resolve(value: T): void;
};

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(r => {
		resolve = r;
	});
	let settled = false;
	return {
		promise,
		resolve(value: T) {
			if (settled) return;
			settled = true;
			resolve(value);
		},
	};
}

// This file is only ever the bundled entry at dist/dashboard-daemon.js (no
// other module imports it). Run on import — the build target sets argv to it.
void runDashboardDaemonEntry().then(code => {
	process.exit(code);
});
