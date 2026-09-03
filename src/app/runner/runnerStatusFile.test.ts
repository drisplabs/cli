import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
	createRunnerStatusWriter,
	readRunnerStatusFile,
	type RunnerStatusSnapshot,
} from './runnerStatusFile';

let tmpDir: string;
let statusPath: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-status-'));
	statusPath = path.join(tmpDir, 'runner.status.json');
});

afterEach(() => {
	vi.useRealTimers();
	fs.rmSync(tmpDir, {recursive: true, force: true});
});

function snapshot(
	overrides: Partial<RunnerStatusSnapshot> = {},
): RunnerStatusSnapshot {
	return {
		pid: 4123,
		startedAt: 1_000,
		socketConnected: false,
		activeRuns: 0,
		completedRuns: 0,
		runs: [],
		...overrides,
	};
}

describe('readRunnerStatusFile', () => {
	it('returns null when the file is absent', () => {
		expect(readRunnerStatusFile(statusPath)).toBeNull();
	});

	it('returns null when the file is not a status document', () => {
		fs.writeFileSync(statusPath, 'not json');
		expect(readRunnerStatusFile(statusPath)).toBeNull();
		fs.writeFileSync(statusPath, JSON.stringify({pid: 'x'}));
		expect(readRunnerStatusFile(statusPath)).toBeNull();
	});
});

describe('createRunnerStatusWriter', () => {
	it('writes the snapshot with an updatedAt stamp, mode 0600, and reads it back', () => {
		let current = snapshot();
		const writer = createRunnerStatusWriter({
			path: statusPath,
			status: () => current,
			intervalMs: 60_000,
			now: () => 5_000,
		});
		writer.flush();
		expect(readRunnerStatusFile(statusPath)).toEqual({
			...snapshot(),
			updatedAt: 5_000,
		});
		if (process.platform !== 'win32') {
			expect(fs.statSync(statusPath).mode & 0o777).toBe(0o600);
		}
		expect(fs.readdirSync(tmpDir)).toEqual(['runner.status.json']);

		current = snapshot({socketConnected: true, instanceId: 'inst_1'});
		writer.flush();
		expect(readRunnerStatusFile(statusPath)).toMatchObject({
			socketConnected: true,
			instanceId: 'inst_1',
		});
		writer.close();
	});

	it('rewrites on change on its interval, and not when nothing changed', () => {
		vi.useFakeTimers();
		let current = snapshot();
		let clock = 1_000;
		const writer = createRunnerStatusWriter({
			path: statusPath,
			status: () => current,
			intervalMs: 100,
			now: () => clock,
		});
		writer.flush();
		expect(readRunnerStatusFile(statusPath)?.updatedAt).toBe(1_000);

		clock = 2_000;
		vi.advanceTimersByTime(100);
		// Unchanged snapshot: the file is left alone (same updatedAt).
		expect(readRunnerStatusFile(statusPath)?.updatedAt).toBe(1_000);

		current = snapshot({activeRuns: 1});
		clock = 3_000;
		vi.advanceTimersByTime(100);
		expect(readRunnerStatusFile(statusPath)).toMatchObject({
			activeRuns: 1,
			updatedAt: 3_000,
		});
		writer.close();
	});

	it('removes the file on close and stops rewriting', () => {
		vi.useFakeTimers();
		const writer = createRunnerStatusWriter({
			path: statusPath,
			status: () => snapshot(),
			intervalMs: 100,
		});
		writer.flush();
		expect(fs.existsSync(statusPath)).toBe(true);
		writer.close();
		expect(fs.existsSync(statusPath)).toBe(false);
		vi.advanceTimersByTime(500);
		expect(fs.existsSync(statusPath)).toBe(false);
	});
});
