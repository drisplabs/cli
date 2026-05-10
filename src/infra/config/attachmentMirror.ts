/**
 * Read-only mirror of the dashboard's runner-attachment list for this
 * paired instance. The dashboard is the source of truth — this file is
 * written by `dashboard pair` (and later by the runtime daemon when it
 * receives change pushes) so the gateway and CLI surface can answer
 * "which runners are bound to this instance?" without round-tripping
 * to the server.
 *
 * Lives next to dashboardClient.ts; same atomic-write discipline.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type AttachmentMirrorEntry = {
	runnerId: string;
	name?: string;
	executionTarget?: string;
	remoteInstanceId?: string;
};

export type AttachmentMirror = {
	instanceId: string;
	fetchedAt: number;
	attachments: AttachmentMirrorEntry[];
};

export function attachmentMirrorPath(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const home = env['HOME'] ?? os.homedir();
	return path.join(home, '.config', 'athena', 'attachments.json');
}

export function readAttachmentMirror(
	env: NodeJS.ProcessEnv = process.env,
): AttachmentMirror | null {
	const file = attachmentMirrorPath(env);
	let raw: string;
	try {
		raw = fs.readFileSync(file, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(
			`attachment mirror ${file} is invalid JSON: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
	try {
		return parseAttachmentMirror(parsed);
	} catch (err) {
		throw new Error(
			`attachment mirror ${file} is invalid: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

export function writeAttachmentMirror(
	mirror: AttachmentMirror,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const validated = parseAttachmentMirror(mirror);
	const file = attachmentMirrorPath(env);
	const dir = path.dirname(file);
	fs.mkdirSync(dir, {recursive: true, mode: 0o700});
	const tmp = `${file}.${process.pid}.${crypto
		.randomBytes(4)
		.toString('hex')}.tmp`;
	const fd = fs.openSync(tmp, 'w', 0o600);
	try {
		fs.writeSync(fd, JSON.stringify(validated, null, 2) + '\n');
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	try {
		fs.renameSync(tmp, file);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// best-effort
		}
		throw err;
	}
	if (process.platform !== 'win32') {
		try {
			fs.chmodSync(dir, 0o700);
			fs.chmodSync(file, 0o600);
		} catch {
			// best-effort
		}
	}
}

export function removeAttachmentMirror(
	env: NodeJS.ProcessEnv = process.env,
): void {
	const file = attachmentMirrorPath(env);
	try {
		fs.unlinkSync(file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}
}

export type AttachmentMirrorDiff = {
	added: AttachmentMirrorEntry[];
	removed: AttachmentMirrorEntry[];
	changed: Array<{prev: AttachmentMirrorEntry; next: AttachmentMirrorEntry}>;
};

export function diffAttachments(
	prev: AttachmentMirrorEntry[],
	next: AttachmentMirrorEntry[],
): AttachmentMirrorDiff {
	const prevById = new Map(prev.map(a => [a.runnerId, a]));
	const nextById = new Map(next.map(a => [a.runnerId, a]));
	const added: AttachmentMirrorEntry[] = [];
	const removed: AttachmentMirrorEntry[] = [];
	const changed: Array<{
		prev: AttachmentMirrorEntry;
		next: AttachmentMirrorEntry;
	}> = [];
	for (const [id, entry] of nextById) {
		const before = prevById.get(id);
		if (!before) {
			added.push(entry);
		} else if (!entriesEqual(before, entry)) {
			changed.push({prev: before, next: entry});
		}
	}
	for (const [id, entry] of prevById) {
		if (!nextById.has(id)) removed.push(entry);
	}
	return {added, removed, changed};
}

function entriesEqual(a: AttachmentMirrorEntry, b: AttachmentMirrorEntry) {
	return (
		a.runnerId === b.runnerId &&
		a.name === b.name &&
		a.executionTarget === b.executionTarget &&
		a.remoteInstanceId === b.remoteInstanceId
	);
}

function parseAttachmentMirror(raw: unknown): AttachmentMirror {
	if (typeof raw !== 'object' || raw === null) {
		throw new Error('root must be an object');
	}
	const obj = raw as Record<string, unknown>;
	if (typeof obj['instanceId'] !== 'string' || obj['instanceId'].length === 0) {
		throw new Error('instanceId must be a non-empty string');
	}
	if (typeof obj['fetchedAt'] !== 'number') {
		throw new Error('fetchedAt must be a number');
	}
	if (!Array.isArray(obj['attachments'])) {
		throw new Error('attachments must be an array');
	}
	const attachments = obj['attachments'].map((entry, idx) => {
		if (typeof entry !== 'object' || entry === null) {
			throw new Error(`attachments[${idx}] must be an object`);
		}
		const e = entry as Record<string, unknown>;
		if (typeof e['runnerId'] !== 'string' || e['runnerId'].length === 0) {
			throw new Error(
				`attachments[${idx}].runnerId must be a non-empty string`,
			);
		}
		const out: AttachmentMirrorEntry = {runnerId: e['runnerId']};
		if (typeof e['name'] === 'string') out.name = e['name'];
		if (typeof e['executionTarget'] === 'string') {
			out.executionTarget = e['executionTarget'];
		}
		if (typeof e['remoteInstanceId'] === 'string') {
			out.remoteInstanceId = e['remoteInstanceId'];
		}
		return out;
	});
	return {
		instanceId: obj['instanceId'],
		fetchedAt: obj['fetchedAt'],
		attachments,
	};
}
