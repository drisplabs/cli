import {execFile} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import type {FeedEvent} from '../../core/feed/types';
import type {ExecRunResult} from '../exec/types';

const execFileAsync = promisify(execFile);

export type ArtifactUploadSpec = {
	bucket: string;
	prefix: string;
	accessToken: string;
	includeIgnored: readonly string[];
	hardDeny: readonly string[];
};

export type ArtifactManifestEntry = {
	id: string;
	kind:
		| 'tracked_diff'
		| 'staged_diff'
		| 'unpushed_commits'
		| 'untracked_file'
		| 'included_ignored_file';
	path: string;
	object: string;
	size: number;
	sha256: string;
};

export type ArtifactManifest = {
	version: 1;
	runId: string;
	athenaSessionId: string | null;
	adapterSessionId: string | null;
	createdAt: string;
	entries: ArtifactManifestEntry[];
	objects: {
		bucket: string;
		prefix: string;
		manifest: string;
	};
};

type Payload = {
	kind: ArtifactManifestEntry['kind'];
	path: string;
	bytes: Buffer;
};

type UploadObjectInput = {
	bucket: string;
	objectName: string;
	body: Buffer;
	contentType: string;
	accessToken: string;
};

export type UploadObjectFn = (input: UploadObjectInput) => Promise<void>;

export function parseArtifactUploadSpec(
	value: unknown,
): ArtifactUploadSpec | null {
	if (typeof value !== 'object' || value === null) return null;
	const obj = value as Record<string, unknown>;
	const hasArtifactUpload = Object.hasOwn(obj, 'artifactUpload');
	const hasArtifacts = Object.hasOwn(obj, 'artifacts');
	if (!hasArtifactUpload && !hasArtifacts) return null;
	const candidate = hasArtifactUpload
		? obj['artifactUpload']
		: obj['artifacts'];
	if (typeof candidate !== 'object' || candidate === null) {
		throw new Error('artifact upload spec must be an object');
	}
	const spec = candidate as Record<string, unknown>;
	const bucket = spec['bucket'];
	const prefix = spec['prefix'];
	const normalizedPrefix =
		typeof prefix === 'string' ? prefix.replace(/^\/+|\/+$/g, '') : null;
	const accessToken =
		spec['accessToken'] ??
		(typeof spec['credentials'] === 'object' && spec['credentials'] !== null
			? (spec['credentials'] as Record<string, unknown>)['accessToken']
			: undefined);
	if (
		typeof bucket !== 'string' ||
		bucket.length === 0 ||
		!normalizedPrefix ||
		typeof accessToken !== 'string' ||
		accessToken.length === 0
	) {
		throw new Error(
			'artifact upload spec must include bucket, prefix, and accessToken',
		);
	}
	return {
		bucket,
		prefix: normalizedPrefix,
		accessToken,
		includeIgnored: stringArray(spec['includeIgnored']),
		hardDeny: [...DEFAULT_HARD_DENY, ...stringArray(spec['hardDeny'])],
	};
}

export async function captureAndUploadArtifacts(input: {
	spec: ArtifactUploadSpec;
	projectDir: string;
	runId: string;
	result: ExecRunResult;
	now?: () => number;
	uploadObject?: UploadObjectFn;
}): Promise<{manifest: ArtifactManifest; feedEvent: FeedEvent}> {
	const now = input.now ?? Date.now;
	const uploadObject = input.uploadObject ?? uploadGcsObject;
	const payloads = await collectArtifactPayloads({
		projectDir: input.projectDir,
		includeIgnored: input.spec.includeIgnored,
		hardDeny: input.spec.hardDeny,
	});
	const entries: ArtifactManifestEntry[] = [];
	for (const [idx, payload] of payloads.entries()) {
		const id = `${String(idx + 1).padStart(4, '0')}-${safeObjectSegment(
			payload.kind,
		)}`;
		const object = joinObjectName(
			input.spec.prefix,
			'payloads',
			`${id}-${safeObjectSegment(payload.path)}`,
		);
		await uploadObject({
			bucket: input.spec.bucket,
			objectName: object,
			body: payload.bytes,
			contentType: contentTypeFor(payload.path),
			accessToken: input.spec.accessToken,
		});
		entries.push({
			id,
			kind: payload.kind,
			path: payload.path,
			object,
			size: payload.bytes.byteLength,
			sha256: sha256(payload.bytes),
		});
	}
	const manifestObject = joinObjectName(input.spec.prefix, 'manifest.json');
	const manifest: ArtifactManifest = {
		version: 1,
		runId: input.runId,
		athenaSessionId: input.result.athenaSessionId,
		adapterSessionId: input.result.adapterSessionId,
		createdAt: new Date(now()).toISOString(),
		entries,
		objects: {
			bucket: input.spec.bucket,
			prefix: input.spec.prefix,
			manifest: manifestObject,
		},
	};
	await uploadObject({
		bucket: input.spec.bucket,
		objectName: manifestObject,
		body: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
		contentType: 'application/json',
		accessToken: input.spec.accessToken,
	});
	return {
		manifest,
		feedEvent: makeArtifactManifestFeedEvent({
			manifest,
			result: input.result,
			runId: input.runId,
			ts: now(),
		}),
	};
}

