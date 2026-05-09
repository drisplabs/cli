import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {acquirePidLock, readPidLock} from './pidLock';

let tmpDir: string;
let pidPath: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidlock-'));
	pidPath = path.join(tmpDir, 'daemon.pid');
});

afterEach(() => {
	try {
		fs.rmSync(tmpDir, {recursive: true, force: true});
	} catch {
		// best-effort
	}
});

describe('acquirePidLock', () => {
	it('writes the calling pid and is exclusive', () => {
		const lock = acquirePidLock(pidPath);
		expect(lock.pid).toBe(process.pid);
		expect(fs.readFileSync(pidPath, 'utf-8').trim()).toBe(String(process.pid));

		expect(() => acquirePidLock(pidPath)).toThrow(/already running as pid/);
		lock.release();
	});

	it('release removes the file when held by this process', () => {
		const lock = acquirePidLock(pidPath);
		lock.release();
		expect(fs.existsSync(pidPath)).toBe(false);
	});

	it('release is idempotent', () => {
		const lock = acquirePidLock(pidPath);
		lock.release();
		lock.release();
		expect(fs.existsSync(pidPath)).toBe(false);
	});

	it('reaps a stale lock from a dead pid', () => {
		// Pick a pid that almost certainly is not alive.
		fs.writeFileSync(pidPath, '987654321\n');
		const lock = acquirePidLock(pidPath);
		expect(lock.pid).toBe(process.pid);
		lock.release();
	});

	it('writes mode 0600', () => {
		if (process.platform === 'win32') return;
		const lock = acquirePidLock(pidPath);
		const stat = fs.statSync(pidPath);
		expect(stat.mode & 0o777).toBe(0o600);
		lock.release();
	});
});

describe('readPidLock', () => {
	it('returns absent when no file', () => {
		expect(readPidLock(pidPath)).toEqual({state: 'absent'});
	});

	it('returns held when pid is alive (this process)', () => {
		fs.writeFileSync(pidPath, `${process.pid}\n`);
		expect(readPidLock(pidPath)).toEqual({
			state: 'held',
			pid: process.pid,
		});
	});

	it('returns stale for a non-running pid', () => {
		fs.writeFileSync(pidPath, '987654321\n');
		const result = readPidLock(pidPath);
		// On windows we can't probe pid liveness cheaply, so the lock is
		// reported as held there.
		if (process.platform === 'win32') {
			expect(result.state).toBe('held');
		} else {
			expect(result).toEqual({state: 'stale', pid: 987654321});
		}
	});

	it('returns stale for a malformed file', () => {
		fs.writeFileSync(pidPath, 'not-a-pid\n');
		expect(readPidLock(pidPath)).toEqual({state: 'stale', pid: 0});
	});
});
