import {describe, expect, it, vi} from 'vitest';
import type {OutboundMessage, SendResult} from '../shared/gateway-protocol';
import {OutboundDispatcher} from './outboundDispatcher';
import {openGatewayState} from './state/db';
import {Outbox} from './state/outbox';

const msg: OutboundMessage = {
	location: {
		channelId: 'telegram',
		accountId: 'a',
		peer: {id: '12345', kind: 'user'},
	},
	text: 'hi',
	idempotencyKey: 'reply:1',
};

function setup(now: () => number) {
	const db = openGatewayState(':memory:');
	const outbox = new Outbox(db);
	const send = vi.fn<(c: string, m: OutboundMessage) => Promise<SendResult>>();
	const dispatcher = new OutboundDispatcher({
		outbox,
		send,
		backoffSchedule: [10, 20, 40],
		maxAttempts: 3,
		tickIntervalMs: 60_000, // disable timer; tests call drain() directly
		now,
	});
	return {db, outbox, send, dispatcher};
}

describe('OutboundDispatcher', () => {
	it('returns sent on first-attempt success without parking', async () => {
		const now = 1_000;
		const {db, outbox, send, dispatcher} = setup(() => now);
		send.mockResolvedValue({providerMessageId: 'm1', deliveredAt: 1});

		const result = await dispatcher.dispatch('telegram', msg);
		expect(result).toEqual({
			kind: 'sent',
			result: {providerMessageId: 'm1', deliveredAt: 1},
		});
		expect(outbox.size()).toBe(0);
		db.close();
	});

	it('parks on failure with backoff[0] schedule', async () => {
		const now = 1_000;
		const {db, outbox, send, dispatcher} = setup(() => now);
		send.mockRejectedValue(new Error('network down'));

		const result = await dispatcher.dispatch('telegram', msg);
		expect(result.kind).toBe('queued');
		expect(outbox.size()).toBe(1);
		const [row] = outbox.peekDue(now + 10, 10);
		expect(row?.nextAttemptAt).toBe(1_010);
		expect(row?.lastError).toBe('network down');
		db.close();
	});

	it('drain retries and deletes on success', async () => {
		let now = 1_000;
		const {db, outbox, send, dispatcher} = setup(() => now);
		send.mockRejectedValueOnce(new Error('blip'));
		send.mockResolvedValueOnce({providerMessageId: 'm1', deliveredAt: 1});

		await dispatcher.dispatch('telegram', msg);
		expect(outbox.size()).toBe(1);

		now = 2_000; // advance past the backoff
		const summary = await dispatcher.drain();
		expect(summary).toEqual({retried: 1, succeeded: 1, dropped: 0});
		expect(outbox.size()).toBe(0);
		db.close();
	});

	it('drain skips rows whose next_attempt_at is in the future', async () => {
		let now = 1_000;
		const {db, outbox, send, dispatcher} = setup(() => now);
		send.mockRejectedValue(new Error('still down'));

		await dispatcher.dispatch('telegram', msg);
		// now is still 1_000; backoff schedules row at 1_010. Drain at 1_005.
		now = 1_005;
		const summary = await dispatcher.drain();
		expect(summary).toEqual({retried: 0, succeeded: 0, dropped: 0});
		expect(outbox.size()).toBe(1);
		db.close();
	});

	it('drops after maxAttempts', async () => {
		let now = 1_000;
		const {db, outbox, send, dispatcher} = setup(() => now);
		send.mockRejectedValue(new Error('persistent'));

		await dispatcher.dispatch('telegram', msg); // attempt 0 → parked
		now = 2_000;
		await dispatcher.drain(); // attempt 1
		now = 3_000;
		await dispatcher.drain(); // attempt 2
		now = 4_000;
		const summary = await dispatcher.drain(); // attempt 3 → dropped
		expect(summary.dropped).toBe(1);
		expect(outbox.size()).toBe(0);
		db.close();
	});

	it('uses the longest backoff entry for late attempts', async () => {
		let now = 1_000;
		const {db, outbox, send, dispatcher} = setup(() => now);
		send.mockRejectedValue(new Error('bad'));

		await dispatcher.dispatch('telegram', msg);
		now = 2_000;
		await dispatcher.drain(); // attempt 1 → backoff[1]=20
		const [row1] = outbox.peekDue(10_000, 10);
		expect(row1?.nextAttemptAt).toBe(2_020);

		now = 3_000;
		await dispatcher.drain(); // attempt 2 → backoff[2]=40
		const [row2] = outbox.peekDue(10_000, 10);
		expect(row2?.nextAttemptAt).toBe(3_040);

		db.close();
	});

	it('survives across restart by reading rows from disk', async () => {
		const now = 1_000;
		const {outbox, send, dispatcher} = setup(() => now);
		send.mockRejectedValue(new Error('blip'));
		await dispatcher.dispatch('telegram', msg);

		// Simulate restart: build a fresh dispatcher pointing at the same outbox.
		const send2 = vi
			.fn<(c: string, m: OutboundMessage) => Promise<SendResult>>()
			.mockResolvedValue({providerMessageId: 'm1', deliveredAt: 1});
		const dispatcher2 = new OutboundDispatcher({
			outbox,
			send: send2,
			backoffSchedule: [10],
			tickIntervalMs: 60_000,
			now: () => 9_999,
		});

		const summary = await dispatcher2.drain();
		expect(summary.succeeded).toBe(1);
		expect(send2).toHaveBeenCalledWith('telegram', msg);
	});
});