export async function collectArtifactPayloads(input: {
	projectDir: string;
	includeIgnored?: readonly string[];
	hardDeny?: readonly string[];
}): Promise<Payload[]> {
	const hardDeny = input.hardDeny ?? DEFAULT_HARD_DENY;
	const payloads: Payload[] = [];
	if (!(await isGitWorkspace(input.projectDir))) {
		return payloads;
	}
	const trackedDiff = await gitDiffForAllowedPaths({
		projectDir: input.projectDir,
		nameArgs: ['diff', '--name-only', '-z', '--'],
		diffArgs: ['diff', '--binary', '--'],
		hardDeny,
	});
	if (trackedDiff.length > 0) {
		payloads.push({
			kind: 'tracked_diff',
			path: 'git/tracked.diff',
			bytes: Buffer.from(trackedDiff),
		});
	}
	const stagedDiff = await gitDiffForAllowedPaths({
		projectDir: input.projectDir,
		nameArgs: ['diff', '--name-only', '-z', '--cached', '--'],
		diffArgs: ['diff', '--binary', '--cached', '--'],
		hardDeny,
	});
	if (stagedDiff.length > 0) {
		payloads.push({
			kind: 'staged_diff',
			path: 'git/staged.diff',
			bytes: Buffer.from(stagedDiff),
		});
	}
	const upstream = await gitMaybe(input.projectDir, [
		'rev-parse',
		'--abbrev-ref',
		'--symbolic-full-name',
		'@{u}',
	]);
	if (upstream.trim().length > 0) {
		const range = `${upstream.trim()}..HEAD`;
		const commits = await gitDiffForAllowedPaths({
			projectDir: input.projectDir,
			nameArgs: ['diff', '--name-only', '-z', range, '--'],
			diffArgs: ['format-patch', '--stdout', range, '--'],
			hardDeny,
		});
		if (commits.length > 0) {
			payloads.push({
				kind: 'unpushed_commits',
				path: 'git/unpushed.patch',
				bytes: Buffer.from(commits),
			});
		}
	}
	const untracked = splitNul(
		await git(input.projectDir, [
			'ls-files',
			'--others',
			'--exclude-standard',
			'-z',
		]),
	);
	for (const rel of untracked) {
		if (!isAllowedRelativePath(rel, hardDeny)) continue;
		const bytes = await readWorkspaceFile(input.projectDir, rel);
		if (!bytes) continue;
		payloads.push({
			kind: 'untracked_file',
			path: rel,
			bytes,
		});
	}
	for (const rel of input.includeIgnored ?? []) {
		if (!isAllowedRelativePath(rel, hardDeny)) continue;
		if (!(await isIgnored(input.projectDir, rel))) continue;
		const bytes = await readWorkspaceFile(input.projectDir, rel);
		if (!bytes) continue;
		payloads.push({
			kind: 'included_ignored_file',
			path: rel,
			bytes,
		});
	}
	return payloads;
}

async function readWorkspaceFile(
	projectDir: string,
	rel: string,
): Promise<Buffer | null> {
	const absolute = path.resolve(projectDir, rel);
	const workspaceRoot = await fs.realpath(projectDir);
	let stat;
	try {
		stat = await fs.lstat(absolute);
	} catch {
		return null;
	}
	if (!stat.isFile() || stat.isSymbolicLink()) return null;
	const real = await fs.realpath(absolute);
	const relativeToRoot = path.relative(workspaceRoot, real);
	if (
		relativeToRoot === '..' ||
		relativeToRoot.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativeToRoot)
	) {
		return null;
	}
	return fs.readFile(absolute);
}

async function gitDiffForAllowedPaths(input: {
	projectDir: string;
	nameArgs: readonly string[];
	diffArgs: readonly string[];
	hardDeny: readonly string[];
}): Promise<string> {
	const paths = splitNul(await git(input.projectDir, input.nameArgs)).filter(
		rel => isAllowedRelativePath(rel, input.hardDeny),
	);
	if (paths.length === 0) return '';
	return git(input.projectDir, [...input.diffArgs, ...paths]);
}

