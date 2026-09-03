import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {InstalledWorkflowSchema, type InstalledWorkflow} from '@drisp/protocol';
import {
	listInstalledWorkflows,
	watchInstalledWorkflows,
	type InstalledWorkflowWatcher,
} from '../inventory';

// These tests run against a real temp directory shaped like the Workflow
// store (`{name}/workflow.json` + `source.json`) — the same layout
// `installWorkflowFromSource` writes — so they exercise the real fs read and
// the real `fs.watch` the daemon relies on.

let storeDir: string;
const watchers: InstalledWorkflowWatcher[] = [];

beforeEach(() => {
	storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-workflow-store-'));
});

afterEach(() => {
	for (const w of watchers.splice(0)) w.close();
	fs.rmSync(storeDir, {recursive: true, force: true});
});

function install(
	name: string,
	workflow: Record<string, unknown>,
	source?: Record<string, unknown>,
): void {
	const dir = path.join(storeDir, name);
	fs.mkdirSync(dir, {recursive: true});
	fs.writeFileSync(
		path.join(dir, 'workflow.json'),
		JSON.stringify({
			name,
			plugins: [],
			promptTemplate: '{input}',
			workflowFile: 'WORKFLOW.md',
			...workflow,
		}),
	);
	fs.writeFileSync(path.join(dir, 'WORKFLOW.md'), '# workflow\n');
	if (source) {
		fs.writeFileSync(
			path.join(dir, 'source.json'),
			JSON.stringify({v: 2, ...source}),
		);
	}
}

describe('listInstalledWorkflows', () => {
	it('reports only the built-ins (versioned by the CLI) when the store does not exist', () => {
		expect(
			listInstalledWorkflows({
				storeDir: path.join(storeDir, 'missing'),
				cliVersion: '0.6.0',
			}),
		).toEqual([{name: 'default', version: '0.6.0', source: {kind: 'builtin'}}]);
	});

	it('omits the built-in version when the CLI version is unknown', () => {
		expect(listInstalledWorkflows({storeDir})).toEqual([
			{name: 'default', source: {kind: 'builtin'}},
		]);
	});

	it('reports each installed Workflow with its name, declared version, and recorded source', () => {
		install(
			'review',
			{version: '1.2.0'},
			{
				kind: 'marketplace-remote',
				ref: 'review@acme/workflows',
				version: '1.2.0',
			},
		);
		install(
			'local-review',
			{},
			{
				kind: 'marketplace-local',
				repoDir: '/srv/marketplaces/acme',
				workflowName: 'review',
				version: '1.1.0',
			},
		);
		install(
			'scratch',
			{version: '0.0.1'},
			{kind: 'filesystem', path: '/home/me/scratch/workflow.json'},
		);
		install('legacy', {version: '3.0.0'});

		const workflows = listInstalledWorkflows({storeDir, cliVersion: '0.6.0'});

		expect(workflows).toEqual([
			{name: 'default', version: '0.6.0', source: {kind: 'builtin'}},
			{name: 'legacy', version: '3.0.0', source: {kind: 'unknown'}},
			{
				name: 'local-review',
				// No declared version: the marketplace's pinned version stands in.
				version: '1.1.0',
				source: {
					kind: 'marketplace-local',
					repoDir: '/srv/marketplaces/acme',
					workflowName: 'review',
				},
			},
			{
				name: 'review',
				version: '1.2.0',
				source: {kind: 'marketplace-remote', ref: 'review@acme/workflows'},
			},
			{
				name: 'scratch',
				version: '0.0.1',
				source: {kind: 'filesystem', path: '/home/me/scratch/workflow.json'},
			},
		]);
		for (const entry of workflows) {
			expect(InstalledWorkflowSchema.safeParse(entry).success).toBe(true);
		}
	});

	it('an installed Workflow shadows the built-in of the same name', () => {
		install('default', {version: '9.9.9'}, {kind: 'filesystem', path: '/x'});
		expect(listInstalledWorkflows({storeDir, cliVersion: '0.6.0'})).toEqual([
			{
				name: 'default',
				version: '9.9.9',
				source: {kind: 'filesystem', path: '/x'},
			},
		]);
	});

	it('ignores directories without a workflow.json and stray files', () => {
		fs.mkdirSync(path.join(storeDir, 'half-installed'));
		fs.writeFileSync(path.join(storeDir, 'notes.txt'), 'x');
		expect(listInstalledWorkflows({storeDir})).toEqual([
			{name: 'default', source: {kind: 'builtin'}},
		]);
	});

	it('still lists a Workflow whose files are unreadable, without a version and with an unknown source', () => {
		const dir = path.join(storeDir, 'broken');
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, 'workflow.json'), '{not json');
		fs.writeFileSync(path.join(dir, 'source.json'), '{not json');
		expect(listInstalledWorkflows({storeDir})).toEqual([
			{name: 'default', source: {kind: 'builtin'}},
			{name: 'broken', source: {kind: 'unknown'}},
		]);
	});
});

