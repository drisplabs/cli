import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {openDaemonLog, redactSecrets} from './logFile';

let tmpDir: string;
let logPath: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logfile-'));
	logPath = path.join(tmpDir, 'daemon.log');
});

afterEach(() => {
	try {
		fs.rmSync(tmpDir, {recursive: true, force: true});
	} catch {
		// best-effort
	}
});

describe('openDaemonLog', () => {
	it('appends lines with iso timestamp and level', () => {
		const writer = openDaemonLog(logPath, {now: () => new Date(0)});
		writer.write('info', 'hello');
		writer.write('warn', 'world');
		writer.close();
		const content = fs.readFileSync(logPath, 'utf-8');
		expect(content).toContain('1970-01-01T00:00:00.000Z INFO hello');
		expect(content).toContain('1970-01-01T00:00:00.000Z WARN world');
	});

	it('rotates when size exceeds maxBytes', () => {
		const writer = openDaemonLog(logPath, {
			maxBytes: 200,
			maxFiles: 3,
		});
		// Write enough to force at least one rotation.
		for (let i = 0; i < 10; i += 1) {
			writer.write('info', 'x'.repeat(40));
		}
		writer.close();
		expect(fs.existsSync(`${logPath}.1`)).toBe(true);
		// Current file is fresh after rotation
		const current = fs.readFileSync(logPath, 'utf-8');
		expect(current.length).toBeLessThanOrEqual(200 + 80);
	});

	it('redacts Bearer tokens', () => {
		const writer = openDaemonLog(logPath, {now: () => new Date(0)});
		writer.write('info', 'auth: Bearer eyJabc.def.ghijkl');
		writer.close();
		const content = fs.readFileSync(logPath, 'utf-8');
		expect(content).not.toContain('eyJabc');
		expect(content).toContain('Bearer ***');
	});

	it('redacts JSON-style refresh_token field', () => {
		const writer = openDaemonLog(logPath, {now: () => new Date(0)});
		writer.write('info', '{"refresh_token":"raw-secret"}');
		writer.close();
		const content = fs.readFileSync(logPath, 'utf-8');
		expect(content).not.toContain('raw-secret');
	});

	it('writes the log file at mode 0600', () => {
		if (process.platform === 'win32') return;
		const writer = openDaemonLog(logPath);
		writer.write('info', 'mode-check');
		writer.close();
		const stat = fs.statSync(logPath);
		expect(stat.mode & 0o777).toBe(0o600);
	});
});

describe('redactSecrets', () => {
	it('handles plain text and known patterns', () => {
		expect(redactSecrets('Bearer abc.def.ghi')).toBe('Bearer ***');
		expect(redactSecrets('access_token=long.access.token-value')).toContain(
			'"***"',
		);
		expect(redactSecrets('Sec-WebSocket-Protocol: secret-token')).toContain(
			'***',
		);
		expect(redactSecrets('plain text')).toBe('plain text');
	});
});
