/**
 * Gateway-owned SQLite state.
 *
 * Lives at `~/.config/athena/gateway/state.db` and is independent of per-
 * Athena-runtime session DBs. Holds queues that must survive across runtime
 * registrations (inbound parking) and across daemon restarts (outbox, M8).
 *
 * Schema is intentionally narrow: it only stores transient state the gateway
 * needs to do its job when no runtime is attached. There is no persisted
 * channel-message audit ledger (a planned `channel_messages` table was never
 * written and has been dropped — see ADR 0006).
 */

import fs from 'node:fs';
import type Database from 'better-sqlite3';
import {
	openVersionedDb,
	type SchemaMigrator,
} from '../../infra/db/openVersionedDb';

export const GATEWAY_STATE_VERSION = 2;

export type GatewayStateDb = Database.Database;

const migrateGatewayState: SchemaMigrator = (db, fromVersion) => {
	db.exec(`
		-- Inbound chat messages parked while no runtime is registered. Drained
		-- in FIFO id order on session.register. Idempotency key prevents the
		-- same provider message from being parked twice if an adapter retries.
		CREATE TABLE IF NOT EXISTS inbound_queue (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			attachment_id TEXT,
			channel_id TEXT NOT NULL,
			account_id TEXT NOT NULL,
			idempotency_key TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE UNIQUE INDEX IF NOT EXISTS ix_inbound_queue_idem
			ON inbound_queue(channel_id, account_id, idempotency_key);

		-- Outbound messages whose adapter send() failed transiently. Drained
		-- by a periodic retry loop with exponential backoff. Idempotency key
		-- on the OutboundMessage prevents double-delivery if the adapter
		-- partially succeeded before throwing.
		CREATE TABLE IF NOT EXISTS channel_outbox (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			channel_id TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			attempt INTEGER NOT NULL DEFAULT 0,
			next_attempt_at INTEGER NOT NULL,
			last_error TEXT,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS ix_channel_outbox_due
			ON channel_outbox(next_attempt_at);
	`);

	// Fresh database: base DDL above is the whole schema; the primitive stamps
	// the target version.
	if (fromVersion === undefined) return;

	// v1 shipped inbound_queue without attachment_id; add it in place.
	const inboundColumns = db
		.prepare('PRAGMA table_info(inbound_queue)')
		.all() as Array<{name: string}>;
	if (!inboundColumns.some(column => column.name === 'attachment_id')) {
		db.prepare('ALTER TABLE inbound_queue ADD COLUMN attachment_id TEXT').run();
	}
	if (fromVersion < GATEWAY_STATE_VERSION) {
		db.prepare('UPDATE schema_version SET version = ?').run(
			GATEWAY_STATE_VERSION,
		);
	}
};

export function openGatewayState(dbPath: string): GatewayStateDb {
	const db = openVersionedDb(dbPath, {
		version: GATEWAY_STATE_VERSION,
		migrate: migrateGatewayState,
		foreignKeys: true,
		ensureDir: true,
		dirMode: 0o700,
		onNewerVersion: (found, expected) =>
			new Error(
				`Gateway state DB has newer schema version ${found} (expected <= ${expected}). Update athena-cli.`,
			),
	});
	if (dbPath !== ':memory:' && process.platform !== 'win32') {
		try {
			fs.chmodSync(dbPath, 0o600);
		} catch {
			// best-effort
		}
	}
	return db;
}