describe('watchInstalledWorkflows', () => {
	function watch(): {
		watcher: InstalledWorkflowWatcher;
		changes: InstalledWorkflow[][];
	} {
		const changes: InstalledWorkflow[][] = [];
		const watcher = watchInstalledWorkflows({
			storeDir,
			cliVersion: '0.6.0',
			debounceMs: 20,
			onChange: workflows => {
				changes.push(workflows);
			},
		});
		watchers.push(watcher);
		return {watcher, changes};
	}

	it('starts from the current inventory', () => {
		install('review', {version: '1.0.0'});
		const {watcher} = watch();
		expect(watcher.current().map(w => w.name)).toEqual(['default', 'review']);
	});

	it('reports the full inventory after an install, an upgrade, and a removal', async () => {
		const {watcher, changes} = watch();

		install(
			'review',
			{version: '1.0.0'},
			{kind: 'marketplace-remote', ref: 'review@acme/workflows'},
		);
		await vi.waitFor(
			() =>
				expect(changes.at(-1)?.map(w => w.name)).toEqual(['default', 'review']),
			{timeout: 3_000},
		);
		expect(changes.at(-1)).toContainEqual({
			name: 'review',
			version: '1.0.0',
			source: {kind: 'marketplace-remote', ref: 'review@acme/workflows'},
		});

		// An upgrade rewrites workflow.json in place (a change inside a
		// subdirectory, which only a recursive watch sees).
		install(
			'review',
			{version: '1.1.0'},
			{kind: 'marketplace-remote', ref: 'review@acme/workflows'},
		);
		await vi.waitFor(
			() =>
				expect(changes.at(-1)?.find(w => w.name === 'review')?.version).toBe(
					'1.1.0',
				),
			{timeout: 3_000},
		);

		fs.rmSync(path.join(storeDir, 'review'), {recursive: true, force: true});
		await vi.waitFor(
			() => expect(changes.at(-1)?.map(w => w.name)).toEqual(['default']),
			{timeout: 3_000},
		);
		expect(watcher.current()).toEqual(changes.at(-1));
	});

	it('does not report when the store changes without changing the inventory', async () => {
		install('review', {version: '1.0.0'});
		const {changes} = watch();
		// Touching an asset the inventory does not read is not a change.
		fs.writeFileSync(path.join(storeDir, 'review', 'WORKFLOW.md'), '# v2\n');
		await new Promise(resolve => setTimeout(resolve, 200));
		expect(changes).toEqual([]);
	});

	it('creates a missing store so the watch can attach, then sees the first install', async () => {
		const nested = path.join(storeDir, 'not-yet', 'workflows');
		const changes: InstalledWorkflow[][] = [];
		const watcher = watchInstalledWorkflows({
			storeDir: nested,
			debounceMs: 20,
			onChange: workflows => {
				changes.push(workflows);
			},
		});
		watchers.push(watcher);
		expect(fs.existsSync(nested)).toBe(true);

		fs.mkdirSync(path.join(nested, 'first'));
		fs.writeFileSync(
			path.join(nested, 'first', 'workflow.json'),
			JSON.stringify({name: 'first', version: '0.1.0'}),
		);
		await vi.waitFor(
			() =>
				expect(changes.at(-1)?.map(w => w.name)).toEqual(['default', 'first']),
			{timeout: 3_000},
		);
	});

	it('stops reporting once closed', async () => {
		const {watcher, changes} = watch();
		watcher.close();
		install('review', {version: '1.0.0'});
		await new Promise(resolve => setTimeout(resolve, 200));
		expect(changes).toEqual([]);
	});
});