async function uploadGcsObject(input: UploadObjectInput): Promise<void> {
	const url = new URL(
		`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(
			input.bucket,
		)}/o`,
	);
	url.searchParams.set('uploadType', 'media');
	url.searchParams.set('name', input.objectName);
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${input.accessToken}`,
			'content-type': input.contentType,
		},
		body: input.body.buffer.slice(
			input.body.byteOffset,
			input.body.byteOffset + input.body.byteLength,
		) as ArrayBuffer,
	});
	if (!response.ok) {
		throw new Error(
			`GCS upload ${input.objectName} failed with HTTP ${response.status}`,
		);
	}
}

function makeArtifactManifestFeedEvent(input: {
	manifest: ArtifactManifest;
	result: ExecRunResult;
	runId: string;
	ts: number;
}): FeedEvent {
	return {
		event_id: `${input.runId}:artifacts-manifest`,
		seq: 0,
		ts: input.ts,
		session_id: input.result.athenaSessionId ?? input.runId,
		run_id: input.runId,
		kind: 'artifacts.manifest',
		level: 'info',
		actor_id: 'system',
		title: 'Artifacts manifest',
		data: {manifest: input.manifest},
	};
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
	const result = await execFileAsync('git', args, {
		cwd,
		encoding: 'buffer',
		maxBuffer: 50 * 1024 * 1024,
	});
	return result.stdout.toString('utf8');
}

async function gitMaybe(cwd: string, args: readonly string[]): Promise<string> {
	try {
		return await git(cwd, args);
	} catch {
		return '';
	}
}

async function isGitWorkspace(cwd: string): Promise<boolean> {
	return (
		(await gitMaybe(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() ===
		'true'
	);
}

async function isIgnored(cwd: string, rel: string): Promise<boolean> {
	try {
		await execFileAsync('git', ['check-ignore', '--quiet', '--', rel], {cwd});
		return true;
	} catch {
		return false;
	}
}

function splitNul(value: string): string[] {
	return value.split('\0').filter(Boolean);
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string')
		: [];
}

const DEFAULT_HARD_DENY = [
	'.git',
	'.git/**',
	'.env',
	'.env.*',
	'**/.env',
	'**/.env.*',
	'.ssh',
	'.ssh/**',
];

function isAllowedRelativePath(
	rel: string,
	hardDeny: readonly string[],
): boolean {
	if (path.isAbsolute(rel) || rel.includes('\0')) return false;
	const normalized = path.posix.normalize(rel.replaceAll(path.sep, '/'));
	if (normalized === '..' || normalized.startsWith('../')) return false;
	return !hardDeny.some(pattern => matchesDenyPattern(normalized, pattern));
}

function matchesDenyPattern(rel: string, pattern: string): boolean {
	const normalized = pattern.replaceAll(path.sep, '/');
	if (normalized.includes('*') || normalized.includes('?')) {
		return globToRegExp(normalized).test(rel);
	}
	if (normalized.endsWith('/**')) {
		const prefix = normalized.slice(0, -3);
		return rel === prefix || rel.startsWith(`${prefix}/`);
	}
	if (normalized.startsWith('**/')) {
		const suffix = normalized.slice(3);
		return rel === suffix || rel.endsWith(`/${suffix}`);
	}
	if (normalized.endsWith('.*')) {
		const prefix = normalized.slice(0, -1);
		return rel.startsWith(prefix);
	}
	return rel === normalized;
}

function globToRegExp(pattern: string): RegExp {
	let source = '^';
	for (let i = 0; i < pattern.length; i += 1) {
		const char = pattern[i]!;
		const next = pattern[i + 1];
		if (char === '*') {
			if (next === '*') {
				const after = pattern[i + 2];
				if (after === '/') {
					source += '(?:.*/)?';
					i += 2;
				} else {
					source += '.*';
					i += 1;
				}
			} else {
				source += '[^/]*';
			}
		} else if (char === '?') {
			source += '[^/]';
		} else {
			source += escapeRegExp(char);
		}
	}
	source += '$';
	return new RegExp(source);
}

function escapeRegExp(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function sha256(bytes: Buffer): string {
	return crypto.createHash('sha256').update(bytes).digest('hex');
}

function joinObjectName(...parts: string[]): string {
	return parts
		.map(part => part.replace(/^\/+|\/+$/g, ''))
		.filter(Boolean)
		.join('/');
}

function safeObjectSegment(value: string): string {
	const safe = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
	return safe.length > 0 ? safe.slice(0, 160) : 'artifact';
}

function contentTypeFor(filePath: string): string {
	if (filePath.endsWith('.json')) return 'application/json';
	if (filePath.endsWith('.diff') || filePath.endsWith('.patch')) {
		return 'text/x-diff';
	}
	return 'application/octet-stream';
}
