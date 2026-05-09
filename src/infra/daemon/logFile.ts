import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type DaemonLogger = (level: LogLevel, message: string) => void;

export type DaemonLogWriter = {
	write: DaemonLogger;
	close(): void;
	readonly path: string;
};

export type OpenDaemonLogOptions = {
	maxBytes?: number;
	maxFiles?: number;
	now?: () => Date;
};

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

/**
 * Append-only log writer with size-based rotation.
 *
 * - Writes plain text lines: `<iso-ts> <LEVEL> <message>\n`.
 * - Rotates when the file would grow past `maxBytes` (default 5 MB).
 * - Keeps `maxFiles` rotated copies (`.log.1` ... `.log.N`); older ones
 *   are dropped.
 * - Redacts common secret-shaped tokens before writing. Conservative
 *   patterns: `Bearer …`, `access_token=…`, `refresh_token=…`,
 *   `Sec-WebSocket-Protocol: …`, and any standalone JWT-shaped string.
 *
 * Synchronous fs APIs intentionally — daemon logging is low-volume and a
 * sync write avoids interleaved partial lines under concurrent writers.
 */
export function openDaemonLog(
	logPath: string,
	options: OpenDaemonLogOptions = {},
): DaemonLogWriter {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
	const now = options.now ?? (() => new Date());

	fs.mkdirSync(path.dirname(logPath), {recursive: true, mode: 0o700});
	let fd = fs.openSync(logPath, 'a', 0o600);
	if (process.platform !== 'win32') {
		try {
			fs.chmodSync(logPath, 0o600);
		} catch {
			// best-effort
		}
	}

	function rotate(): void {
		try {
			fs.closeSync(fd);
		} catch {
			// best-effort
		}
		for (let i = maxFiles - 1; i >= 1; i -= 1) {
			const src = `${logPath}.${i}`;
			const dst = `${logPath}.${i + 1}`;
			try {
				fs.renameSync(src, dst);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
					// best-effort
				}
			}
		}
		try {
			fs.renameSync(logPath, `${logPath}.1`);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
				// best-effort
			}
		}
		fd = fs.openSync(logPath, 'a', 0o600);
		if (process.platform !== 'win32') {
			try {
				fs.chmodSync(logPath, 0o600);
			} catch {
				// best-effort
			}
		}
	}

	function write(level: LogLevel, message: string): void {
		const line = `${now().toISOString()} ${level.toUpperCase()} ${redactSecrets(message)}\n`;
		const buf = Buffer.from(line, 'utf-8');
		let stat: fs.Stats | null = null;
		try {
			stat = fs.fstatSync(fd);
		} catch {
			// fd may have been invalidated by external rotation — fall through to a reopen
		}
		if (stat && stat.size + buf.length > maxBytes) {
			rotate();
		}
		try {
			fs.writeSync(fd, buf);
		} catch {
			// Try once more after reopen — covers the rare case where the file
			// was rotated/removed by an external observer. If the second write
			// also fails, drop the line rather than crashing the daemon: a
			// failing logger must not bring down the process.
			try {
				fs.closeSync(fd);
			} catch {
				// best-effort
			}
			try {
				fd = fs.openSync(logPath, 'a', 0o600);
				fs.writeSync(fd, buf);
			} catch {
				// nothing more we can do; daemon stays up, line is lost
			}
		}
	}

	function close(): void {
		try {
			fs.closeSync(fd);
		} catch {
			// best-effort
		}
	}

	return {write, close, path: logPath};
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
	[/Bearer\s+[A-Za-z0-9._\-+/=]+/g, 'Bearer ***'],
	[
		/(["']?(?:access|refresh)_?token["']?\s*[:=]\s*)["']?[A-Za-z0-9._\-+/=]+/gi,
		'$1"***"',
	],
	[/(Sec-WebSocket-Protocol:\s*)\S+/gi, '$1***'],
	[
		/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
		'***.***.***',
	],
];

export function redactSecrets(message: string): string {
	let out = message;
	for (const [pattern, replacement] of SECRET_PATTERNS) {
		out = out.replace(pattern, replacement);
	}
	return out;
}
