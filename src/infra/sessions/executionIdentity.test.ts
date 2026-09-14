import Database from 'better-sqlite3';
import {describe, expect, it} from 'vitest';
import {initSchema, SCHEMA_VERSION} from './schema';
import {createSessionStore} from './store';

describe('execution identity persistence', () => {
	it('migrates v10 and does not replay the migration on repeated initialization', () => {
		const db = new Database(':memory:');
		try {
			initSchema(db);
			db.exec(
				'ALTER TABLE workflow_runs DROP COLUMN execution_identity_json; UPDATE schema_version SET version = 10',
			);
			initSchema(db);
			initSchema(db);
			expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({
				version: SCHEMA_VERSION,
			});
			expect(
				db
					.prepare(
						"SELECT name FROM pragma_table_info('workflow_runs') WHERE name = 'execution_identity_json'",
					)
					.get(),
			).toBeDefined();
		} finally {
			db.close();
		}
	});
	it('retains the initial identity across subsequent snapshots', () => {
		const store = createSessionStore({
			sessionId: 'session',
			projectDir: '.',
			dbPath: ':memory:',
		});
		try {
			const snapshot = {
				runId: 'run',
				sessionId: 'session',
				iteration: 1,
				status: 'running' as const,
			};
			store.persistRun({...snapshot, executionIdentityJson: 'original'});
			store.persistRun({
				...snapshot,
				iteration: 2,
				executionIdentityJson: 'replacement',
			});
			expect(store.getLatestRun()?.executionIdentityJson).toBe('original');
		} finally {
			store.close();
		}
	});
});
