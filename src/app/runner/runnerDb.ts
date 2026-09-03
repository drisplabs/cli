import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {openVersionedDb} from '../../infra/db/openVersionedDb';
import {
	ensureRunnerStateDir,
	runnerStatePaths,
} from '../../infra/daemon/stateDir';

/**
 * `runner.db` — the one SQLite database the `drisp runner` process owns
 * (ADR 0006: one owner, shared open). It holds
 *
 *   - `dashboard_feed_outbox`: the durable queue of FeedEvents waiting for the
 *     hub's `feed_ack`, drained by the paired feed publisher;
 *   - `dashboard_decision_inbox`: the hub's `answer`s waiting for the local
 *     Run they address to consume them.
 *
 * Both tables keep the shape they had in their former standalone files
 * (`dashboard-feed-outbox.db`, `dashboard-decision-inbox.db`); on the first
 * open that finds either legacy file beside `runner.db` its rows are copied in
 * and the file is removed, so the import runs once and a re-run is a no-op.
 *
 * Per-session data (`session.db`, `feed_events`, `runtime_events`) stays per
 * session and is deliberately not here.
 *
 * The runner opens the file once and hands the handle to the outbox and the
 * inbox; a local `drisp run` or the interactive TUI, which enqueue feed events
 * and drain decisions without a runner in the process, open their own handle
 * to the same file (WAL) — the shared-open pattern.
 */

export const RUNNER_DB_SCHEMA_VERSION = 1;
export const LEGACY_FEED_OUTBOX_FILENAME = 'dashboard-feed-outbox.db';
export const LEGACY_DECISION_INBOX_FILENAME = 'dashboard-decision-inbox.db';

export type RunnerDbLogger = (
	level: 'debug' | 'info' | 'warn' | 'error',
	message: string,
) => void;

export type RunnerDbLegacyStore = 'feed-outbox' | 'decision-inbox';

export type RunnerDbLegacyImport = {
	store: RunnerDbLegacyStore;
	/** The legacy file that was imported (and then removed). */
	path: string;
	/** Rows copied into runner.db (rows already present are skipped). */
	rows: number;
};

export type RunnerDbOpenReport = {
	path: string;
	/** True when this open created the file. */
	created: boolean;
	/** Legacy stores imported by this open, in the order they were processed. */
	imports: RunnerDbLegacyImport[];
};

export type RunnerDb = {
	readonly db: Database.Database;
	readonly path: string;
	readonly report: RunnerDbOpenReport;
	close(): void;
};

export type OpenRunnerDbOptions = {
	/** Defaults to `runner.db` in the runner state dir. */
	dbPath?: string;
	log?: RunnerDbLogger;
};

export function runnerDbPath(env: NodeJS.ProcessEnv = process.env): string {
	return runnerStatePaths(env).dbPath;
}

