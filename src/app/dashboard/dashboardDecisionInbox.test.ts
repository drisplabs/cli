import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
});
