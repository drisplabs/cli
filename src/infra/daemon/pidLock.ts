import fs from 'node:fs';

export type PidLockHandle = {
	/** PID currently holding the lock (this process). */
	readonly pid: number;
	/** Release the lock and remove the pid file. Idempotent. */
	release(): void;
};

export type PidLockReadResult =
	| {state: 'absent'}
	| {state: 'stale'; pid: number}
	| {state: 'held'; pid: number};

/**
 * POSIX-style exclusive pid lock.
 *
 * `O_EXCL | O_CREAT` gives us atomic ownership of the path: if the file
 * already exists the open fails. We then write our pid + newline so a
 * second instance — or any tool — can identify the holder.
 *
 * Stale-lock detection uses `kill(pid, 0)`. If the recorded pid no longer
 * exists, we forcibly remove the file and retry once. This handles `kill -9`
 * scenarios where the previous daemon never got to clean up.
 *
 * On Windows we fall back to existence-only locking (no `kill(pid, 0)`),
 * which is best-effort but matches the rest of the codebase's POSIX bias.
 */
export function acquirePidLock(pidPath: string): PidLockHandle {
	const ownPid = process.pid;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const fd = fs.openSync(pidPath, 'wx', 0o600);
			try {
				fs.writeSync(fd, `${ownPid}\n`);
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			return makeHandle(pidPath, ownPid);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
		}
		const existing = readPidLock(pidPath);
		if (existing.state === 'held') {
			throw new Error(
				`dashboard daemon is already running as pid ${existing.pid}` +
					` (lock at ${pidPath}). Use "drisp dashboard daemon stop" to terminate it.`,
			);
		}
		if (existing.state === 'stale') {
			try {
				fs.unlinkSync(pidPath);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
			}
			continue;
		}
		// 'absent' means the lock vanished between EEXIST and read — retry.
	}
	throw new Error(
		`dashboard daemon: failed to acquire pid lock at ${pidPath} after retry`,
	);
}

export function readPidLock(pidPath: string): PidLockReadResult {
	let raw: string;
	try {
		raw = fs.readFileSync(pidPath, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return {state: 'absent'};
		}
		throw err;
	}
	const pid = Number.parseInt(raw.trim(), 10);
	if (!Number.isFinite(pid) || pid <= 0) {
		return {state: 'stale', pid: 0};
	}
	if (!isProcessAlive(pid)) {
		return {state: 'stale', pid};
	}
	return {state: 'held', pid};
}

function makeHandle(pidPath: string, pid: number): PidLockHandle {
	let released = false;
	return {
		pid,
		release(): void {
			if (released) return;
			released = true;
			try {
				const raw = fs.readFileSync(pidPath, 'utf-8').trim();
				if (raw === String(pid)) {
					fs.unlinkSync(pidPath);
				}
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
					// best-effort — the process is exiting anyway
				}
			}
		},
	};
}

function isProcessAlive(pid: number): boolean {
	if (process.platform === 'win32') {
		// No reliable cheap signal-0 equivalent; assume held to be safe.
		return true;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'EPERM') {
			// Process exists but we don't own it — treat as held.
			return true;
		}
		return false;
	}
}