function applyRunnerSchema(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS dashboard_feed_outbox (
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

		CREATE INDEX IF NOT EXISTS idx_dashboard_feed_outbox_pending
			ON dashboard_feed_outbox(acked_at, next_attempt_at, delivery_seq);

		CREATE TABLE IF NOT EXISTS dashboard_decision_inbox (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			athena_session_id TEXT NOT NULL,
			request_id TEXT NOT NULL,
			decision_json TEXT NOT NULL,
			received_at INTEGER NOT NULL,
			consumed_at INTEGER
		);

		CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_decision_unconsumed
			ON dashboard_decision_inbox(athena_session_id, request_id)
			WHERE consumed_at IS NULL;

		CREATE INDEX IF NOT EXISTS idx_dashboard_decision_pending
			ON dashboard_decision_inbox(athena_session_id, consumed_at, id);
	`);
}

const LEGACY_STORES: ReadonlyArray<{
	store: RunnerDbLegacyStore;
	filename: string;
	table: string;
	columns: string[];
	orderBy: string;
}> = [
	{
		store: 'feed-outbox',
		filename: LEGACY_FEED_OUTBOX_FILENAME,
		table: 'dashboard_feed_outbox',
		columns: [
			'delivery_seq',
			'instance_id',
			'athena_session_id',
			'run_id',
			'origin',
			'event_id',
			'emitted_at',
			'feed_event_json',
			'attempt',
			'next_attempt_at',
			'last_error',
			'acked_at',
		],
		orderBy: 'delivery_seq',
	},
	{
		store: 'decision-inbox',
		filename: LEGACY_DECISION_INBOX_FILENAME,
		table: 'dashboard_decision_inbox',
		columns: [
			'id',
			'athena_session_id',
			'request_id',
			'decision_json',
			'received_at',
			'consumed_at',
		],
		orderBy: 'id',
	},
];

function removeSqliteFiles(dbPath: string): void {
	for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
		try {
			fs.unlinkSync(candidate);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
		}
	}
}

/**
 * Copy the rows of one legacy store into runner.db and remove the file.
 * Returns the import, or `null` when the store is absent or unreadable (an
 * unreadable store is left in place and reported through `log`, so the
 * runner still starts).
 */
function importLegacyStore(
	db: Database.Database,
	dir: string,
	spec: (typeof LEGACY_STORES)[number],
	log: RunnerDbLogger,
): RunnerDbLegacyImport | null {
	const legacyPath = path.join(dir, spec.filename);
	if (!fs.existsSync(legacyPath)) return null;
	let attached = false;
	try {
		db.prepare('ATTACH DATABASE ? AS legacy').run(legacyPath);
		attached = true;
		const hasTable = db
			.prepare(
				`SELECT name FROM legacy.sqlite_master WHERE type = 'table' AND name = ?`,
			)
			.get(spec.table) as {name: string} | undefined;
		let rows = 0;
		if (hasTable) {
			const columns = spec.columns.join(', ');
			// Explicit ids keep delivery sequence numbers (the feed ack key and
			// the hub's feedSeq ordering) and inbox ids exactly as they were;
			// `OR IGNORE` makes a second pass over the same rows a no-op.
			const copy = db.prepare(
				`INSERT OR IGNORE INTO main.${spec.table} (${columns})
				 SELECT ${columns} FROM legacy.${spec.table}
				 ORDER BY ${spec.orderBy} ASC`,
			);
			rows = db.transaction(() => copy.run().changes)();
		}
		db.exec('DETACH DATABASE legacy');
		attached = false;
		removeSqliteFiles(legacyPath);
		log(
			'info',
			`runner.db: imported ${rows} row(s) from legacy ${spec.store} store ${legacyPath}`,
		);
		return {store: spec.store, path: legacyPath, rows};
	} catch (err) {
		if (attached) {
			try {
				db.exec('DETACH DATABASE legacy');
			} catch {
				// best-effort; the handle is still usable for main
			}
		}
		log(
			'warn',
			`runner.db: could not import legacy ${spec.store} store ${legacyPath}; leaving it in place: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return null;
	}
}

/**
 * Open (creating if needed) `runner.db`, bring its schema up to date, and
 * import any legacy store found beside it. The returned handle is the one the
 * owner shares with `createDashboardFeedOutbox({db})` and
 * `createDashboardDecisionInbox({db})`.
 */
export function openRunnerDb(options: OpenRunnerDbOptions = {}): RunnerDb {
	const log = options.log ?? (() => {});
	const dbPath = options.dbPath ?? ensureRunnerStateDir().dbPath;
	const created = !fs.existsSync(dbPath);
	const db = openVersionedDb(dbPath, {
		version: RUNNER_DB_SCHEMA_VERSION,
		ensureDir: true,
		dirMode: 0o700,
		migrate: applyRunnerSchema,
		onNewerVersion: (found, expected) =>
			new Error(
				`runner.db at ${dbPath} was written by a newer drisp (schema ${found}; this build reads <= ${expected}). Upgrade drisp or remove the file.`,
			),
	});
	const imports: RunnerDbLegacyImport[] = [];
	if (dbPath !== ':memory:') {
		const dir = path.dirname(dbPath);
		for (const spec of LEGACY_STORES) {
			const imported = importLegacyStore(db, dir, spec, log);
			if (imported) imports.push(imported);
		}
	}
	let closed = false;
	return {
		db,
		path: dbPath,
		report: {path: dbPath, created, imports},
		close() {
			if (closed) return;
			closed = true;
			db.close();
		},
	};
}
