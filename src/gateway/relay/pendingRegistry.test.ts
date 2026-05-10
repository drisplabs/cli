import {describe, expect, it, vi} from 'vitest';
import {
	PendingRegistry,
	collisionMessage,
	type PendingEntry,
} from './pendingRegistry';

function buildEntry(overrides: Partial<PendingEntry> = {}): PendingEntry {
	const controllers = overrides.controllers ?? [
		new AbortController(),
		new AbortController(),
	];
	const timer = overrides.timer ?? setTimeout(() => {}, 60_000);
	if (typeof timer.unref === 'function') timer.unref();
	const resolve = overrides.resolve ?? vi.fn();
	const result =
		overrides.result ?? Promise.resolve({kind: 'no_relay' as const});
	return {
		kind: 'permission',
		channelRequestId: 'abcde',
		fingerprint: 'fp',
		runtimeId: undefined,
		controllers,
		timer,
		resolve,
		result,
		settled: false,
		...overrides,
	};
}

describe('PendingRegistry', () => {
	it('inspect() returns absent for an unknown id', () => {
		const reg = new PendingRegistry();
		expect(reg.inspect('zzz', 'permission', 'fp', undefined)).toEqual({
			kind: 'absent',
		});
	});

	it('inspect() returns attach when kind, fingerprint, and runtime match', () => {
		const reg = new PendingRegistry();
		const entry = buildEntry({runtimeId: 'r1'});
		reg.register(entry);
		expect(reg.inspect('abcde', 'permission', 'fp', 'r1')).toEqual({
			kind: 'attach',
			entry,
		});
	});

	it('inspect() reports kind collision when registered as a different relay kind', () => {
		const reg = new PendingRegistry();
		reg.register(buildEntry({kind: 'permission'}));
		expect(reg.inspect('abcde', 'question', 'fp', undefined)).toEqual({
			kind: 'collision',
			reason: 'kind',
		});
	});

	it('inspect() reports payload collision when fingerprint differs', () => {
		const reg = new PendingRegistry();
		reg.register(buildEntry({fingerprint: 'A'}));
		expect(reg.inspect('abcde', 'permission', 'B', undefined)).toEqual({
			kind: 'collision',
			reason: 'payload',
		});
	});

	it('inspect() reports owner collision when runtimeId differs (entry has owner)', () => {
		const reg = new PendingRegistry();
		reg.register(buildEntry({runtimeId: 'r1'}));
		expect(reg.inspect('abcde', 'permission', 'fp', 'r2')).toEqual({
			kind: 'collision',
			reason: 'owner',
		});
	});

	it('inspect() reports owner collision when entry is unowned but caller is owned', () => {
		const reg = new PendingRegistry();
		reg.register(buildEntry({runtimeId: undefined}));
		expect(reg.inspect('abcde', 'permission', 'fp', 'r1')).toEqual({
			kind: 'collision',
			reason: 'owner',
		});
	});

	it('settle() resolves the entry, clears the timer, aborts controllers, and removes the entry', () => {
		const reg = new PendingRegistry();
		const ctrl1 = new AbortController();
		const ctrl2 = new AbortController();
		const resolve = vi.fn();
		const cleared = vi.fn();
		const timer = setTimeout(cleared, 60_000);
		if (typeof timer.unref === 'function') timer.unref();
		reg.register(buildEntry({controllers: [ctrl1, ctrl2], resolve, timer}));

		expect(
			reg.settle('abcde', {kind: 'cancelled', reason: 'resolved_locally'}),
		).toBe(true);
		expect(resolve).toHaveBeenCalledWith({
			kind: 'cancelled',
			reason: 'resolved_locally',
		});
		expect(ctrl1.signal.aborted).toBe(true);
		expect(ctrl2.signal.aborted).toBe(true);
		expect(reg.count()).toBe(0);
	});

	it('settle() is idempotent — second settle is a no-op and returns false', () => {
		const reg = new PendingRegistry();
		const resolve = vi.fn();
		reg.register(buildEntry({resolve}));
		expect(
			reg.settle('abcde', {kind: 'cancelled', reason: 'resolved_locally'}),
		).toBe(true);
		expect(reg.settle('abcde', {kind: 'cancelled', reason: 'timeout'})).toBe(
			false,
		);
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it('cancel() honours runtimeId scoping when both sides are owned', () => {
		const reg = new PendingRegistry();
		reg.register(buildEntry({runtimeId: 'r1'}));
		expect(reg.cancel('abcde', 'resolved_locally', 'r2')).toBe(false);
		expect(reg.count()).toBe(1);
		expect(reg.cancel('abcde', 'resolved_locally', 'r1')).toBe(true);
		expect(reg.count()).toBe(0);
	});

	it('cancel() with no expected runtime succeeds regardless of entry ownership', () => {
		const reg = new PendingRegistry();
		reg.register(buildEntry({runtimeId: 'r1'}));
		expect(reg.cancel('abcde', 'resolved_locally', undefined)).toBe(true);
	});

	it('cancel() returns false for an unknown id', () => {
		const reg = new PendingRegistry();
		expect(reg.cancel('zzz', 'resolved_locally', undefined)).toBe(false);
		expect(reg.cancel('zzz', 'resolved_locally', 'r1')).toBe(false);
	});

	it('disposeAll() cancels every pending entry with the given reason', () => {
		const reg = new PendingRegistry();
		const r1 = vi.fn();
		const r2 = vi.fn();
		reg.register(buildEntry({channelRequestId: 'a', resolve: r1}));
		reg.register(
			buildEntry({channelRequestId: 'b', resolve: r2, runtimeId: 'r1'}),
		);
		reg.disposeAll('connection_lost');
		expect(r1).toHaveBeenCalledWith({
			kind: 'cancelled',
			reason: 'connection_lost',
		});
		expect(r2).toHaveBeenCalledWith({
			kind: 'cancelled',
			reason: 'connection_lost',
		});
		expect(reg.count()).toBe(0);
	});
});

describe('collisionMessage', () => {
	it('formats owner mismatch', () => {
		expect(collisionMessage('abc', 'owner', 'permission')).toBe(
			'channel_request_owner_mismatch: abc owned by a different runtime',
		);
	});

	it('formats kind collision pointing at the OTHER kind that holds the id', () => {
		expect(collisionMessage('abc', 'kind', 'question')).toBe(
			'channel_request_id_collision: abc is bound to a permission relay',
		);
		expect(collisionMessage('abc', 'kind', 'permission')).toBe(
			'channel_request_id_collision: abc is bound to a question relay',
		);
	});

	it('formats payload mismatch', () => {
		expect(collisionMessage('abc', 'payload', 'permission')).toBe(
			'channel_request_id_collision: abc payload mismatch',
		);
	});
});
