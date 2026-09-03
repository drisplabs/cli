import fs from 'node:fs';
import path from 'node:path';
import type {
	RuntimeDaemonRunRecord,
	RuntimeDaemonSnapshot,
} from '../dashboard/runtimeDaemon';

/**
 * `runner.status.json` — how the runner exposes its snapshot without a
 * control socket. The runner rewrites the file (atomically: temp file, fsync,
 * rename) whenever the snapshot changes, checked on a short interval and
 * forced at the transitions it knows about; `drisp runner status` and
 * `drisp runner runs` read it beside the pid file. The pid file is the
 * liveness authority — a status file whose `pid` does not match the live
 * pid is stale and is ignored. The runner removes the file on a clean stop.
 */
export type RunnerStatusSnapshot = RuntimeDaemonSnapshot & {
	pid: number;
	/** The run records the runner keeps (a ring of the last 100). */
	runs: RuntimeDaemonRunRecord[];
};

export type RunnerStatus = RunnerStatusSnapshot & {
	/** When the runner last rewrote the file. */
	updatedAt: number;
};

export type RunnerStatusWriter = {
	/** Rewrite the file now if the snapshot changed since the last write. */
	flush(): void;
	/** Stop the interval and remove the file. Idempotent. */
	close(): void;
};

export type CreateRunnerStatusWriterOptions = {
	path: string;
	status: () => RunnerStatusSnapshot;
	/** How often the snapshot is checked for a change. Default 1000ms. */
	intervalMs?: number;
	now?: () => number;
	onError?: (message: string) => void;
};

const DEFAULT_STATUS_INTERVAL_MS = 1_000;

export function readRunnerStatusFile(statusPath: string): RunnerStatus | null {
	let raw: string;
	try {
		raw = fs.readFileSync(statusPath, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const obj = parsed as Record<string, unknown>;
	if (
		typeof obj['pid'] !== 'number' ||
		typeof obj['startedAt'] !== 'number' ||
		typeof obj['updatedAt'] !== 'number' ||
		typeof obj['socketConnected'] !== 'boolean' ||
		typeof obj['activeRuns'] !== 'number' ||
		typeof obj['completedRuns'] !== 'number' ||
		!Array.isArray(obj['runs'])
	) {
		return null;
	}
	return parsed as RunnerStatus;
}

export function writeRunnerStatusFile(
	statusPath: string,
	status: RunnerStatus,
): void {
	fs.mkdirSync(path.dirname(statusPath), {recursive: true, mode: 0o700});
	const tmpPath = `${statusPath}.${process.pid}.tmp`;
	const fd = fs.openSync(tmpPath, 'w', 0o600);
	try {
		fs.writeSync(fd, JSON.stringify(status) + '\n');
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	try {
		fs.renameSync(tmpPath, statusPath);
	} catch (err) {
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			// best-effort cleanup; the rename error is what matters
		}
		throw err;
	}
}

export function removeRunnerStatusFile(statusPath: string): void {
	try {
		fs.unlinkSync(statusPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}
}

export function createRunnerStatusWriter(
	options: CreateRunnerStatusWriterOptions,
): RunnerStatusWriter {
	const now = options.now ?? (() => Date.now());
	const onError = options.onError ?? (() => {});
	let lastWritten: string | null = null;
	let closed = false;

	function flush(): void {
		if (closed) return;
		let snapshot: RunnerStatusSnapshot;
		try {
			snapshot = options.status();
		} catch (err) {
			onError(
				`runner status snapshot failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return;
		}
		const serialized = JSON.stringify(snapshot);
		if (serialized === lastWritten) return;
		try {
			writeRunnerStatusFile(options.path, {...snapshot, updatedAt: now()});
			lastWritten = serialized;
		} catch (err) {
			onError(
				`runner status write failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	const timer = setInterval(
		flush,
		options.intervalMs ?? DEFAULT_STATUS_INTERVAL_MS,
	);
	timer.unref();

	return {
		flush,
		close() {
			if (closed) return;
			closed = true;
			clearInterval(timer);
			try {
				removeRunnerStatusFile(options.path);
			} catch (err) {
				onError(
					`runner status remove failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		},
	};
}
