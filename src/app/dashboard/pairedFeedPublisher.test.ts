import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {FeedEvent} from '../../core/feed/types';
import {createDashboardFeedOutbox} from './dashboardFeedPublisher';
import {createPairedFeedPublisher} from './pairedFeedPublisher';

const tmpDirs: string[] = [];

function tempDbPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-paired-feed-'));
	tmpDirs.push(dir);
	return path.join(dir, 'outbox.db');
}

function notificationEvent(overrides: Partial<FeedEvent> = {}): FeedEvent {
	return {
		event_id: 'feed-1',
		seq: 7,
		ts: 1234,
		session_id: 'adapter-1',
		run_id: 'run-1',
		kind: 'notification',
		level: 'info',
		actor_id: 'agent:root',
		title: 'Notice',
		data: {message: 'hello'},
		...overrides,
	} as FeedEvent;
}

afterEach(() => {
	vi.useRealTimers();
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

describe('PairedFeedPublisher', () => {
	it('publishes canonical feed events durably and retries them until ACKed', async () => {
		vi.useFakeTimers();
		const outbox = createDashboardFeedOutbox({dbPath: tempDbPath()});
		const sent: unknown[] = [];
		const publisher = createPairedFeedPublisher({
			readConfig: () => ({
				dashboardUrl: 'https://dashboard.test',
				instanceId: 'inst-1',
				refreshToken: 'refresh',
				fingerprint: 'fp',
				pairedAt: 1,
			}),
			outbox,
			now: () => Date.now(),
			drainIntervalMs: 100,
		});

		publisher.publish({
			origin: 'local',
			athenaSessionId: 'athena-1',
			feedEvents: [notificationEvent()],
		});
		publisher.attachTransport({
			sendFeedEvent: frame => sent.push(frame),
		});

		expect(sent).toEqual([
			expect.objectContaining({
				deliverySeq: 1,
				envelope: expect.objectContaining({
					eventId: 'athena-1:feed-1',
					feedSeq: 1,
				}),
			}),
		]);

		await vi.advanceTimersByTimeAsync(999);
		expect(sent).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(sent).toHaveLength(2);

		publisher.handleAck({type: 'feed_ack', deliverySeq: 1});
		await vi.advanceTimersByTimeAsync(1_000);
		expect(sent).toHaveLength(2);
		expect(outbox.pendingBatch({limit: 10, now: Date.now()})).toEqual([]);

		publisher.close();
		outbox.close();
	});

	it('deduplicates repeated canonical feed events and drains them after reconnect', () => {
		const outbox = createDashboardFeedOutbox({dbPath: tempDbPath()});
		const sent: unknown[] = [];
		const publisher = createPairedFeedPublisher({
			readConfig: () => ({
				dashboardUrl: 'https://dashboard.test',
				instanceId: 'inst-1',
				refreshToken: 'refresh',
				fingerprint: 'fp',
				pairedAt: 1,
			}),
			outbox,
			now: () => 1234,
		});

		publisher.publish({
			origin: 'dashboard',
			athenaSessionId: 'athena-1',
			feedEvents: [notificationEvent(), notificationEvent()],
		});

		publisher.attachTransport({
			sendFeedEvent: frame => sent.push(frame),
		});
		expect(sent).toHaveLength(1);

		publisher.detachTransport();
		publisher.attachTransport({
			sendFeedEvent: frame => sent.push(frame),
		});
		expect(sent).toHaveLength(2);

		publisher.handleAck({type: 'feed_ack', deliverySeq: 1});
		expect(outbox.pendingBatch({limit: 10, now: 1234})).toEqual([]);

		publisher.close();
		outbox.close();
	});

	it('sends only rows stamped for the current pairing, never a previous instance', () => {
		const outbox = createDashboardFeedOutbox({dbPath: tempDbPath()});
		outbox.enqueue({
			instanceId: 'inst-old',
			athenaSessionId: 'athena-old',
			origin: 'local',
			feedEvents: [notificationEvent({event_id: 'old-1'})],
			emittedAt: 1,
		});
		const sent: Array<{envelope: {instanceId: string}}> = [];
		const publisher = createPairedFeedPublisher({
			readConfig: () => ({
				dashboardUrl: 'https://dashboard.test',
				instanceId: 'inst-new',
				refreshToken: 'refresh',
				fingerprint: 'fp',
				pairedAt: 1,
			}),
			outbox,
			now: () => 1234,
		});

		publisher.publish({
			origin: 'local',
			athenaSessionId: 'athena-new',
			feedEvents: [notificationEvent({event_id: 'new-1'})],
		});
		publisher.attachTransport({sendFeedEvent: frame => sent.push(frame)});

		expect(sent.map(f => f.envelope.instanceId)).toEqual(['inst-new']);

		publisher.close();
		outbox.close();
	});

	it('prunes rows left by previous pairings when a transport attaches, and logs the count', () => {
		const outbox = createDashboardFeedOutbox({dbPath: tempDbPath()});
		outbox.enqueue({
			instanceId: 'inst-old',
			athenaSessionId: 'athena-old',
			origin: 'local',
			feedEvents: [
				notificationEvent({event_id: 'old-1'}),
				notificationEvent({event_id: 'old-2'}),
			],
			emittedAt: 1,
		});
		const info: string[] = [];
		const publisher = createPairedFeedPublisher({
			readConfig: () => ({
				dashboardUrl: 'https://dashboard.test',
				instanceId: 'inst-new',
				refreshToken: 'refresh',
				fingerprint: 'fp',
				pairedAt: 1,
			}),
			outbox,
			now: () => 1234,
			onInfo: message => info.push(message),
		});

		publisher.attachTransport({sendFeedEvent: () => {}});

		expect(outbox.pendingBatch({limit: 100, now: Infinity})).toEqual([]);
		expect(info).toEqual([
			'paired feed: pruned 2 outbox row(s) left by previous pairings',
		]);

		// Nothing left to prune: a reconnect stays quiet.
		publisher.detachTransport();
		publisher.attachTransport({sendFeedEvent: () => {}});
		expect(info).toHaveLength(1);

		publisher.close();
		outbox.close();
	});

	it('spreads a large prune across drain ticks instead of blocking on one delete', async () => {
		vi.useFakeTimers();
		const outbox = createDashboardFeedOutbox({dbPath: tempDbPath()});
		outbox.enqueue({
			instanceId: 'inst-old',
			athenaSessionId: 'athena-old',
			origin: 'local',
			feedEvents: ['a', 'b', 'c', 'd', 'e'].map(id =>
				notificationEvent({event_id: id}),
			),
			emittedAt: 1,
		});
		const info: string[] = [];
		const publisher = createPairedFeedPublisher({
			readConfig: () => ({
				dashboardUrl: 'https://dashboard.test',
				instanceId: 'inst-new',
				refreshToken: 'refresh',
				fingerprint: 'fp',
				pairedAt: 1,
			}),
			outbox,
			now: () => Date.now(),
			drainIntervalMs: 100,
			pruneBatchSize: 2,
			onInfo: message => info.push(message),
		});
		const remaining = () =>
			outbox.pendingBatch({limit: 100, now: Infinity}).length;

		publisher.attachTransport({sendFeedEvent: () => {}});
		expect(remaining()).toBe(3);
		expect(info).toEqual([]);

		await vi.advanceTimersByTimeAsync(100);
		expect(remaining()).toBe(1);

		await vi.advanceTimersByTimeAsync(100);
		expect(remaining()).toBe(0);
		expect(info).toEqual([
			'paired feed: pruned 5 outbox row(s) left by previous pairings',
		]);

		publisher.close();
		outbox.close();
	});

	it('keeps prune deletes off the publish path and sends current rows before pruning', async () => {
		vi.useFakeTimers();
		const outbox = createDashboardFeedOutbox({dbPath: tempDbPath()});
		outbox.enqueue({
			instanceId: 'inst-old',
			athenaSessionId: 'athena-old',
			origin: 'local',
			feedEvents: ['a', 'b', 'c', 'd', 'e'].map(id =>
				notificationEvent({event_id: id}),
			),
			emittedAt: 1,
		});
		outbox.enqueue({
			instanceId: 'inst-new',
			athenaSessionId: 'athena-new',
			origin: 'local',
			feedEvents: [notificationEvent({event_id: 'current-1'})],
			emittedAt: 1,
		});
		const calls: string[] = [];
		const prune = outbox.pruneOtherInstances.bind(outbox);
		const publisher = createPairedFeedPublisher({
			readConfig: () => ({
				dashboardUrl: 'https://dashboard.test',
				instanceId: 'inst-new',
				refreshToken: 'refresh',
				fingerprint: 'fp',
				pairedAt: 1,
			}),
			outbox: {
				...outbox,
				pruneOtherInstances(input) {
					calls.push('prune');
					return prune(input);
				},
			},
			now: () => Date.now(),
			drainIntervalMs: 100,
			pruneBatchSize: 2,
		});

		publisher.attachTransport({sendFeedEvent: () => calls.push('send')});
		expect(calls).toEqual(['send', 'prune']);

		// A burst of publishes mid-prune sends each event but deletes nothing.
		calls.length = 0;
		for (const id of ['p1', 'p2', 'p3']) {
			publisher.publish({
				origin: 'local',
				athenaSessionId: 'athena-new',
				feedEvents: [notificationEvent({event_id: id})],
			});
		}
		expect(calls).toEqual(['send', 'send', 'send']);

		// The prune continues on the next drain tick.
		calls.length = 0;
		await vi.advanceTimersByTimeAsync(100);
		expect(calls).toEqual(['prune']);

		publisher.close();
		outbox.close();
	});

	it('resumes a prune interrupted by a disconnect and logs one total', async () => {
		vi.useFakeTimers();
		const outbox = createDashboardFeedOutbox({dbPath: tempDbPath()});
		outbox.enqueue({
			instanceId: 'inst-old',
			athenaSessionId: 'athena-old',
			origin: 'local',
			feedEvents: ['a', 'b', 'c', 'd', 'e'].map(id =>
				notificationEvent({event_id: id}),
			),
			emittedAt: 1,
		});
		const info: string[] = [];
		const publisher = createPairedFeedPublisher({
			readConfig: () => ({
				dashboardUrl: 'https://dashboard.test',
				instanceId: 'inst-new',
				refreshToken: 'refresh',
				fingerprint: 'fp',
				pairedAt: 1,
			}),
			outbox,
			now: () => Date.now(),
			drainIntervalMs: 100,
			pruneBatchSize: 2,
			onInfo: message => info.push(message),
		});
		const remaining = () =>
			outbox.pendingBatch({limit: 100, now: Infinity}).length;

		publisher.attachTransport({sendFeedEvent: () => {}});
		expect(remaining()).toBe(3);
		publisher.detachTransport();
		await vi.advanceTimersByTimeAsync(500);
		expect(remaining()).toBe(3);

		publisher.attachTransport({sendFeedEvent: () => {}});
		await vi.advanceTimersByTimeAsync(100);
		expect(remaining()).toBe(0);
		expect(info).toEqual([
			'paired feed: pruned 5 outbox row(s) left by previous pairings',
		]);

		publisher.close();
		outbox.close();
	});
});
