import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {afterEach, describe, expect, it} from 'vitest';
import {createDashboardDecisionInbox} from './dashboardDecisionInbox';

const tmpDirs: string[] = [];

function tempDbPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-decision-inbox-'));
	tmpDirs.push(dir);
	return path.join(dir, 'inbox.db');
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

describe('DashboardDecisionInbox', () => {
	it('persists dashboard decisions until a local session consumes them', () => {
		const dbPath = tempDbPath();
		const inbox = createDashboardDecisionInbox({dbPath});

		inbox.enqueue({
			athenaSessionId: 'athena-1',
			requestId: 'req-1',
			decision: {
				type: 'json',
				source: 'user',
				intent: {kind: 'permission_allow'},
			},
			receivedAt: 123,
		});
		inbox.close();

		const reopened = createDashboardDecisionInbox({dbPath});
		const pending = reopened.pendingForSession({
			athenaSessionId: 'athena-1',
			limit: 10,
		});
		expect(pending).toEqual([
			expect.objectContaining({
				requestId: 'req-1',
				decision: expect.objectContaining({
					intent: {kind: 'permission_allow'},
				}),
			}),
		]);

		reopened.markConsumed({id: pending[0]!.id});
		expect(
			reopened.pendingForSession({athenaSessionId: 'athena-1', limit: 10}),
		).toEqual([]);
		reopened.close();
	});

	it('replaces an unconsumed decision for the same session request', () => {
		const inbox = createDashboardDecisionInbox({dbPath: tempDbPath()});

		inbox.enqueue({
			athenaSessionId: 'athena-1',
			requestId: 'req-1',
			decision: {
				type: 'json',
				source: 'user',
				intent: {kind: 'permission_deny', reason: 'old'},
			},
			receivedAt: 100,
		});
		inbox.enqueue({
			athenaSessionId: 'athena-1',
			requestId: 'req-1',
			decision: {
				type: 'json',
				source: 'user',
				intent: {kind: 'permission_allow'},
			},
			receivedAt: 200,
		});

		expect(
			inbox.pendingForSession({athenaSessionId: 'athena-1', limit: 10}),
		).toEqual([
			expect.objectContaining({
				requestId: 'req-1',
				decision: expect.objectContaining({
					intent: {kind: 'permission_allow'},
				}),
				receivedAt: 200,
			}),
		]);
		inbox.close();
	});

	it('does not resurrect a consumed decision when a replacement arrives later', () => {
		const inbox = createDashboardDecisionInbox({dbPath: tempDbPath()});

		inbox.enqueue({
			athenaSessionId: 'athena-1',
			requestId: 'req-1',
			decision: {
				type: 'json',
				source: 'user',
				intent: {kind: 'permission_deny', reason: 'old'},
			},
			receivedAt: 100,
		});
		const [first] = inbox.pendingForSession({
			athenaSessionId: 'athena-1',
			limit: 10,
		});
		inbox.markConsumed({id: first!.id});
		inbox.enqueue({
			athenaSessionId: 'athena-1',
			requestId: 'req-1',
			decision: {
				type: 'json',
				source: 'user',
				intent: {kind: 'permission_allow'},
			},
			receivedAt: 200,
		});

		const pending = inbox.pendingForSession({
			athenaSessionId: 'athena-1',
			limit: 10,
		});
		expect(pending).toEqual([
			expect.objectContaining({
				requestId: 'req-1',
				decision: expect.objectContaining({
					intent: {kind: 'permission_allow'},
				}),
				receivedAt: 200,
			}),
		]);
		expect(pending[0]!.id).not.toBe(first!.id);
		inbox.close();
	});

	it('migrates the legacy unique schema so consumed requests can receive later decisions', () => {
		const dbPath = tempDbPath();
		const legacy = new Database(dbPath);
		legacy.exec(`
			CREATE TABLE dashboard_decision_inbox (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				athena_session_id TEXT NOT NULL,
				request_id TEXT NOT NULL,
				decision_json TEXT NOT NULL,
				received_at INTEGER NOT NULL,
				consumed_at INTEGER,
				UNIQUE(athena_session_id, request_id)
			);
		`);
		legacy
			.prepare(
				`INSERT INTO dashboard_decision_inbox (
					athena_session_id,
					request_id,
					decision_json,
					received_at,
					consumed_at
				) VALUES (?, ?, ?, ?, ?)`,
			)
			.run(
				'athena-1',
				'req-1',
				JSON.stringify({
					type: 'json',
					source: 'user',
					intent: {kind: 'permission_deny', reason: 'old'},
				}),
				100,
				150,
			);
		legacy.close();

		const inbox = createDashboardDecisionInbox({dbPath});
		inbox.enqueue({
			athenaSessionId: 'athena-1',
			requestId: 'req-1',
			decision: {
				type: 'json',
				source: 'user',
				intent: {kind: 'permission_allow'},
			},
			receivedAt: 200,
		});

		expect(
			inbox.pendingForSession({athenaSessionId: 'athena-1', limit: 10}),
		).toEqual([
			expect.objectContaining({
				requestId: 'req-1',
				receivedAt: 200,
				decision: expect.objectContaining({
					intent: {kind: 'permission_allow'},
				}),
			}),
		]);
		inbox.close();
	});
});
