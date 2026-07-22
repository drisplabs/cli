import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Applies DDL and version-delta migrations against an already-open database.
 * `fromVersion` is the on-disk schema version, or `undefined` for a fresh
 * database that has no `schema_version` row yet (in which case the caller
 * stamps the target version after this returns).
 */
export type SchemaMigrator = (
	db: Database.Database,
	fromVersion: number | undefined,
) => void;

export type VersionedSchema = {
	/** The schema version this build writes and can read. */
	version: number;
	migrate: SchemaMigrator;
	/** Builds the error thrown when the on-disk version is newer than `version`. */
	onNewerVersion?: (found: number, expected: number) => Error;
};

/**
 * Runs the shared `schema_version` guard against an already-open database:
 * ensures the version table exists, rejects forward-incompatible databases,
 * applies the migration, and stamps the version for a fresh database. Callers
 * are responsible for connection pragmas (journal mode, foreign keys) before
 * invoking this.
 */
export function migrateVersionedSchema(
	db: Database.Database,
	schema: VersionedSchema,
): void {
	db.exec(
		'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)',
	);
	const existing = db.prepare('SELECT version FROM schema_version').get() as
		| {version: number}
		| undefined;
	if (existing && existing.version > schema.version) {
		throw (
			schema.onNewerVersion?.(existing.version, schema.version) ??
			new Error(
				`Database has newer schema version ${existing.version} (expected <= ${schema.version}).`,
			)
		);
	}
	// The delta and its version stamp must land together. SQLite auto-commits
	// every `exec`, so an interrupted migration would otherwise leave the DDL
	// applied with `schema_version` still on the old value — the next open
	// replays the same `ALTER` and fails with `duplicate column name`, making
	// the file permanently unopenable with no repair path.
	db.transaction(() => {
		schema.migrate(db, existing?.version);
		if (!existing) {
			db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(
				schema.version,
			);
		}
	})();
}

export type OpenVersionedDbOptions = {
	/**
	 * Target schema version. Omit for a versionless database (no `schema_version`
	 * guard); `migrate` is then invoked once with `fromVersion` undefined.
	 */
	version?: number;
	migrate: SchemaMigrator;
	onNewerVersion?: (found: number, expected: number) => Error;
	/** Enable SQLite foreign-key enforcement on the connection. */
	foreignKeys?: boolean;
	/** Create the parent directory (recursively) for file-based databases. */
	ensureDir?: boolean;
	/** Directory mode used when `ensureDir` creates the parent directory. */
	dirMode?: number;
};

/**
 * The one place that opens an on-disk SQLite database and brings its schema up
 * to date. Ensures the parent directory exists, opens the connection, sets the
 * WAL journal mode (and optionally foreign keys), then runs the versioned
 * schema guard/migration. Returns the open handle for the caller to own and
 * close.
 */
export function openVersionedDb(
	dbPath: string,
	options: OpenVersionedDbOptions,
): Database.Database {
	if (options.ensureDir && dbPath !== ':memory:') {
		fs.mkdirSync(path.dirname(dbPath), {
			recursive: true,
			...(options.dirMode !== undefined ? {mode: options.dirMode} : {}),
		});
	}
	const db = new Database(dbPath);
	db.exec('PRAGMA journal_mode = WAL');
	if (options.foreignKeys) {
		db.exec('PRAGMA foreign_keys = ON');
	}
	if (options.version === undefined) {
		options.migrate(db, undefined);
	} else {
		migrateVersionedSchema(db, {
			version: options.version,
			migrate: options.migrate,
			...(options.onNewerVersion
				? {onNewerVersion: options.onNewerVersion}
				: {}),
		});
	}
	return db;
}
