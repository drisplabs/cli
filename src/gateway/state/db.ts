/**
 * Gateway-owned SQLite state.
 *
 * Lives at `~/.config/athena/gateway/state.db` and is independent of per-
 * Athena-runtime session DBs. Holds queues that must survive across runtime
 * registrations (inbound parking) and across daemon restarts (outbox, M8).
 *
 * Schema is intentionally narrow — the per-session DB still owns the
 * `channel_messages` audit ledger. This file only stores transient state
 * the gateway needs to do its job when no runtime is attached.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const GATEWAY_STATE_VERSION = 1;

export type GatewayStateDb = Database.Database;

export function openGatewayState(dbPath: string): GatewayStateDb {
	if (dbPath !== ':memory:') {
		fs.mkdirSync(path.dirname(dbPath), {recursive: true, mode: 0o700});
	}
	const db = new Database(dbPath);
	db.exec('PRAGMA journal_mode = WAL');
	db.exec('PRAGMA foreign_keys = ON');
	initGatewayStateSchema(db);
	if (dbPath !== ':memory:' && process.platform !== 'win32') {
		try {
			fs.chmodSync(dbPath, 0o600);
		} catch {
			// best-effort
		}
	}
	return db;
}

export function initGatewayStateSchema(db: GatewayStateDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_version (
			version INTEGER NOT NULL
		);

		-- Inbound chat messages parked while no runtime is registered. Drained
		-- in FIFO id order on session.register. Idempotency key prevents the
		-- same provider message from being parked twice if an adapter retries.
		CREATE TABLE IF NOT EXISTS inbound_queue (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
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

	const existing = db.prepare('SELECT version FROM schema_version').get() as
		| {version: number}
		| undefined;
	if (existing && existing.version > GATEWAY_STATE_VERSION) {
		throw new Error(
			`Gateway state DB has newer schema version ${existing.version} (expected <= ${GATEWAY_STATE_VERSION}). Update athena-cli.`,
		);
	}
	if (!existing) {
		db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(
			GATEWAY_STATE_VERSION,
		);
	}
}
