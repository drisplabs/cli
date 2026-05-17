import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {resolveRemoteWorkspace} from './remoteWorkspaceResolver';

const cleanup: string[] = [];

function makeTempDir(prefix = 'athena-remote-workspace-') {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanup.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of cleanup.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

describe('resolveRemoteWorkspace', () => {
	it('uses a valid explicit projectDir', () => {
		const projectDir = makeTempDir();
		const result = resolveRemoteWorkspace({
			type: 'job_assignment',
			runId: 'run_1',
			runnerId: 'runner_1',
			runSpec: {prompt: 'go', projectDir},
		});

		expect(result).toEqual({kind: 'resolved', projectDir});
	});

	it('rejects an explicit home projectDir', () => {
		const home = makeTempDir('athena-remote-home-');
		const result = resolveRemoteWorkspace(
			{
				type: 'job_assignment',
				runId: 'run_home',
				runnerId: 'runner_1',
				runSpec: {prompt: 'go', projectDir: home},
			},
			{env: {HOME: home}},
		);

		expect(result).toEqual({
			kind: 'rejected',
			rejection: {
				reason: 'workspace_invalid',
				message: 'remote workspace cannot be the user home directory',
			},
		});
	});

	it('creates a managed session workspace when projectDir is missing', () => {
		const home = makeTempDir('athena-remote-home-');
		const state = makeTempDir('athena-remote-state-');
		const result = resolveRemoteWorkspace(
			{
				type: 'job_assignment',
				runId: 'run_1',
				runnerId: 'runner/one',
				runSpec: {prompt: 'go', athenaSessionId: 'athena:session'},
			},
			{
				dashboardUrl: 'https://dash.example.com/org',
				env: {HOME: home, XDG_STATE_HOME: state},
			},
		);

		const expected = path.join(
			state,
			'drisp',
			'remote-workspaces',
			'dash.example.com',
			'runner-one',
			'sessions',
			'athena-session',
		);
		expect(result).toEqual({kind: 'resolved', projectDir: expected});
		expect(fs.statSync(expected).isDirectory()).toBe(true);
	});

	it('creates a managed run workspace when no session id exists', () => {
		const home = makeTempDir('athena-remote-home-');
		const state = makeTempDir('athena-remote-state-');
		const result = resolveRemoteWorkspace(
			{
				type: 'job_assignment',
				runId: 'run_42',
				runnerId: 'runner_1',
				runSpec: {prompt: 'go'},
			},
			{
				dashboardUrl: 'https://dash.example.com',
				env: {HOME: home, XDG_STATE_HOME: state},
			},
		);

		const expected = path.join(
			state,
			'drisp',
			'remote-workspaces',
			'dash.example.com',
			'runner_1',
			'runs',
			'run_42',
		);
		expect(result).toEqual({kind: 'resolved', projectDir: expected});
		expect(fs.statSync(expected).isDirectory()).toBe(true);
	});
});
