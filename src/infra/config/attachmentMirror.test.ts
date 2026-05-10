import {describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	attachmentMirrorPath,
	diffAttachments,
	readAttachmentMirror,
	removeAttachmentMirror,
	writeAttachmentMirror,
	type AttachmentMirror,
} from './attachmentMirror';

function mkHome() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'athena-att-'));
}

describe('attachment mirror', () => {
	it('returns null when attachments.json is missing', () => {
		const home = mkHome();
		expect(readAttachmentMirror({HOME: home})).toBeNull();
	});

	it('round-trips a mirror under ~/.config/athena/attachments.json with 0600', () => {
		const home = mkHome();
		const env = {HOME: home};
		const mirror: AttachmentMirror = {
			instanceId: 'inst_1',
			fetchedAt: 1700,
			attachments: [
				{
					runnerId: 'r1',
					name: 'laptop',
					executionTarget: 'local',
					remoteInstanceId: 'remote_1',
				},
				{runnerId: 'r2'},
			],
		};
		writeAttachmentMirror(mirror, env);
		expect(readAttachmentMirror(env)).toEqual(mirror);
		expect(attachmentMirrorPath(env)).toBe(
			path.join(home, '.config', 'athena', 'attachments.json'),
		);
		if (process.platform !== 'win32') {
			const mode = fs.statSync(attachmentMirrorPath(env)).mode & 0o777;
			expect(mode).toBe(0o600);
		}
	});

	it('overwrites existing mirror atomically', () => {
		const home = mkHome();
		const env = {HOME: home};
		writeAttachmentMirror(
			{instanceId: 'inst_1', fetchedAt: 1, attachments: [{runnerId: 'r1'}]},
			env,
		);
		writeAttachmentMirror(
			{
				instanceId: 'inst_1',
				fetchedAt: 2,
				attachments: [{runnerId: 'r2', name: 'second'}],
			},
			env,
		);
		expect(readAttachmentMirror(env)).toEqual({
			instanceId: 'inst_1',
			fetchedAt: 2,
			attachments: [{runnerId: 'r2', name: 'second'}],
		});
	});

	it('rejects invalid stored mirror', () => {
		const home = mkHome();
		const file = attachmentMirrorPath({HOME: home});
		fs.mkdirSync(path.dirname(file), {recursive: true});
		fs.writeFileSync(file, JSON.stringify({instanceId: ''}));
		expect(() => readAttachmentMirror({HOME: home})).toThrow(
			/attachment mirror/,
		);
	});

	it('rejects malformed JSON', () => {
		const home = mkHome();
		const file = attachmentMirrorPath({HOME: home});
		fs.mkdirSync(path.dirname(file), {recursive: true});
		fs.writeFileSync(file, '{not json');
		expect(() => readAttachmentMirror({HOME: home})).toThrow(/invalid JSON/);
	});

	it('rejects entries without runnerId at write time', () => {
		const home = mkHome();
		expect(() =>
			writeAttachmentMirror(
				{
					instanceId: 'inst_1',
					fetchedAt: 0,
					attachments: [{runnerId: ''}],
				},
				{HOME: home},
			),
		).toThrow(/runnerId/);
	});

	it('removes mirror and is idempotent', () => {
		const home = mkHome();
		const env = {HOME: home};
		writeAttachmentMirror(
			{instanceId: 'inst_1', fetchedAt: 0, attachments: []},
			env,
		);
		removeAttachmentMirror(env);
		removeAttachmentMirror(env);
		expect(readAttachmentMirror(env)).toBeNull();
	});

	describe('diffAttachments', () => {
		it('detects added, removed, and changed', () => {
			const prev = [
				{runnerId: 'r1', name: 'a'},
				{runnerId: 'r2', name: 'b'},
				{runnerId: 'r3'},
			];
			const next = [
				{runnerId: 'r2', name: 'b-renamed'},
				{runnerId: 'r3'},
				{runnerId: 'r4', name: 'd'},
			];
			const diff = diffAttachments(prev, next);
			expect(diff.removed).toEqual([{runnerId: 'r1', name: 'a'}]);
			expect(diff.added).toEqual([{runnerId: 'r4', name: 'd'}]);
			expect(diff.changed).toEqual([
				{
					prev: {runnerId: 'r2', name: 'b'},
					next: {runnerId: 'r2', name: 'b-renamed'},
				},
			]);
		});

		it('returns empty diff when lists match', () => {
			const both = [{runnerId: 'r1', name: 'a'}];
			expect(diffAttachments(both, both)).toEqual({
				added: [],
				removed: [],
				changed: [],
			});
		});
	});
});
