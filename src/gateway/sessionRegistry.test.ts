import {describe, expect, it} from 'vitest';
import {SessionRegistry} from './sessionRegistry';

function makeRegistry() {
	let counter = 0;
	return new SessionRegistry({
		idFactory: () => `disp-${++counter}`,
		now: () => 1000 + counter,
	});
}

const dmLocation = {
	channelId: 'telegram',
	accountId: 'a',
	peer: {id: '1', kind: 'user' as const},
};

describe('SessionRegistry (dispatch correlation)', () => {
	it('parks a turn for its runtime and resolves it for that runtime', () => {
		const reg = makeRegistry();
		const e = reg.beginDispatch({
			sessionKey: 'peer:telegram:a:1',
			agentId: 'main',
			runtimeId: 'r1',
			location: dmLocation,
		});
		expect(e.dispatchId).toBe('disp-1');
		expect(e.runtimeId).toBe('r1');
		expect(reg.pendingDispatchCount()).toBe(1);
		const result = reg.completeDispatch('disp-1', {runtimeId: 'r1'});
		expect(result.kind).toBe('completed');
		if (result.kind === 'completed') {
			expect(result.entry.location.peer?.id).toBe('1');
		}
		expect(reg.pendingDispatchCount()).toBe(0);
	});

	it('records the attachment slot the turn was dispatched to', () => {
		const reg = makeRegistry();
		const e = reg.beginDispatch({
			sessionKey: 'k',
			agentId: 'main',
			runtimeId: 'r1',
			attachmentKey: 'a1',
			location: dmLocation,
		});
		expect(e.attachmentKey).toBe('a1');
	});

	it('returns unknown for an unknown id', () => {
		const reg = makeRegistry();
		expect(reg.completeDispatch('missing', {runtimeId: 'r1'})).toEqual({
			kind: 'unknown',
		});
	});

	it('rejects completion from a different runtime without consuming the turn', () => {
		const reg = makeRegistry();
		reg.beginDispatch({
			sessionKey: 'k',
			agentId: 'main',
			runtimeId: 'r1',
			location: dmLocation,
		});
		const mismatch = reg.completeDispatch('disp-1', {runtimeId: 'rX'});
		expect(mismatch.kind).toBe('runtime_mismatch');
		if (mismatch.kind === 'runtime_mismatch') {
			expect(mismatch.entry.runtimeId).toBe('r1');
		}
		// The turn is still parked — the authorized runtime can still complete it.
		expect(reg.pendingDispatchCount()).toBe(1);
		expect(reg.completeDispatch('disp-1', {runtimeId: 'r1'}).kind).toBe(
			'completed',
		);
		expect(reg.pendingDispatchCount()).toBe(0);
	});

	it('parks multiple dispatches and resolves them independently', () => {
		const reg = makeRegistry();
		const e1 = reg.beginDispatch({
			sessionKey: 'k1',
			agentId: 'main',
			runtimeId: 'r1',
			location: dmLocation,
		});
		const e2 = reg.beginDispatch({
			sessionKey: 'k2',
			agentId: 'main',
			runtimeId: 'r1',
			location: {...dmLocation, accountId: 'b'},
		});
		expect(reg.pendingDispatchCount()).toBe(2);
		reg.completeDispatch(e1.dispatchId, {runtimeId: 'r1'});
		expect(reg.pendingDispatchCount()).toBe(1);
		reg.completeDispatch(e2.dispatchId, {runtimeId: 'r1'});
		expect(reg.pendingDispatchCount()).toBe(0);
	});

	it('clearDispatches empties all parked entries', () => {
		const reg = makeRegistry();
		reg.beginDispatch({
			sessionKey: 'k',
			agentId: 'main',
			runtimeId: 'r1',
			location: dmLocation,
		});
		reg.beginDispatch({
			sessionKey: 'k',
			agentId: 'main',
			runtimeId: 'r1',
			location: dmLocation,
		});
		expect(reg.pendingDispatchCount()).toBe(2);
		reg.clearDispatches();
		expect(reg.pendingDispatchCount()).toBe(0);
	});
});
