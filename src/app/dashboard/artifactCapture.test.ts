import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {
	captureAndUploadArtifacts,
	collectArtifactPayloads,
	parseArtifactUploadSpec,
} from './artifactCapture';

function makeRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-artifacts-'));
	execFileSync('git', ['init'], {cwd: dir});
	execFileSync('git', ['config', 'user.email', 'test@example.com'], {cwd: dir});
	execFileSync('git', ['config', 'user.name', 'Test'], {cwd: dir});
	fs.writeFileSync(path.join(dir, 'tracked.txt'), 'base\n');
	fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.log\n.env\n');
	execFileSync('git', ['add', 'tracked.txt', '.gitignore'], {cwd: dir});
	execFileSync('git', ['commit', '-m', 'base'], {cwd: dir});
	return dir;
}

describe('artifact capture', () => {
	it('captures tracked, staged, untracked, explicitly included ignored, and unpushed deltas', async () => {
		const repo = makeRepo();
		fs.writeFileSync(path.join(repo, 'tracked.txt'), 'changed\n');
		fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged\n');
		fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked\n');
		fs.writeFileSync(path.join(repo, 'ignored.log'), 'included\n');
		execFileSync('git', ['add', 'staged.txt'], {cwd: repo});
		execFileSync('git', ['commit', '-m', 'unpushed'], {cwd: repo});
		const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
			cwd: repo,
			encoding: 'utf8',
		}).trim();
		execFileSync('git', ['remote', 'add', 'origin', repo], {cwd: repo});
		execFileSync(
			'git',
			['update-ref', `refs/remotes/origin/${branch}`, 'HEAD~1'],
			{
				cwd: repo,
			},
		);
		execFileSync('git', ['config', `branch.${branch}.remote`, 'origin'], {
			cwd: repo,
		});
		execFileSync(
			'git',
			['config', `branch.${branch}.merge`, `refs/heads/${branch}`],
			{
				cwd: repo,
			},
		);
		fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged changed\n');
		execFileSync('git', ['add', 'staged.txt'], {cwd: repo});

		const payloads = await collectArtifactPayloads({
			projectDir: repo,
			includeIgnored: ['ignored.log'],
		});

		expect(payloads.map(p => p.kind)).toEqual(
			expect.arrayContaining([
				'tracked_diff',
				'staged_diff',
				'unpushed_commits',
				'untracked_file',
				'included_ignored_file',
			]),
		);
		expect(payloads.find(p => p.path === 'ignored.log')?.bytes.toString()).toBe(
			'included\n',
		);
	});

	it('returns an empty capture when the workspace has no recoverable deltas', async () => {
		const repo = makeRepo();

		const payloads = await collectArtifactPayloads({projectDir: repo});

		expect(payloads).toEqual([]);
	});

	it('returns an empty capture for non-git workspaces', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-artifacts-'));
		fs.writeFileSync(path.join(dir, 'file.txt'), 'content\n');

		const payloads = await collectArtifactPayloads({projectDir: dir});

		expect(payloads).toEqual([]);
	});

	it('excludes gitignored files by default and never includes hard-denied paths', async () => {
		const repo = makeRepo();
		fs.writeFileSync(path.join(repo, 'ignored.log'), 'ignored\n');
		fs.writeFileSync(path.join(repo, '.env'), 'secret\n');
		execFileSync('git', ['add', '-f', '.env'], {cwd: repo});
		execFileSync('git', ['commit', '-m', 'track env'], {cwd: repo});
		fs.writeFileSync(path.join(repo, '.env'), 'changed secret\n');
		execFileSync('git', ['add', '-f', '.env'], {cwd: repo});

		const payloads = await collectArtifactPayloads({
			projectDir: repo,
			includeIgnored: ['ignored.log', '.env'],
		});

		expect(payloads.some(p => p.kind === 'staged_diff')).toBe(false);
		expect(payloads.some(p => p.path === 'ignored.log')).toBe(true);
		expect(payloads.some(p => p.path === '.env')).toBe(false);
		expect(payloads.some(p => p.path.includes('.git'))).toBe(false);
	});

	it('does not follow untracked or included ignored symlinks outside the workspace', async () => {
		const repo = makeRepo();
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-outside-'));
		fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
		fs.symlinkSync(
			path.join(outside, 'secret.txt'),
			path.join(repo, 'leak.txt'),
		);
		fs.symlinkSync(
			path.join(outside, 'secret.txt'),
			path.join(repo, 'ignored.log'),
		);

		const payloads = await collectArtifactPayloads({
			projectDir: repo,
			includeIgnored: ['ignored.log'],
		});

		expect(payloads.some(p => p.path === 'leak.txt')).toBe(false);
		expect(payloads.some(p => p.path === 'ignored.log')).toBe(false);
	});

	it('applies dashboard hard-deny glob patterns to captured files', async () => {
		const repo = makeRepo();
		fs.mkdirSync(path.join(repo, 'secrets'));
		fs.mkdirSync(path.join(repo, 'nested'));
		fs.writeFileSync(path.join(repo, 'secrets', 'token.json'), 'secret\n');
		fs.writeFileSync(path.join(repo, 'nested', 'key.pem'), 'secret\n');
		fs.writeFileSync(path.join(repo, 'safe.txt'), 'safe\n');

		const payloads = await collectArtifactPayloads({
			projectDir: repo,
			hardDeny: ['secrets/*.json', '**/*.pem'],
		});

		expect(payloads.some(p => p.path === 'secrets/token.json')).toBe(false);
		expect(payloads.some(p => p.path === 'nested/key.pem')).toBe(false);
		expect(payloads.some(p => p.path === 'safe.txt')).toBe(true);
	});

	it('uploads payloads and manifest to the scoped GCS prefix', async () => {
		const repo = makeRepo();
		fs.writeFileSync(path.join(repo, 'untracked.txt'), 'payload\n');
		const uploaded: Array<{objectName: string; body: Buffer}> = [];

		const {manifest, feedEvent} = await captureAndUploadArtifacts({
			spec: {
				bucket: 'bucket-1',
				prefix: 'runs/run-1',
				accessToken: 'token',
				includeIgnored: [],
				hardDeny: [],
			},
			projectDir: repo,
			runId: 'run-1',
			result: {
				success: true,
				exitCode: 0,
				athenaSessionId: 'athena-1',
				adapterSessionId: 'adapter-1',
				finalMessage: 'done',
				tokens: {
					input: null,
					output: null,
					cacheRead: null,
					cacheWrite: null,
					total: null,
					contextSize: null,
					contextWindowSize: null,
				},
				durationMs: 1,
			},
			now: () => 1_700_000_000_000,
			uploadObject: async input => {
				uploaded.push({objectName: input.objectName, body: input.body});
			},
		});

		expect(manifest.objects.manifest).toBe('runs/run-1/manifest.json');
		expect(manifest.entries).toHaveLength(1);
		expect(uploaded.map(u => u.objectName)).toEqual([
			expect.stringMatching(/^runs\/run-1\/payloads\//),
			'runs/run-1/manifest.json',
		]);
		expect(feedEvent).toEqual(
			expect.objectContaining({
				kind: 'artifacts.manifest',
				session_id: 'athena-1',
				data: {manifest},
			}),
		);
	});

	it('propagates upload failures', async () => {
		const repo = makeRepo();
		fs.writeFileSync(path.join(repo, 'untracked.txt'), 'payload\n');

		await expect(
			captureAndUploadArtifacts({
				spec: {
					bucket: 'bucket-1',
					prefix: 'runs/run-1',
					accessToken: 'token',
					includeIgnored: [],
					hardDeny: [],
				},
				projectDir: repo,
				runId: 'run-1',
				result: {
					success: true,
					exitCode: 0,
					athenaSessionId: 'athena-1',
					adapterSessionId: null,
					finalMessage: 'done',
					tokens: {
						input: null,
						output: null,
						cacheRead: null,
						cacheWrite: null,
						total: null,
						contextSize: null,
						contextWindowSize: null,
					},
					durationMs: 1,
				},
				uploadObject: vi.fn(async () => {
					throw new Error('boom');
				}),
			}),
		).rejects.toThrow('boom');
	});

	it('parses artifact upload credentials from runSpec', () => {
		expect(
			parseArtifactUploadSpec({
				prompt: 'go',
				artifactUpload: {
					bucket: 'b',
					prefix: 'p',
					credentials: {accessToken: 'tok'},
					includeIgnored: ['ignored.log'],
				},
			}),
		).toEqual(
			expect.objectContaining({
				bucket: 'b',
				prefix: 'p',
				accessToken: 'tok',
				includeIgnored: ['ignored.log'],
			}),
		);
	});

	it('rejects malformed artifact upload specs when the key is present', () => {
		expect(() =>
			parseArtifactUploadSpec({
				prompt: 'go',
				artifactUpload: {
					bucket: 'b',
				},
			}),
		).toThrow(/artifact upload spec/i);
		expect(() =>
			parseArtifactUploadSpec({
				prompt: 'go',
				artifactUpload: 'invalid',
			}),
		).toThrow(/artifact upload spec/i);
		expect(() =>
			parseArtifactUploadSpec({
				prompt: 'go',
				artifactUpload: {
					bucket: 'b',
					prefix: '/',
					accessToken: 'tok',
				},
			}),
		).toThrow(/artifact upload spec/i);
	});
});
