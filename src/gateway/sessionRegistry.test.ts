import {describe, expect, it} from 'vitest';
import {SessionRegistry, UnknownDispatchError} from './sessionRegistry';

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
	it('parks and resolves dispatch entries', () => {
		const reg = makeRegistry();
		const e = reg.beginDispatch({
			sessionKey: 'peer:telegram:a:1',
			agentId: 'main',
			location: dmLocation,
		});
		expect(e.dispatchId).toBe('disp-1');
		expect(reg.pendingDispatchCount()).toBe(1);
		const completed = reg.completeDispatch('disp-1');
		expect(completed.location.peer?.id).toBe('1');
		expect(reg.pendingDispatchCount()).toBe(0);
	});

	it('throws UnknownDispatchError for an unknown id', () => {
		const reg = makeRegistry();
		expect(() => reg.completeDispatch('missing')).toThrow(UnknownDispatchError);
	});

	it('parks multiple dispatches and resolves them independently', () => {
		const reg = makeRegistry();
		const e1 = reg.beginDispatch({
			sessionKey: 'k1',
			agentId: 'main',
			location: dmLocation,
		});
		const e2 = reg.beginDispatch({
			sessionKey: 'k2',
			agentId: 'main',
			location: {...dmLocation, accountId: 'b'},
		});
		expect(reg.pendingDispatchCount()).toBe(2);
		reg.completeDispatch(e1.dispatchId);
		expect(reg.pendingDispatchCount()).toBe(1);
		reg.completeDispatch(e2.dispatchId);
		expect(reg.pendingDispatchCount()).toBe(0);
	});

	it('clearDispatches empties all parked entries', () => {
		const reg = makeRegistry();
		reg.beginDispatch({sessionKey: 'k', agentId: 'main', location: dmLocation});
		reg.beginDispatch({sessionKey: 'k', agentId: 'main', location: dmLocation});
		expect(reg.pendingDispatchCount()).toBe(2);
		reg.clearDispatches();
		expect(reg.pendingDispatchCount()).toBe(0);
	});
});
