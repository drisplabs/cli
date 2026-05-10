import {beforeEach, afterEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {reconcileConsoleSidecars} from './consoleSidecarReconciler';

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-reconcile-'));
});

afterEach(() => {
	fs.rmSync(dir, {recursive: true, force: true});
});

function writeFile(name: string, contents: object) {
	fs.mkdirSync(dir, {recursive: true});
	fs.writeFileSync(path.join(dir, name), JSON.stringify(contents, null, 2));
}

describe('reconcileConsoleSidecars', () => {
	it('preserves user-managed (no dashboard_config flag) console sidecars and non-console sidecars', () => {
		writeFile('console.json', {
			// legacy single-instance, user-managed
			broker_url: 'wss://user/manual',
			runner_id: 'rUser',
		});
		writeFile('telegram.json', {
			bot_token: 'xxx',
		});
		writeFile('console-rManual.json', {
			kind: 'console',
			instance_id: 'console:rManual',
			broker_url: 'wss://manual',
			runner_id: 'rManual',
			// no dashboard_config — user wrote this manually
		});

		const result = reconcileConsoleSidecars({
			channelDir: dir,
			dashboardUrl: 'https://dash.example.com',
			desired: [],
		});

		expect(result.written).toEqual([]);
		expect(result.removed).toEqual([]);
		expect(fs.existsSync(path.join(dir, 'console.json'))).toBe(true);
		expect(fs.existsSync(path.join(dir, 'telegram.json'))).toBe(true);
		expect(fs.existsSync(path.join(dir, 'console-rManual.json'))).toBe(true);
	});

	it('is idempotent — second call with same input is a no-op', () => {
		const input = {
			channelDir: dir,
			dashboardUrl: 'https://dash.example.com',
			desired: [{runnerId: 'r1'}],
		};
		reconcileConsoleSidecars(input);
		const target = path.join(dir, 'console-r1.json');
		const firstMtime = fs.statSync(target).mtimeMs;

		const second = reconcileConsoleSidecars(input);

		expect(second).toEqual({written: [], removed: []});
		expect(fs.statSync(target).mtimeMs).toBe(firstMtime);
	});

	it('removes dashboard-managed console sidecars whose runner is no longer attached', () => {
		writeFile('console-r2.json', {
			kind: 'console',
			instance_id: 'console:r2',
			broker_url: 'wss://x/y',
			runner_id: 'r2',
			dashboard_config: true,
		});

		const result = reconcileConsoleSidecars({
			channelDir: dir,
			dashboardUrl: 'https://dash.example.com',
			desired: [{runnerId: 'r1'}],
		});

		expect(result.written).toEqual(['r1']);
		expect(result.removed).toEqual(['r2']);
		expect(fs.existsSync(path.join(dir, 'console-r1.json'))).toBe(true);
		expect(fs.existsSync(path.join(dir, 'console-r2.json'))).toBe(false);
	});

	it('writes a per-runner console sidecar with the expected payload', () => {
		const result = reconcileConsoleSidecars({
			channelDir: dir,
			dashboardUrl: 'https://dash.example.com',
			desired: [{runnerId: 'r1'}],
		});

		expect(result.written).toEqual(['r1']);
		expect(result.removed).toEqual([]);

		const target = path.join(dir, 'console-r1.json');
		const raw = JSON.parse(fs.readFileSync(target, 'utf-8'));
		expect(raw).toEqual({
			kind: 'console',
			instance_id: 'console:r1',
			broker_url: 'wss://dash.example.com/api/runners/r1/console/adapter',
			runner_id: 'r1',
			dashboard_config: true,
		});
	});
});
