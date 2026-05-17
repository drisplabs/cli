import {describe, expect, it} from 'vitest';
import type {NormalizedInbound} from '../../shared/gateway-protocol';
import {openGatewayState} from './db';
import {InboundQueue} from './inboundQueue';

function mkInbound(
	idempotencyKey: string,
	overrides: Partial<NormalizedInbound> = {},
): NormalizedInbound {
	return {
		location: {
			channelId: 'telegram',
			accountId: 'a',
			peer: {id: '12345', kind: 'user'},
		},
		sender: {id: '99', displayName: 'alice'},
		text: `msg-${idempotencyKey}`,
		receivedAt: 100,
		idempotencyKey,
		providerMessageId: idempotencyKey,
		...overrides,
	};
}

describe('InboundQueue', () => {
	it('enqueues and drains in FIFO order', () => {
		const db = openGatewayState(':memory:');
		const q = new InboundQueue(db);
		expect(q.enqueue(mkInbound('k1'), undefined).kind).toBe('queued');
		expect(q.enqueue(mkInbound('k2'), undefined).kind).toBe('queued');
		expect(q.enqueue(mkInbound('k3'), undefined).kind).toBe('queued');
		expect(q.size()).toBe(3);
		const drained = q.drain(undefined);
		expect(drained.map(d => d.inbound.idempotencyKey)).toEqual([
			'k1',
			'k2',
			'k3',
		]);
		expect(q.size()).toBe(0);
		db.close();
	});

	it('treats duplicate idempotency keys as no-ops', () => {
		const db = openGatewayState(':memory:');
		const q = new InboundQueue(db);
		expect(q.enqueue(mkInbound('k1'), undefined).kind).toBe('queued');
		expect(q.enqueue(mkInbound('k1'), undefined).kind).toBe('duplicate');
		expect(q.size()).toBe(1);
		db.close();
	});

	it('rejects when queue is full', () => {
		const db = openGatewayState(':memory:');
		const q = new InboundQueue(db, {maxEntries: 2});
		expect(q.enqueue(mkInbound('k1'), undefined).kind).toBe('queued');
		expect(q.enqueue(mkInbound('k2'), undefined).kind).toBe('queued');
		const result = q.enqueue(mkInbound('k3'), undefined);
		expect(result).toEqual({kind: 'rejected', reason: 'queue_full'});
		expect(q.size()).toBe(2);
		db.close();
	});

	it('drains only entries for the requested attachment slot', () => {
		const db = openGatewayState(':memory:');
		const q = new InboundQueue(db);
		expect(q.enqueue(mkInbound('legacy'), undefined).kind).toBe('queued');
		expect(q.enqueue(mkInbound('a1-1'), 'a1').kind).toBe('queued');
		expect(q.enqueue(mkInbound('a2'), 'a2').kind).toBe('queued');
		expect(q.enqueue(mkInbound('a1-2'), 'a1').kind).toBe('queued');

		expect(q.drain('a1').map(d => d.inbound.idempotencyKey)).toEqual([
			'a1-1',
			'a1-2',
		]);
		expect(q.size()).toBe(2);
		expect(q.drain(undefined).map(d => d.inbound.idempotencyKey)).toEqual([
			'legacy',
		]);
		expect(q.drain('a2').map(d => d.inbound.idempotencyKey)).toEqual(['a2']);
		expect(q.size()).toBe(0);
		db.close();
	});

	it('preserves payload roundtrip including peer kind and sender', () => {
		const db = openGatewayState(':memory:');
		const q = new InboundQueue(db);
		const inbound = mkInbound('k1', {
			location: {
				channelId: 'slack',
				accountId: 'team1',
				peer: {id: 'C123', kind: 'room'},
				thread: {id: 'T1'},
			},
		});
		q.enqueue(inbound, 'a1');
		const [parked] = q.drain('a1');
		expect(parked?.inbound).toEqual(inbound);
		db.close();
	});

	it('drain is empty when no entries are parked', () => {
		const db = openGatewayState(':memory:');
		const q = new InboundQueue(db);
		expect(q.drain(undefined)).toEqual([]);
		expect(q.drain('a1')).toEqual([]);
		db.close();
	});
});
