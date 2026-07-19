import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import Database from 'better-sqlite3';
import {migrateVersionedSchema} from './openVersionedDb.js';

/**
 * These tests exercise the durability guarantee callers depend on: an
 * interrupted migration must leave the database exactly as it was, because a
 * half-applied delta (DDL applied, `schema_version` not stamped) makes the file
 * permanently unopenable — the next open replays the same `ALTER` and dies with
 * `duplicate column name`.
 */
describe('migrateVersionedSchema', () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'versioned-db-'));
		dbPath = path.join(dir, 'test.db');
		// Seed a v1 database with one table.
		const seed = new Database(dbPath);
		seed.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
		migrateVersionedSchema(seed, {version: 1, migrate: () => {}});
		seed.close();
	});

	afterEach(() => {
		fs.rmSync(dir, {recursive: true, force: true});
	});

	it('rolls the whole delta back when a migration throws part-way', () => {
		const db = new Database(dbPath);
		expect(() =>
			migrateVersionedSchema(db, {
				version: 2,
				migrate: (target, fromVersion) => {
					if (fromVersion === undefined) return;
					target.exec('ALTER TABLE t ADD COLUMN added TEXT');
					throw new Error('interrupted before the version stamp');
				},
			}),
		).toThrow('interrupted before the version stamp');
		db.close();

		const after = new Database(dbPath);
		const columns = (
			after.prepare('PRAGMA table_info(t)').all() as Array<{name: string}>
		).map(column => column.name);
		const version = (
			after.prepare('SELECT version FROM schema_version').get() as {
				version: number;
			}
		).version;
		after.close();

		expect(columns).not.toContain('added');
		expect(version).toBe(1);
	});

	it('lets a retried migration succeed after an interrupted attempt', () => {
		const failing = new Database(dbPath);
		expect(() =>
			migrateVersionedSchema(failing, {
				version: 2,
				migrate: (target, fromVersion) => {
					if (fromVersion === undefined) return;
					target.exec('ALTER TABLE t ADD COLUMN added TEXT');
					throw new Error('interrupted before the version stamp');
				},
			}),
		).toThrow();
		failing.close();

		const retry = new Database(dbPath);
		migrateVersionedSchema(retry, {
			version: 2,
			migrate: (target, fromVersion) => {
				if (fromVersion === undefined) return;
				target.exec(
					'ALTER TABLE t ADD COLUMN added TEXT; UPDATE schema_version SET version = 2;',
				);
			},
		});
		const version = (
			retry.prepare('SELECT version FROM schema_version').get() as {
				version: number;
			}
		).version;
		retry.close();

		expect(version).toBe(2);
	});

	it('stamps the target version for a fresh database', () => {
		const fresh = new Database(path.join(dir, 'fresh.db'));
		fresh.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
		migrateVersionedSchema(fresh, {version: 3, migrate: () => {}});
		const version = (
			fresh.prepare('SELECT version FROM schema_version').get() as {
				version: number;
			}
		).version;
		fresh.close();

		expect(version).toBe(3);
	});
});
