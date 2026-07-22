import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {AthenaSession} from './types';
import {rowToAthenaSession} from './types';
import {SCHEMA_VERSION} from './schema';
import {openSessionDbReadonly, type SessionDbReader} from './sessionDbReader';

export function sessionsDir(): string {
	return path.join(os.homedir(), '.config', 'athena', 'sessions');
}

function sessionDbPath(sessionId: string): string {
	return path.join(sessionsDir(), sessionId, 'session.db');
}

function readSessionFromDb(dbPath: string): AthenaSession | null {
	if (!fs.existsSync(dbPath)) return null;

	let reader: SessionDbReader | undefined;
	try {
		reader = openSessionDbReadonly(dbPath);

		// Bail if schema version is newer than supported
		const version = reader.schemaVersion();
		if (version !== undefined && version > SCHEMA_VERSION) {
			return null;
		}

		const row = reader.sessionRow();
		if (!row) return null;

		const adapterSessionIds = reader.adapterSessionIds();

		let firstPrompt: string | undefined;
		if (!row.label && (row.event_count ?? 0) > 0) {
			const prompt = reader.firstUserPrompt();
			if (prompt) {
				firstPrompt = prompt;
			}
		}

		return rowToAthenaSession(row, adapterSessionIds, firstPrompt);
	} catch {
		return null;
	} finally {
		reader?.close();
	}
}

export function listSessions(projectDir?: string): AthenaSession[] {
	const dir = sessionsDir();
	if (!fs.existsSync(dir)) return [];

	const entries = fs.readdirSync(dir, {withFileTypes: true});
	const sessions: AthenaSession[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dbPath = path.join(dir, entry.name, 'session.db');
		const session = readSessionFromDb(dbPath);
		if (session && (session.eventCount ?? 0) > 0) {
			if (!projectDir || session.projectDir === projectDir) {
				sessions.push(session);
			}
		}
	}

	return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getSessionMeta(sessionId: string): AthenaSession | null {
	return readSessionFromDb(sessionDbPath(sessionId));
}

export function removeSession(sessionId: string): void {
	const dir = path.join(sessionsDir(), sessionId);
	if (fs.existsSync(dir)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
}

export function findSessionByAdapterId(
	adapterId: string,
	projectDir: string,
	baseDir?: string,
): AthenaSession | null {
	const dir = baseDir ?? sessionsDir();
	if (!fs.existsSync(dir)) return null;

	const entries = fs.readdirSync(dir, {withFileTypes: true});
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dbPath = path.join(dir, entry.name, 'session.db');
		const session = readSessionFromDb(dbPath);
		if (
			session &&
			(!projectDir || session.projectDir === projectDir) &&
			session.adapterSessionIds.includes(adapterId)
		) {
			return session;
		}
	}
	return null;
}

export function getMostRecentAthenaSession(
	projectDir: string,
): AthenaSession | null {
	const sessions = listSessions(projectDir);
	return sessions[0] ?? null;
}
