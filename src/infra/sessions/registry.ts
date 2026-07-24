import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {AthenaSession, PersistedWorkflowRun} from './types';
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

/**
 * The most recent Workflow Run persisted for an Athena Session, read from its
 * session.db, or null when the session (or any run) does not exist. Used by
 * the human-resume path to target the suspended Run's Agent Session and run
 * id (ADR 0014 §6).
 */
export function getLatestRunForSession(
	sessionId: string,
	baseDir?: string,
): PersistedWorkflowRun | null {
	const dbPath = path.join(baseDir ?? sessionsDir(), sessionId, 'session.db');
	if (!fs.existsSync(dbPath)) return null;
	let reader: SessionDbReader | undefined;
	try {
		reader = openSessionDbReadonly(dbPath);
		return reader.latestWorkflowRun() ?? null;
	} catch {
		return null;
	} finally {
		reader?.close();
	}
}

/** A suspended Workflow Run awaiting a human, with why and how to wake it. */
export type AwaitingAttentionRun = {
	athenaSessionId: string;
	projectDir: string;
	runId: string;
	workflowName?: string;
	stopReason?: string;
	adapterSessionId?: string;
	startedAt: number;
	sessionUpdatedAt: number;
};

/**
 * Every Workflow Run currently suspended in `awaiting_attention` — the
 * human-facing inbox of Runs waiting on a reply (ADR 0014 §7). Scans each
 * session's most recent run; older runs of a session that has since moved on
 * are not "awaiting" anymore.
 */
export function listAwaitingAttentionRuns(
	projectDir?: string,
	baseDir?: string,
): AwaitingAttentionRun[] {
	const dir = baseDir ?? sessionsDir();
	if (!fs.existsSync(dir)) return [];

	const results: AwaitingAttentionRun[] = [];
	for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
		if (!entry.isDirectory()) continue;
		const dbPath = path.join(dir, entry.name, 'session.db');
		const session = readSessionFromDb(dbPath);
		if (!session) continue;
		if (projectDir && session.projectDir !== projectDir) continue;

		const run = getLatestRunForSession(entry.name, dir);
		if (!run || run.status !== 'awaiting_attention') continue;
		results.push({
			athenaSessionId: session.id,
			projectDir: session.projectDir,
			runId: run.id,
			workflowName: run.workflowName,
			stopReason: run.stopReason,
			adapterSessionId: run.adapterSessionId,
			startedAt: run.startedAt,
			sessionUpdatedAt: session.updatedAt,
		});
	}

	return results.sort((a, b) => b.sessionUpdatedAt - a.sessionUpdatedAt);
}
