import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createSessionStore} from './store';
import {
	listSessions,
	getSessionMeta,
	removeSession,
	getMostRecentAthenaSession,
	getLatestRunForSession,
	listAwaitingAttentionRuns,
	findSessionByAdapterId,
	sessionsDir,
} from './registry';
import type {RuntimeEvent} from '../../core/runtime/types';
import type {FeedEvent} from '../../core/feed/types';
import {mapLegacyHookNameToRuntimeKind} from '../../core/runtime/events';

let dummySeq = 0;

function makeDummyEvent(id: string, adapterId: string): RuntimeEvent {
	return {
		id,
		timestamp: Date.now(),
		kind: mapLegacyHookNameToRuntimeKind('SessionStart'),
		data: {hook_event_name: 'SessionStart', session_id: adapterId},
		hookName: 'SessionStart',
		sessionId: adapterId,
		context: {cwd: '/project', transcriptPath: '/tmp/t.jsonl'},
		interaction: {expectsDecision: false},
		payload: {hook_event_name: 'SessionStart', session_id: adapterId},
	};
}

function makeDummyFeedEvent(eventId: string): FeedEvent {
	dummySeq++;
	return {
		event_id: eventId,
		seq: dummySeq,
		kind: 'session_start',
		run_id: 'run-1',
		actor_id: 'agent',
		ts: Date.now(),
	} as FeedEvent;
}

describe('session registry', () => {
	let tmpDir: string;
	let originalHome: string;

	beforeEach(() => {
		dummySeq = 0;
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-sessions-'));
		originalHome = process.env['HOME']!;
		// Override HOME so sessionsDir() resolves to our tmpDir
		process.env['HOME'] = tmpDir;
		// Create the sessions directory
		fs.mkdirSync(sessionsDir(), {recursive: true});
	});

	afterEach(() => {
		process.env['HOME'] = originalHome;
		fs.rmSync(tmpDir, {recursive: true, force: true});
	});

	it('lists sessions from disk', () => {
		// Create two sessions via store and give them events so they appear
		const s1 = createSessionStore({
			sessionId: 'sess-1',
			projectDir: '/proj/a',
			dbPath: path.join(sessionsDir(), 'sess-1', 'session.db'),
		});
		s1.recordEvent(makeDummyEvent('ev-1', 'adapter-1'), [
			makeDummyFeedEvent('fe-1'),
		]);
		s1.close();

		const s2 = createSessionStore({
			sessionId: 'sess-2',
			projectDir: '/proj/b',
			dbPath: path.join(sessionsDir(), 'sess-2', 'session.db'),
		});
		s2.recordEvent(makeDummyEvent('ev-2', 'adapter-2'), [
			makeDummyFeedEvent('fe-2'),
		]);
		s2.close();

		const sessions = listSessions();
		expect(sessions).toHaveLength(2);
		expect(sessions.map(s => s.id)).toContain('sess-1');
		expect(sessions.map(s => s.id)).toContain('sess-2');
	});

	it('excludes sessions with zero events', () => {
		// Session with events — should appear
		const s1 = createSessionStore({
			sessionId: 'sess-with-events',
			projectDir: '/proj/a',
			dbPath: path.join(sessionsDir(), 'sess-with-events', 'session.db'),
		});
		s1.recordEvent(makeDummyEvent('ev-1', 'adapter-1'), [
			makeDummyFeedEvent('fe-1'),
		]);
		s1.close();

		// Session without events — should NOT appear
		const s2 = createSessionStore({
			sessionId: 'sess-empty',
			projectDir: '/proj/a',
			dbPath: path.join(sessionsDir(), 'sess-empty', 'session.db'),
		});
		s2.close();

		const sessions = listSessions();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]!.id).toBe('sess-with-events');
	});

	it('filters sessions by projectDir', () => {
		const s1 = createSessionStore({
			sessionId: 'sess-a',
			projectDir: '/proj/a',
			dbPath: path.join(sessionsDir(), 'sess-a', 'session.db'),
		});
		s1.recordEvent(makeDummyEvent('ev-a', 'adapter-a'), [
			makeDummyFeedEvent('fe-a'),
		]);
		s1.close();

		const s2 = createSessionStore({
			sessionId: 'sess-b',
			projectDir: '/proj/b',
			dbPath: path.join(sessionsDir(), 'sess-b', 'session.db'),
		});
		s2.recordEvent(makeDummyEvent('ev-b', 'adapter-b'), [
			makeDummyFeedEvent('fe-b'),
		]);
		s2.close();

		const filtered = listSessions('/proj/a');
		expect(filtered).toHaveLength(1);
		expect(filtered[0]!.id).toBe('sess-a');
	});

	it('gets session metadata by ID', () => {
		const store = createSessionStore({
			sessionId: 'sess-x',
			projectDir: '/my/proj',
			dbPath: path.join(sessionsDir(), 'sess-x', 'session.db'),
		});
		store.updateLabel('my label');
		store.close();

		const meta = getSessionMeta('sess-x');
		expect(meta).not.toBeNull();
		expect(meta!.projectDir).toBe('/my/proj');
		expect(meta!.label).toBe('my label');
	});

	it('returns null for nonexistent session', () => {
		expect(getSessionMeta('nonexistent')).toBeNull();
	});

	it('removes a session directory', () => {
		const store = createSessionStore({
			sessionId: 'sess-del',
			projectDir: '/tmp',
			dbPath: path.join(sessionsDir(), 'sess-del', 'session.db'),
		});
		store.close();

		removeSession('sess-del');
		expect(getSessionMeta('sess-del')).toBeNull();
	});

	it('gets most recent session for a project', () => {
		// Create two sessions for same project with different timestamps
		const s1 = createSessionStore({
			sessionId: 'old',
			projectDir: '/proj',
			dbPath: path.join(sessionsDir(), 'old', 'session.db'),
		});
		s1.recordEvent(makeDummyEvent('ev-old', 'adapter-old'), [
			makeDummyFeedEvent('fe-old'),
		]);
		s1.close();

		// Ensure s2 is newer
		const s2 = createSessionStore({
			sessionId: 'new',
			projectDir: '/proj',
			dbPath: path.join(sessionsDir(), 'new', 'session.db'),
		});
		s2.recordEvent(makeDummyEvent('ev-new', 'adapter-new'), [
			makeDummyFeedEvent('fe-new'),
		]);
		s2.close();

		const recent = getMostRecentAthenaSession('/proj');
		expect(recent).not.toBeNull();
		expect(recent!.id).toBe('new');
	});
});

