import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startRunnerProcess} from '../runner/runnerProcess';

/**
 * The detached `drisp runner` entry: what `drisp runner --detach` spawns and
 * what the launchd / systemd unit runs. It is `startRunnerProcess` (pid file,
 * runner.db, instance socket, status file) plus signal handling; the
 * foreground `drisp runner` runs the same process in the CLI.
 *
 * Process model:
 *   - exit 0 on graceful shutdown (SIGTERM / SIGINT — `drisp runner stop`
 *     sends SIGTERM to the pid in the pid file)
 *   - exit 1 on fatal startup failure (already running, not paired, …)
 *   - the supervising launchd/systemd unit restart-loops on non-zero
 *
 * Bundled twice for one release: `dist/runner.js` (the `drisp-runner` bin)
 * and `dist/dashboard-daemon.js` (the `drisp-dashboard-daemon` bin a service
 * unit installed before 0.6 still points at).
 */
export async function runRunnerDaemonEntry(): Promise<number> {
	if (startedViaDeprecatedEntry()) {
		process.stderr.write(
			'drisp runner: started through the deprecated drisp-dashboard-daemon entry (removed in 0.7.0); run "drisp runner install" to refresh the service unit.\n',
		);
	}
	let runner;
	try {
		runner = await startRunnerProcess();
	} catch (err) {
		process.stderr.write(
			`drisp runner: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		return 1;
	}

	const reason = await new Promise<string>(resolve => {
		const onSignal = (signal: NodeJS.Signals): void => {
			process.off('SIGINT', onSignal);
			process.off('SIGTERM', onSignal);
			resolve(signal);
		};
		process.on('SIGINT', onSignal);
		process.on('SIGTERM', onSignal);
	});
	await runner.stop(reason);
	return 0;
}

function startedViaDeprecatedEntry(): boolean {
	try {
		return path
			.basename(fileURLToPath(import.meta.url))
			.startsWith('dashboard-daemon');
	} catch {
		return false;
	}
}

// This file is only ever a bundled entry (dist/runner.js, and for one release
// dist/dashboard-daemon.js); no other module imports it. Run on import.
void runRunnerDaemonEntry().then(code => {
	process.exit(code);
});
