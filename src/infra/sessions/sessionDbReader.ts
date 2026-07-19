import Database from 'better-sqlite3';
import type {FeedEvent} from '../../core/feed/types';
import type {SessionRow} from './types';

/**
 * The single read-only SQL surface over a `session.db` file.
 *
 * `SessionStore` (store.ts) is the writer and holds an exclusive lock on a live
 * session; consumers that only need to read a persisted or closed database
 * (the registry, the hook-pipeline audit) open their own read-only connection
 * through this reader instead of hand-rolling their own SELECTs. Keeping every
 * read query, table/column name, and payload JSON path in one place means
 * `session.db` has one private SQL surface, not one per consumer.
 */
export type SessionDbReader = {
	/** The on-disk schema version, or undefined if the table/row is absent. */
	schemaVersion(): number | undefined;
	/** The single `session` row, or undefined for an empty database. */
	sessionRow(): SessionRow | undefined;
	/** Adapter session ids in insertion order. */
	adapterSessionIds(): string[];
	/**
	 * The first `UserPromptSubmit` prompt text (used to label unlabeled
	 * sessions), or undefined when none is recorded.
	 */
	firstUserPrompt(): string | undefined;
	/** Count of runtime events grouped by hook name. */
	runtimeHookCounts(): Record<string, number>;
	/** All persisted feed events in seq order. */
	feedEvents(): FeedEvent[];
	close(): void;
};

export type OpenSessionDbReadonlyOptions = {
	/** Throw if the database file does not exist (better-sqlite3 `fileMustExist`). */
	fileMustExist?: boolean;
};

/**
 * Opens a read-only connection to `session.db` and exposes the fixed set of
 * reads its consumers need. The caller owns the returned reader and must
 * `close()` it.
 */
export function openSessionDbReadonly(
	dbPath: string,
	options: OpenSessionDbReadonlyOptions = {},
): SessionDbReader {
	const db = new Database(dbPath, {
		readonly: true,
		...(options.fileMustExist ? {fileMustExist: true} : {}),
	});

	return {
		schemaVersion() {
			const row = db.prepare('SELECT version FROM schema_version').get() as
				| {version: number}
				| undefined;
			return row?.version;
		},
		sessionRow() {
			return db.prepare('SELECT * FROM session LIMIT 1').get() as
				| SessionRow
				| undefined;
		},
		adapterSessionIds() {
			const rows = db
				.prepare('SELECT session_id FROM adapter_sessions ORDER BY started_at')
				.all() as {session_id: string}[];
			return rows.map(r => r.session_id);
		},
		firstUserPrompt() {
			const row = db
				.prepare(
					`SELECT json_extract(payload, '$.data.prompt') as prompt FROM runtime_events WHERE hook_name = 'UserPromptSubmit' ORDER BY seq ASC LIMIT 1`,
				)
				.get() as {prompt: string | null} | undefined;
			return row?.prompt ?? undefined;
		},
		runtimeHookCounts() {
			const rows = db
				.prepare(
					'SELECT hook_name, COUNT(*) AS count FROM runtime_events GROUP BY hook_name',
				)
				.all() as Array<{hook_name: string; count: number}>;
			const counts: Record<string, number> = {};
			for (const row of rows) counts[row.hook_name] = row.count;
			return counts;
		},
		feedEvents() {
			const rows = db
				.prepare('SELECT data FROM feed_events ORDER BY seq')
				.all() as Array<{data: string}>;
			return rows.map(r => JSON.parse(r.data) as FeedEvent);
		},
		close() {
			db.close();
		},
	};
}
