import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {describe, expect, it} from 'vitest';
import {GATEWAY_STATE_VERSION, openGatewayState} from './db';

describe('gateway state schema', () => {
	it('migrates v1 inbound_queue tables with legacy parked entries', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-state-'));
		const dbPath = path.join(dir, 'state.db');
		const raw = new Database(dbPath);
		raw.exec(`
			CREATE TABLE schema_version (
				version INTEGER NOT NULL
			);
			INSERT INTO schema_version (version) VALUES (1);
			CREATE TABLE inbound_queue (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				channel_id TEXT NOT NULL,
				account_id TEXT NOT NULL,
				idempotency_key TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE UNIQUE INDEX ix_inbound_queue_idem
				ON inbound_queue(channel_id, account_id, idempotency_key);
			INSERT INTO inbound_queue
				(channel_id, account_id, idempotency_key, payload_json, created_at)
			VALUES
				('telegram', 'a', 'k1', '{}', 1);
			CREATE TABLE channel_outbox (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				channel_id TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				attempt INTEGER NOT NULL DEFAULT 0,
				next_attempt_at INTEGER NOT NULL,
				last_error TEXT,
				created_at INTEGER NOT NULL
			);
		`);
		raw.close();

		const db = openGatewayState(dbPath);
		const columns = db
			.prepare('PRAGMA table_info(inbound_queue)')
			.all() as Array<{name: string}>;
		const version = db.prepare('SELECT version FROM schema_version').get() as {
			version: number;
		};
		const row = db
			.prepare('SELECT attachment_id FROM inbound_queue WHERE id = 1')
			.get() as {attachment_id: string | null};

		expect(columns.some(column => column.name === 'attachment_id')).toBe(true);
		expect(version.version).toBe(GATEWAY_STATE_VERSION);
		expect(row.attachment_id).toBeNull();

		db.close();
		fs.rmSync(dir, {recursive: true, force: true});
	});
});
