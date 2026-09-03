import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type RunnerStatePaths = {
	dir: string;
	/** `runner.pid` — liveness and the single-instance lock. */
	pidPath: string;
	/** `runner.log` — the rotating log the runner writes. */
	logPath: string;
	/**
	 * `runner.status.json` — the runner's snapshot, rewritten whenever it
	 * changes, read by `drisp runner status` / `runs`.
	 */
	statusPath: string;
	/** `runner.db` — the feed outbox and the decision inbox, one owner. */
	dbPath: string;
	/**
	 * The pid file of the pre-runner dashboard daemon. Honoured for one
	 * release so a daemon left running across the upgrade still counts as
	 * "already running" and can still be stopped.
	 */
	legacyPidPath: string;
	/** The control socket the dashboard daemon listened on; removed on start. */
	legacySocketPath: string;
};

/**
 * XDG state dir for the runner. Honors XDG_STATE_HOME, falls back to
 * ~/.local/state. Same path on macOS and linux because the runner's working
 * files are not user-visible documents — they belong with other CLI runtime
 * state.
 */
export function runnerStatePaths(
	env: NodeJS.ProcessEnv = process.env,
): RunnerStatePaths {
	const xdg = env['XDG_STATE_HOME'];
	const home = env['HOME'] ?? os.homedir();
	const base = xdg && xdg.length > 0 ? xdg : path.join(home, '.local', 'state');
	const dir = path.join(base, 'drisp');
	return {
		dir,
		pidPath: path.join(dir, 'runner.pid'),
		logPath: path.join(dir, 'runner.log'),
		statusPath: path.join(dir, 'runner.status.json'),
		dbPath: path.join(dir, 'runner.db'),
		legacyPidPath: path.join(dir, 'dashboard-daemon.pid'),
		legacySocketPath: path.join(dir, 'dashboard-daemon.sock'),
	};
}

/**
 * Creates the state dir at mode 0700 if missing. Idempotent. On non-POSIX
 * platforms `chmod` is a no-op which is fine — Windows has no equivalent.
 */
export function ensureRunnerStateDir(
	env: NodeJS.ProcessEnv = process.env,
): RunnerStatePaths {
	const paths = runnerStatePaths(env);
	fs.mkdirSync(paths.dir, {recursive: true, mode: 0o700});
	if (process.platform !== 'win32') {
		try {
			fs.chmodSync(paths.dir, 0o700);
		} catch {
			// best-effort — surfaces as a permission error later if needed
		}
	}
	return paths;
}
