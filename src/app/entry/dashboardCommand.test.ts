import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {mapDashboardToRunner, runDashboardCommand} from './dashboardCommand';

const tmpDirs: string[] = [];
const originalXdgStateHome = process.env['XDG_STATE_HOME'];

afterEach(() => {
	if (originalXdgStateHome === undefined) {
		delete process.env['XDG_STATE_HOME'];
	} else {
		process.env['XDG_STATE_HOME'] = originalXdgStateHome;
	}
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

function captureLogs() {
	const out: string[] = [];
	const err: string[] = [];
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-alias-'));
	tmpDirs.push(dir);
	process.env['XDG_STATE_HOME'] = dir;
	return {
		out,
		err,
		logOut: (m: string) => out.push(m),
		logError: (m: string) => err.push(m),
	};
}

describe('drisp dashboard is a deprecated alias of drisp runner (#188)', () => {
	it.each([
		[['pair', ['tok']], {subcommand: 'pair', subcommandArgs: ['tok']}],
		[['status', []], {subcommand: 'status', subcommandArgs: []}],
		[['logs', []], {subcommand: 'logs', subcommandArgs: []}],
		[['runs', []], {subcommand: 'runs', subcommandArgs: []}],
		[['refresh', []], {subcommand: 'refresh', subcommandArgs: []}],
		[['doctor', []], {subcommand: 'doctor', subcommandArgs: []}],
		[['list', []], {subcommand: 'list', subcommandArgs: []}],
		[['unpair', []], {subcommand: 'unpair', subcommandArgs: []}],
		[['help', []], {subcommand: 'help', subcommandArgs: []}],
		[['', []], {subcommand: 'help', subcommandArgs: []}],
		[['connect', []], {subcommand: '', subcommandArgs: []}],
		[['daemon', ['foreground']], {subcommand: '', subcommandArgs: []}],
		[['daemon', ['stop']], {subcommand: 'stop', subcommandArgs: []}],
		[['daemon', ['restart']], {subcommand: 'restart', subcommandArgs: []}],
		[['daemon', ['install']], {subcommand: 'install', subcommandArgs: []}],
	] as const)(
		'maps dashboard %j onto the runner command',
		([subcommand, subcommandArgs], expected) => {
			expect(
				mapDashboardToRunner({
					subcommand,
					subcommandArgs: [...subcommandArgs],
					flags: {json: true},
				}),
			).toEqual({
				kind: 'runner',
				input: {...expected, flags: {json: true}},
			});
		},
	);

	it('maps dashboard daemon start onto drisp runner --detach', () => {
		expect(
			mapDashboardToRunner({
				subcommand: 'daemon',
				subcommandArgs: ['start'],
				flags: {},
			}),
		).toEqual({
			kind: 'runner',
			input: {subcommand: '', subcommandArgs: [], flags: {detach: true}},
		});
	});

	it('treats dashboard daemon reload as the no-op it always was', () => {
		expect(
			mapDashboardToRunner({
				subcommand: 'daemon',
				subcommandArgs: ['reload'],
				flags: {},
			}),
		).toEqual({kind: 'noop', message: expect.stringContaining('no-op')});
	});

	it('prints exactly one deprecation line to stderr and then runs the runner command', async () => {
		const cap = captureLogs();
		const stopRunner = vi.fn(async () => ({ok: true, wasRunning: false}));
		const code = await runDashboardCommand(
			{subcommand: 'daemon', subcommandArgs: ['stop'], flags: {}},
			{logOut: cap.logOut, logError: cap.logError, stopRunner},
		);
		expect(code).toBe(0);
		expect(stopRunner).toHaveBeenCalledTimes(1);
		const notices = cap.err.filter(line => /deprecated/i.test(line));
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain('drisp dashboard');
		expect(notices[0]).toContain('drisp runner');
		expect(notices[0]).toContain('0.7.0');
		expect(notices[0]).not.toContain('\n');
	});

	it('prints the runner usage for dashboard help, under the runner name', async () => {
		const cap = captureLogs();
		const code = await runDashboardCommand(
			{subcommand: 'help', subcommandArgs: [], flags: {}},
			{logOut: cap.logOut, logError: cap.logError},
		);
		expect(code).toBe(0);
		expect(cap.out.join('\n')).toContain('Usage: drisp runner');
	});

	it('exits 0 with a note for dashboard daemon reload', async () => {
		const cap = captureLogs();
		const code = await runDashboardCommand(
			{subcommand: 'daemon', subcommandArgs: ['reload'], flags: {}},
			{logOut: cap.logOut, logError: cap.logError},
		);
		expect(code).toBe(0);
		expect(cap.out.join('\n')).toMatch(/no-op/);
	});
});
