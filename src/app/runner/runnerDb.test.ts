import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {afterEach, describe, expect, it} from 'vitest';
import {
	LEGACY_DECISION_INBOX_FILENAME,
	LEGACY_FEED_OUTBOX_FILENAME,
	RUNNER_DB_SCHEMA_VERSION,
	openRunnerDb,
	runnerDbPath,
} from './runnerDb';
import {createDashboardFeedOutbox} from '../dashboard/dashboardFeedPublisher';
import {createDashboardDecisionInbox} from '../dashboard/dashboardDecisionInbox';

const tmpDirs: string[] = [];

function tempStateDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-runner-db-'));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

function tableNames(dbPath: string): string[] {
	const db = new Database(dbPath, {readonly: true});
	try {
		return (
			db
				.prepare(
					`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
				)
				.all() as Array<{name: string}>
		).map(row => row.name);
	} finally {
		db.close();
	}
}

function schemaVersion(dbPath: string): number {
	const db = new Database(dbPath, {readonly: true});
	try {
		return (
			db.prepare('SELECT version FROM schema_version').get() as {
				version: number;
			}
		).version;
	} finally {
		db.close();
	}
}

/** The feed outbox exactly as the pre-runner daemon wrote it. */
function writeLegacyOutbox(dir: string, rows: number): string {
	const dbPath = path.join(dir, LEGACY_FEED_OUTBOX_FILENAME);
	const db = new Database(dbPath);
	db.exec('PRAGMA journal_mode = WAL');
	db.exec(`
		CREATE TABLE dashboard_feed_outbox (
			delivery_seq INTEGER PRIMARY KEY AUTOINCREMENT,
			instance_id TEXT NOT NULL,
			athena_session_id TEXT NOT NULL,
			run_id TEXT NOT NULL,
			origin TEXT NOT NULL CHECK(origin IN ('local', 'dashboard')),
			event_id TEXT NOT NULL,
			emitted_at INTEGER NOT NULL,
			feed_event_json TEXT NOT NULL,
			attempt INTEGER NOT NULL DEFAULT 0,
			next_attempt_at INTEGER NOT NULL,
			last_error TEXT,
			acked_at INTEGER,
			UNIQUE(instance_id, event_id)
		);
	`);
	const insert = db.prepare(`
		INSERT INTO dashboard_feed_outbox (
			instance_id, athena_session_id, run_id, origin, event_id,
			emitted_at, feed_event_json, attempt, next_attempt_at, acked_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	for (let i = 1; i <= rows; i += 1) {
		insert.run(
			'inst-legacy',
			'athena-legacy',
			'run-legacy',
			'local',
			`athena-legacy:feed-${i}`,
			1_000 + i,
			JSON.stringify({
				event_id: `feed-${i}`,
				seq: i,
				ts: 1_000 + i,
				session_id: 'adapter-legacy',
				run_id: 'run-legacy',
				kind: 'notification',
				level: 'info',
				actor_id: 'agent:root',
				title: `Legacy ${i}`,
				data: {message: `legacy ${i}`},
			}),
			i - 1,
			1_000 + i,
			// The first row was already acked; the rest are still pending.
			i === 1 ? 2_000 : null,
		);
	}
	db.close();
	return dbPath;
}

/**
 * The decision inbox as the pre-runner daemon wrote it — including the
 * oldest shape, with a full UNIQUE constraint instead of the partial index.
 */
function writeLegacyInbox(
	dir: string,
	shape: 'partial-index' | 'unique-constraint',
): string {
	const dbPath = path.join(dir, LEGACY_DECISION_INBOX_FILENAME);
	const db = new Database(dbPath);
	db.exec('PRAGMA journal_mode = WAL');
	db.exec(`
		CREATE TABLE dashboard_decision_inbox (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			athena_session_id TEXT NOT NULL,
			request_id TEXT NOT NULL,
			decision_json TEXT NOT NULL,
			received_at INTEGER NOT NULL,
			consumed_at INTEGER${
				shape === 'unique-constraint'
					? ',\n\t\t\tUNIQUE(athena_session_id, request_id)'
					: ''
			}
		);
	`);
	if (shape === 'partial-index') {
		db.exec(`
			CREATE UNIQUE INDEX idx_dashboard_decision_unconsumed
				ON dashboard_decision_inbox(athena_session_id, request_id)
				WHERE consumed_at IS NULL;
		`);
	}
	const insert = db.prepare(`
		INSERT INTO dashboard_decision_inbox (
			athena_session_id, request_id, decision_json, received_at, consumed_at
		) VALUES (?, ?, ?, ?, ?)
	`);
	insert.run(
		'athena-legacy',
		'req-consumed',
		JSON.stringify({
			type: 'json',
			source: 'user',
			intent: {kind: 'permission_deny', reason: 'old'},
		}),
		100,
		150,
	);
	insert.run(
		'athena-legacy',
		'req-pending',
		JSON.stringify({
			type: 'json',
			source: 'user',
			intent: {kind: 'permission_allow'},
		}),
		200,
		null,
	);
	db.close();
	return dbPath;
}

describe('runnerDbPath', () => {
	it('lives in the runner state dir as runner.db', () => {
		const stateDir = tempStateDir();
		expect(runnerDbPath({XDG_STATE_HOME: stateDir, HOME: stateDir})).toBe(
			path.join(stateDir, 'drisp', 'runner.db'),
		);
	});
});

describe('openRunnerDb: fresh', () => {
	it('creates one versioned database holding the feed outbox and the decision inbox', () => {
		const dbPath = path.join(tempStateDir(), 'runner.db');
		const runnerDb = openRunnerDb({dbPath});
		expect(runnerDb.path).toBe(dbPath);
		expect(runnerDb.report).toEqual({
			path: dbPath,
			created: true,
			imports: [],
		});
		runnerDb.close();

		expect(tableNames(dbPath)).toEqual(
			expect.arrayContaining([
				'dashboard_decision_inbox',
				'dashboard_feed_outbox',
				'schema_version',
			]),
		);
		expect(schemaVersion(dbPath)).toBe(RUNNER_DB_SCHEMA_VERSION);
	});

	it('re-opens an existing database without changing it', () => {
		const dbPath = path.join(tempStateDir(), 'runner.db');
		openRunnerDb({dbPath}).close();
		const reopened = openRunnerDb({dbPath});
		expect(reopened.report.created).toBe(false);
		expect(reopened.report.imports).toEqual([]);
		reopened.close();
		expect(schemaVersion(dbPath)).toBe(RUNNER_DB_SCHEMA_VERSION);
	});

	it('refuses a database written by a newer runner', () => {
		const dbPath = path.join(tempStateDir(), 'runner.db');
		openRunnerDb({dbPath}).close();
		const db = new Database(dbPath);
		db.prepare('UPDATE schema_version SET version = ?').run(
			RUNNER_DB_SCHEMA_VERSION + 1,
		);
		db.close();
		expect(() => openRunnerDb({dbPath})).toThrow(/newer/i);
	});

	it('lets the outbox and the inbox share the one open handle', () => {
		const dbPath = path.join(tempStateDir(), 'runner.db');
		const runnerDb = openRunnerDb({dbPath});
		const outbox = createDashboardFeedOutbox({db: runnerDb.db});
		const inbox = createDashboardDecisionInbox({db: runnerDb.db});

		outbox.enqueue({
			instanceId: 'inst-1',
			athenaSessionId: 'athena-1',
			origin: 'local',
			emittedAt: 5,
			feedEvents: [
				{
					event_id: 'feed-1',
					seq: 1,
					ts: 5,
					session_id: 'adapter-1',
					run_id: 'run-1',
					kind: 'notification',
					level: 'info',
					actor_id: 'agent:root',
					title: 'Notice',
					data: {message: 'shared handle'},
				},
			],
		});
		inbox.enqueue({
			athenaSessionId: 'athena-1',
			requestId: 'req-1',
			decision: {
				type: 'json',
				source: 'user',
				intent: {kind: 'permission_allow'},
			},
			receivedAt: 6,
		});

		// Closing a sharer leaves the owner's handle open (ADR 0006: one owner).
		outbox.close();
		inbox.close();
		expect(runnerDb.db.open).toBe(true);
		expect(
			createDashboardDecisionInbox({db: runnerDb.db}).pendingForSession({
				athenaSessionId: 'athena-1',
				limit: 10,
			}),
		).toHaveLength(1);
		expect(
			createDashboardFeedOutbox({db: runnerDb.db}).pendingBatch({
				limit: 10,
				now: 10,
			}),
		).toHaveLength(1);
		runnerDb.close();
		expect(runnerDb.db.open).toBe(false);

		// A second process opens the same file (the shared-open pattern).
		const again = openRunnerDb({dbPath});
		expect(
			createDashboardFeedOutbox({db: again.db}).pendingBatch({
				limit: 10,
				now: 10,
			}),
		).toEqual([
			expect.objectContaining({
				deliverySeq: 1,
				envelope: expect.objectContaining({eventId: 'athena-1:feed-1'}),
			}),
		]);
		again.close();
	});

	it('opens runner.db on its own when no shared handle is given', () => {
		const dbPath = path.join(tempStateDir(), 'runner.db');
		const outbox = createDashboardFeedOutbox({dbPath});
		const inbox = createDashboardDecisionInbox({dbPath});
		outbox.close();
		inbox.close();
		expect(tableNames(dbPath)).toEqual(
			expect.arrayContaining([
				'dashboard_decision_inbox',
				'dashboard_feed_outbox',
				'schema_version',
			]),
		);
	});
});

describe('openRunnerDb: migration from the two legacy stores', () => {
	it('copies every row of both stores into runner.db and removes the old files', () => {
		const stateDir = tempStateDir();
		const dbPath = path.join(stateDir, 'runner.db');
		const legacyOutbox = writeLegacyOutbox(stateDir, 3);
		const legacyInbox = writeLegacyInbox(stateDir, 'partial-index');

		const runnerDb = openRunnerDb({dbPath});
		expect(runnerDb.report).toEqual({
			path: dbPath,
			created: true,
			imports: [
				{store: 'feed-outbox', path: legacyOutbox, rows: 3},
				{store: 'decision-inbox', path: legacyInbox, rows: 2},
			],
		});

		const outbox = createDashboardFeedOutbox({db: runnerDb.db});
		const pending = outbox.pendingBatch({limit: 10, now: 10_000});
		// Row 1 was already acked; rows 2 and 3 keep their delivery sequence
		// numbers, attempt counters, and envelopes.
		expect(pending.map(row => row.deliverySeq)).toEqual([2, 3]);
		expect(pending.map(row => row.attempt)).toEqual([1, 2]);
		expect(pending[0]!.envelope).toMatchObject({
			instanceId: 'inst-legacy',
			athenaSessionId: 'athena-legacy',
			eventId: 'athena-legacy:feed-2',
			feedSeq: 2,
			feedEvent: expect.objectContaining({title: 'Legacy 2'}),
		});
		// The acked row is present too, so a re-publish of the same event is
		// still de-duplicated by (instance_id, event_id).
		outbox.enqueue({
			instanceId: 'inst-legacy',
			athenaSessionId: 'athena-legacy',
			origin: 'local',
			emittedAt: 9_000,
			feedEvents: [
				{
					event_id: 'feed-1',
					seq: 1,
					ts: 9_000,
					session_id: 'adapter-legacy',
					run_id: 'run-legacy',
					kind: 'notification',
					level: 'info',
					actor_id: 'agent:root',
					title: 'Legacy 1 again',
					data: {message: 'dup'},
				},
			],
		});
		expect(
			outbox.pendingBatch({limit: 10, now: 10_000}).map(r => r.deliverySeq),
		).toEqual([2, 3]);

		const inbox = createDashboardDecisionInbox({db: runnerDb.db});
		expect(
			inbox.pendingForSession({athenaSessionId: 'athena-legacy', limit: 10}),
		).toEqual([
			expect.objectContaining({
				id: 2,
				requestId: 'req-pending',
				receivedAt: 200,
				decision: expect.objectContaining({intent: {kind: 'permission_allow'}}),
			}),
		]);
		runnerDb.close();

		for (const legacy of [legacyOutbox, legacyInbox]) {
			expect(fs.existsSync(legacy)).toBe(false);
			expect(fs.existsSync(`${legacy}-wal`)).toBe(false);
			expect(fs.existsSync(`${legacy}-shm`)).toBe(false);
		}
	});

	it('is idempotent: a second open imports nothing and duplicates nothing', () => {
		const stateDir = tempStateDir();
		const dbPath = path.join(stateDir, 'runner.db');
		writeLegacyOutbox(stateDir, 2);
		writeLegacyInbox(stateDir, 'partial-index');
		openRunnerDb({dbPath}).close();

		const second = openRunnerDb({dbPath});
		expect(second.report).toEqual({path: dbPath, created: false, imports: []});
		const rows = second.db
			.prepare('SELECT COUNT(*) AS n FROM dashboard_feed_outbox')
			.get() as {n: number};
		const decisions = second.db
			.prepare('SELECT COUNT(*) AS n FROM dashboard_decision_inbox')
			.get() as {n: number};
		expect(rows.n).toBe(2);
		expect(decisions.n).toBe(2);
		second.close();
	});

	it('does not duplicate rows when a legacy store reappears after the import', () => {
		// A pre-runner CLI still running during the upgrade could recreate a
		// legacy file; the unique keys keep the import from doubling rows.
		const stateDir = tempStateDir();
		const dbPath = path.join(stateDir, 'runner.db');
		writeLegacyOutbox(stateDir, 2);
		openRunnerDb({dbPath}).close();
		writeLegacyOutbox(stateDir, 3);

		const again = openRunnerDb({dbPath});
		expect(again.report.imports).toEqual([
			expect.objectContaining({store: 'feed-outbox', rows: 1}),
		]);
		const rows = again.db
			.prepare('SELECT COUNT(*) AS n FROM dashboard_feed_outbox')
			.get() as {n: number};
		expect(rows.n).toBe(3);
		again.close();
	});

	it('imports the oldest inbox shape (full UNIQUE constraint) into the partial-index table', () => {
		const stateDir = tempStateDir();
		const dbPath = path.join(stateDir, 'runner.db');
		writeLegacyInbox(stateDir, 'unique-constraint');

		const runnerDb = openRunnerDb({dbPath});
		expect(runnerDb.report.imports).toEqual([
			expect.objectContaining({store: 'decision-inbox', rows: 2}),
		]);
		const inbox = createDashboardDecisionInbox({db: runnerDb.db});
		// Under the legacy UNIQUE constraint a consumed request could never
		// receive a later decision; in runner.db it can.
		inbox.enqueue({
			athenaSessionId: 'athena-legacy',
			requestId: 'req-consumed',
			decision: {
				type: 'json',
				source: 'user',
				intent: {kind: 'permission_allow'},
			},
			receivedAt: 300,
		});
		expect(
			inbox
				.pendingForSession({athenaSessionId: 'athena-legacy', limit: 10})
				.map(row => row.requestId),
		).toEqual(['req-pending', 'req-consumed']);
		runnerDb.close();
	});

	it('leaves an unreadable legacy store in place, reports it, and still opens runner.db', () => {
		const stateDir = tempStateDir();
		const dbPath = path.join(stateDir, 'runner.db');
		const corrupt = path.join(stateDir, LEGACY_FEED_OUTBOX_FILENAME);
		fs.writeFileSync(corrupt, 'this is not a sqlite database\n');
		const warnings: string[] = [];

		const runnerDb = openRunnerDb({
			dbPath,
			log: (level, message) => {
				if (level === 'warn') warnings.push(message);
			},
		});
		expect(runnerDb.report.imports).toEqual([]);
		expect(warnings.join('\n')).toMatch(/feed-outbox/);
		expect(fs.existsSync(corrupt)).toBe(true);
		expect(
			createDashboardFeedOutbox({db: runnerDb.db}).pendingBatch({
				limit: 10,
				now: 1,
			}),
		).toEqual([]);
		runnerDb.close();
	});
});