describe('findSessionByAdapterId', () => {
	let tmpDir: string;
	const projectDir = '/test/project';

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-reg-test-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, {recursive: true, force: true});
	});

	it('finds athena session that owns a given adapter session ID', () => {
		const sessionId = 'athena-session-1';
		const dbPath = path.join(tmpDir, sessionId, 'session.db');
		const store = createSessionStore({sessionId, projectDir, dbPath});

		const runtimeEvent: RuntimeEvent = {
			id: 'req-1',
			timestamp: Date.now(),
			kind: mapLegacyHookNameToRuntimeKind('SessionStart'),
			data: {
				hook_event_name: 'SessionStart',
				session_id: 'claude-adapter-abc',
			},
			hookName: 'SessionStart',
			sessionId: 'claude-adapter-abc',
			context: {cwd: '/project', transcriptPath: '/tmp/t.jsonl'},
			interaction: {expectsDecision: false},
			payload: {
				hook_event_name: 'SessionStart',
				session_id: 'claude-adapter-abc',
			},
		};
		store.recordEvent(runtimeEvent, []);
		store.close();

		const result = findSessionByAdapterId(
			'claude-adapter-abc',
			projectDir,
			tmpDir,
		);
		expect(result).not.toBeNull();
		expect(result!.id).toBe(sessionId);
	});

	it('returns null when adapter ID not found', () => {
		const result = findSessionByAdapterId('nonexistent', projectDir, tmpDir);
		expect(result).toBeNull();
	});
});

describe('awaiting-attention run discovery (ADR 0014)', () => {
	let tmpDir: string;
	let originalHome: string;

	beforeEach(() => {
		dummySeq = 0;
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-runs-'));
		originalHome = process.env['HOME']!;
		process.env['HOME'] = tmpDir;
		fs.mkdirSync(sessionsDir(), {recursive: true});
	});

	afterEach(() => {
		process.env['HOME'] = originalHome;
		fs.rmSync(tmpDir, {recursive: true, force: true});
	});

	function seedSession(
		sessionId: string,
		runStatus: string,
		options: {stopReason?: string; adapterSessionId?: string} = {},
	): void {
		const store = createSessionStore({
			sessionId,
			projectDir: '/proj/a',
			dbPath: path.join(sessionsDir(), sessionId, 'session.db'),
		});
		store.recordEvent(
			makeDummyEvent(`ev-${sessionId}`, `adapter-${sessionId}`),
			[makeDummyFeedEvent(`fe-${sessionId}`)],
		);
		store.persistRun({
			runId: `run-${sessionId}`,
			sessionId,
			workflowName: 'default',
			iteration: 2,
			maxIterations: 20,
			status: runStatus as never,
			stopReason: options.stopReason,
			adapterSessionId: options.adapterSessionId,
		});
		store.close();
	}

	it('getLatestRunForSession reads the persisted run with its vendor session id', () => {
		seedSession('sess-s', 'awaiting_attention', {
			stopReason: 'agent declared WORKFLOW_BLOCKED: which env?',
			adapterSessionId: 'claude-sess-1',
		});

		const run = getLatestRunForSession('sess-s');
		expect(run).not.toBeNull();
		expect(run!.status).toBe('awaiting_attention');
		expect(run!.stopReason).toContain('which env?');
		expect(run!.adapterSessionId).toBe('claude-sess-1');
	});

	it('getLatestRunForSession returns null for an unknown session', () => {
		expect(getLatestRunForSession('nope')).toBeNull();
	});

	it('lists only sessions whose latest run awaits attention, newest first', () => {
		seedSession('sess-done', 'completed');
		seedSession('sess-waiting', 'awaiting_attention', {
			stopReason: 'iteration ceiling reached: 20 iterations (maxIterations)',
			adapterSessionId: 'claude-sess-w',
		});
		seedSession('sess-running', 'running');

		const runs = listAwaitingAttentionRuns();
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			athenaSessionId: 'sess-waiting',
			runId: 'run-sess-waiting',
			workflowName: 'default',
			stopReason: expect.stringContaining('iteration ceiling'),
			adapterSessionId: 'claude-sess-w',
		});
	});

	it('scopes to a project directory when given', () => {
		seedSession('sess-waiting', 'awaiting_attention', {
			stopReason: 'agent declared WORKFLOW_BLOCKED',
		});

		expect(listAwaitingAttentionRuns('/proj/a')).toHaveLength(1);
		expect(listAwaitingAttentionRuns('/proj/other')).toHaveLength(0);
	});
});
