import {describe, expect, it} from 'vitest';
import type {OutboundMessage} from '../../shared/gateway-protocol';
import {openGatewayState} from './db';
import {Outbox} from './outbox';

const msg: OutboundMessage = {
	location: {
		channelId: 'telegram',
		accountId: 'a',
		peer: {id: '12345', kind: 'user'},
	},
	text: 'hi',
	idempotencyKey: 'reply:1',
};

describe('Outbox', () => {
	it('enqueues and reads back due rows in order', () => {
		const db = openGatewayState(':memory:');
		const o = new Outbox(db);
		o.enqueue({channelId: 'telegram', message: msg, nextAttemptAt: 100});
		o.enqueue({channelId: 'telegram', message: msg, nextAttemptAt: 50});
		o.enqueue({channelId: 'telegram', message: msg, nextAttemptAt: 200});
		const due = o.peekDue(150, 10);
		expect(due.map(r => r.nextAttemptAt)).toEqual([50, 100]);
		db.close();
	});

	it('respects the limit parameter', () => {
		const db = openGatewayState(':memory:');
		const o = new Outbox(db);
		for (let i = 0; i < 5; i++) {
			o.enqueue({channelId: 'telegram', message: msg, nextAttemptAt: i * 10});
		}
		expect(o.peekDue(1000, 2)).toHaveLength(2);
		db.close();
	});

	it('delete removes a row', () => {
		const db = openGatewayState(':memory:');
		const o = new Outbox(db);
		const id = o.enqueue({
			channelId: 'telegram',
			message: msg,
			nextAttemptAt: 100,
		});
		expect(o.size()).toBe(1);
		o.delete(id);
		expect(o.size()).toBe(0);
		db.close();
	});

	it('recordFailure bumps attempt and updates next_attempt_at + last_error', () => {
		const db = openGatewayState(':memory:');
		const o = new Outbox(db);
		const id = o.enqueue({
			channelId: 'telegram',
			message: msg,
			nextAttemptAt: 100,
			lastError: 'first failure',
		});
		o.recordFailure({
			id,
			nextAttemptAt: 500,
			lastError: 'second failure',
		});
		const [row] = o.peekDue(1_000, 10);
		expect(row?.attempt).toBe(1);
		expect(row?.nextAttemptAt).toBe(500);
		expect(row?.lastError).toBe('second failure');
		db.close();
	});

	it('roundtrips OutboundMessage payload faithfully', () => {
		const db = openGatewayState(':memory:');
		const o = new Outbox(db);
		o.enqueue({channelId: 'telegram', message: msg, nextAttemptAt: 0});
		const [row] = o.peekDue(100, 10);
		expect(row?.message).toEqual(msg);
		db.close();
	});
});
