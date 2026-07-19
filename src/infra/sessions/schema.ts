import type Database from 'better-sqlite3';
import {
	migrateVersionedSchema,
	type SchemaMigrator,
	type VersionedSchema,
} from '../db/openVersionedDb';

export const SCHEMA_VERSION = 6;

/**
 * Applies the session.db schema against an open connection: the latest base
 * DDL (idempotent) followed by version-delta migrations for an existing
 * database. The version guard and fresh-database stamping live in the shared
 * `openVersionedDb` primitive; this only owns the session-specific tables and
 * their upgrade steps.
 */
const applySessionSchema: SchemaMigrator = (db, fromVersion) => {
	db.exec(`
		CREATE TABLE IF NOT EXISTS session (
			id TEXT PRIMARY KEY,
			project_dir TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			label TEXT,
			event_count INTEGER DEFAULT 0
		);

		CREATE TABLE IF NOT EXISTS runtime_events (
			id TEXT PRIMARY KEY,
			seq INTEGER NOT NULL UNIQUE,
			timestamp INTEGER NOT NULL,
			hook_name TEXT NOT NULL,
			adapter_session_id TEXT,
			payload JSON NOT NULL
		);

		CREATE TABLE IF NOT EXISTS feed_events (
			event_id TEXT PRIMARY KEY,
			runtime_event_id TEXT,
			seq INTEGER NOT NULL,
			kind TEXT NOT NULL,
			run_id TEXT NOT NULL,
			actor_id TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			data JSON NOT NULL,
			FOREIGN KEY (runtime_event_id) REFERENCES runtime_events(id)
		);

		CREATE TABLE IF NOT EXISTS adapter_sessions (
			session_id TEXT PRIMARY KEY,
			started_at INTEGER NOT NULL,
			ended_at INTEGER,
			model TEXT,
			source TEXT,
			tokens_input INTEGER,
			tokens_output INTEGER,
			tokens_cache_read INTEGER,
			tokens_cache_write INTEGER,
			tokens_context_size INTEGER,
			tokens_context_window_size INTEGER,
			run_id TEXT REFERENCES workflow_runs(id)
		);

		CREATE TABLE IF NOT EXISTS workflow_runs (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			workflow_name TEXT,
			started_at INTEGER NOT NULL,
			ended_at INTEGER,
			iteration INTEGER NOT NULL DEFAULT 0,
			max_iterations INTEGER NOT NULL DEFAULT 1,
			status TEXT NOT NULL DEFAULT 'running',
			stop_reason TEXT,
			tracker_path TEXT,
			FOREIGN KEY (session_id) REFERENCES session(id)
		);

		-- Durable retry queue for outbound channel sends. Drained by the gateway
		-- daemon on startup and after transient send failures.
		CREATE TABLE IF NOT EXISTS channel_outbox (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			channel_id TEXT NOT NULL,
			account_id TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			attempt INTEGER NOT NULL DEFAULT 0,
			next_attempt_at INTEGER NOT NULL,
			last_error TEXT,
			created_at INTEGER NOT NULL
		);
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_feed_kind ON feed_events(kind);
		CREATE INDEX IF NOT EXISTS idx_feed_run ON feed_events(run_id);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_seq ON feed_events(seq);
		CREATE INDEX IF NOT EXISTS idx_runtime_seq ON runtime_events(seq);
		CREATE INDEX IF NOT EXISTS idx_workflow_runs_session ON workflow_runs(session_id);
		CREATE INDEX IF NOT EXISTS idx_outbox_due ON channel_outbox(next_attempt_at);
	`);

	// Fresh database: base DDL above is the whole schema; the primitive stamps
	// the target version.
	if (fromVersion === undefined) return;
	// Already at (or ahead of) the target: nothing to migrate.
	if (fromVersion >= SCHEMA_VERSION) return;

	if (fromVersion < 2) {
		// v1 was never shipped. Reject incompatible dev DBs rather than
		// maintaining migration complexity for data no real user has.
		throw new Error(
			`Session database is at schema version ${fromVersion} which predates the first release. ` +
				`Delete the session database and start fresh.`,
		);
	}
	if (fromVersion === 2) {
		db.exec(`
			ALTER TABLE adapter_sessions ADD COLUMN tokens_input INTEGER;
			ALTER TABLE adapter_sessions ADD COLUMN tokens_output INTEGER;
			ALTER TABLE adapter_sessions ADD COLUMN tokens_cache_read INTEGER;
			ALTER TABLE adapter_sessions ADD COLUMN tokens_cache_write INTEGER;
			ALTER TABLE adapter_sessions ADD COLUMN tokens_context_size INTEGER;
			ALTER TABLE adapter_sessions ADD COLUMN tokens_context_window_size INTEGER;
			UPDATE schema_version SET version = 4;
		`);
	}
	if (fromVersion === 3) {
		db.exec(`
			ALTER TABLE adapter_sessions ADD COLUMN tokens_context_window_size INTEGER;
			UPDATE schema_version SET version = 4;
		`);
	}

	// Re-read version after prior migrations
	const currentVersion = (
		db.prepare('SELECT version FROM schema_version').get() as {
			version: number;
		}
	).version;
	if (currentVersion === 4) {
		db.exec(`
			CREATE TABLE IF NOT EXISTS workflow_runs (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				workflow_name TEXT,
				started_at INTEGER NOT NULL,
				ended_at INTEGER,
				iteration INTEGER NOT NULL DEFAULT 0,
				max_iterations INTEGER NOT NULL DEFAULT 1,
				status TEXT NOT NULL DEFAULT 'running',
				stop_reason TEXT,
				tracker_path TEXT,
				FOREIGN KEY (session_id) REFERENCES session(id)
			);
			CREATE INDEX IF NOT EXISTS idx_workflow_runs_session ON workflow_runs(session_id);
			ALTER TABLE adapter_sessions ADD COLUMN run_id TEXT REFERENCES workflow_runs(id);
			UPDATE schema_version SET version = 5;
		`);
	}

	const versionAfterV5 = (
		db.prepare('SELECT version FROM schema_version').get() as {
			version: number;
		}
	).version;
	if (versionAfterV5 === 5) {
		// v6 originally also created `channel_messages` and
		// `gateway_function_invocations`; both shipped without any production
		// reader/writer and were dropped from the DDL (ADR 0006). Databases
		// already migrated to v6 keep those empty tables harmlessly.
		db.exec(`
			CREATE TABLE IF NOT EXISTS channel_outbox (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				channel_id TEXT NOT NULL,
				account_id TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				attempt INTEGER NOT NULL DEFAULT 0,
				next_attempt_at INTEGER NOT NULL,
				last_error TEXT,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_outbox_due ON channel_outbox(next_attempt_at);
			UPDATE schema_version SET version = 6;
		`);
	}
};

/**
 * The versioned schema descriptor for session.db, consumed by the shared
 * `openVersionedDb` primitive (see `store.ts`).
 */
export const SESSION_SCHEMA: VersionedSchema = {
	version: SCHEMA_VERSION,
	migrate: applySessionSchema,
	onNewerVersion: (found, expected) =>
		new Error(
			`Database has newer schema version ${found} (expected <= ${expected}). ` +
				`Update athena-cli to open this session.`,
		),
};

/**
 * Brings an already-open session.db connection up to the current schema. Sets
 * the connection pragmas then runs the shared version guard/migration. Used for
 * in-place initialization (e.g. tests operating on a caller-owned handle);
 * production opens go through `openVersionedDb` with {@link SESSION_SCHEMA}.
 */
export function initSchema(db: Database.Database): void {
	db.exec('PRAGMA journal_mode = WAL');
	db.exec('PRAGMA foreign_keys = ON');
	migrateVersionedSchema(db, SESSION_SCHEMA);
}
