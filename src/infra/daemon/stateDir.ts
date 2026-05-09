import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type DaemonStatePaths = {
	dir: string;
	pidPath: string;
	logPath: string;
	socketPath: string;
};

/**
 * XDG state dir for the daemon. Honors XDG_STATE_HOME, falls back to
 * ~/.local/state. Same path on macOS and linux because the daemon's working
 * files are not user-visible documents — they belong with other CLI runtime
 * state.
 */
export function daemonStatePaths(
	env: NodeJS.ProcessEnv = process.env,
): DaemonStatePaths {
	const xdg = env['XDG_STATE_HOME'];
	const home = env['HOME'] ?? os.homedir();
	const base = xdg && xdg.length > 0 ? xdg : path.join(home, '.local', 'state');
	const dir = path.join(base, 'drisp');
	return {
		dir,
		pidPath: path.join(dir, 'dashboard-daemon.pid'),
		logPath: path.join(dir, 'dashboard-daemon.log'),
		socketPath: path.join(dir, 'dashboard-daemon.sock'),
	};
}

/**
 * Creates the state dir at mode 0700 if missing. Idempotent. On non-POSIX
 * platforms `chmod` is a no-op which is fine — Windows has no equivalent.
 */
export function ensureDaemonStateDir(
	env: NodeJS.ProcessEnv = process.env,
): DaemonStatePaths {
	const paths = daemonStatePaths(env);
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
