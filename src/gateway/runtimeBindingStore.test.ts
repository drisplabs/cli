import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
	AlreadyRegisteredError,
	NotRegisteredError,
	RuntimeBindingStore,
} from './runtimeBindingStore';

function makeStore(opts: {gracePeriodMs?: number; now?: () => number} = {}) {
	const observers = {
		onRuntimeRebind: vi.fn(),
		onRuntimeExpired: vi.fn(),
		onRuntimeConnectionLost: vi.fn(),
	};
	const store = new RuntimeBindingStore({
		gracePeriodMs: opts.gracePeriodMs ?? 0,
		now: opts.now ?? (() => 1000),
		observers,
	});
	return {store, observers};
}

const R1 = {
	runtimeId: 'r1',
	defaultAgentId: 'main',
	pid: 99,
	connectionId: 'c1',
};

describe('RuntimeBindingStore — registration', () => {
	it('registers a runtime and returns registeredAt', () => {
		const {store} = makeStore();
		const result = store.bind(R1);
		expect(result.registeredAt).toBe(1000);
		expect(store.getCurrent()?.runtimeId).toBe('r1');
	});

	it('rejects a second runtime with AlreadyRegisteredError', () => {
		const {store} = makeStore();
		store.bind(R1);
		expect(() =>
			store.bind({
				runtimeId: 'r2',
				defaultAgentId: 'main',
				pid: 100,
				connectionId: 'c2',
			}),
		).toThrow(AlreadyRegisteredError);
	});

	it('allows the same runtime to re-bind on reconnect', () => {
		const {store} = makeStore();
		store.bind(R1);
		store.bind({...R1, pid: 200, connectionId: 'c2'});
		expect(store.getCurrent()?.pid).toBe(200);
	});

	it('unbind throws NotRegisteredError for the wrong runtimeId', () => {
		const {store} = makeStore();
		store.bind(R1);
		expect(() => store.unbind('rZ')).toThrow(NotRegisteredError);
	});

	it('unbind clears current and binding', () => {
		const {store} = makeStore();
		store.bind(R1);
		store.unbind('r1');
		expect(store.getCurrent()).toBeNull();
		expect(store.getBinding()).toBeNull();
	});

	it('allows a new runtime after unbind', () => {
		const {store} = makeStore();
		store.bind(R1);
		store.unbind('r1');
		store.bind({
			runtimeId: 'r2',
			defaultAgentId: 'main',
			pid: 10,
			connectionId: 'c3',
		});
		expect(store.getCurrent()?.runtimeId).toBe('r2');
	});
});

describe('RuntimeBindingStore — connection binding state', () => {
	it('starts with no binding and no active binding', () => {
		const {store} = makeStore();
		expect(store.getBinding()).toBeNull();
		expect(store.hasActiveBinding()).toBe(false);
	});

	it('becomes active after bind', () => {
		const {store} = makeStore();
		store.bind(R1);
		expect(store.getBinding()?.state).toBe('active');
		expect(store.hasActiveBinding('r1')).toBe(true);
	});

	it('tracks epoch: starts at 1, increments on active connection replacement', () => {
		const {store} = makeStore();

		store.bind(R1);
		expect(store.getBinding()?.epoch).toBe(1);

		// replacing an active connection with a new connectionId increments epoch
		store.bind({...R1, connectionId: 'c2'});
		expect(store.getBinding()?.epoch).toBe(2);

		// same connectionId again → no increment
		store.bind({...R1, connectionId: 'c2'});
		expect(store.getBinding()?.epoch).toBe(2);
	});

	it('increments epoch on stale→active rebind during grace period', () => {
		vi.useFakeTimers();
		try {
			const {store} = makeStore({gracePeriodMs: 30_000});
			store.bind(R1); // epoch 1
			store.notifyConnectionClosed('c1'); // stale (preserved)
			store.bind({...R1, connectionId: 'c2'}); // epoch 2
			expect(store.getBinding()?.epoch).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('records lastRebindAt when a stale binding is reactivated during grace', () => {
		vi.useFakeTimers();
		try {
			const {store} = makeStore({gracePeriodMs: 30_000});
			store.bind(R1);
			expect(store.getBinding()?.lastRebindAt).toBeUndefined();
			store.notifyConnectionClosed('c1');
			store.bind({...R1, connectionId: 'c2'});
			expect(store.getBinding()?.lastRebindAt).toBeDefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('records lastRebindAt when an active binding is replaced by a new connection', () => {
		const {store} = makeStore();
		store.bind(R1);
		store.bind({...R1, connectionId: 'c2'});
		expect(store.getBinding()?.lastRebindAt).toBeDefined();
	});

	it('getRuntimeIdByConnection returns id for current connection, null otherwise', () => {
		const {store} = makeStore();
		store.bind(R1);
		expect(store.getRuntimeIdByConnection('c1')).toBe('r1');
		expect(store.getRuntimeIdByConnection('c-other')).toBeNull();
	});
});

describe('RuntimeBindingStore — connection lifecycle (grace=0)', () => {
	it('notifyConnectionClosed immediately unregisters and fires onRuntimeConnectionLost', () => {
		const {store, observers} = makeStore();
		store.bind(R1);
		const returned = store.notifyConnectionClosed('c1');
		expect(returned).toBe('r1');
		expect(store.getCurrent()).toBeNull();
		expect(observers.onRuntimeConnectionLost).toHaveBeenCalledWith({
			runtimeId: 'r1',
			graceful: false,
		});
	});

	it('returns null for an unrelated connectionId', () => {
		const {store, observers} = makeStore();
		store.bind(R1);
		const returned = store.notifyConnectionClosed('c-other');
		expect(returned).toBeNull();
		expect(store.getCurrent()?.runtimeId).toBe('r1');
		expect(observers.onRuntimeConnectionLost).not.toHaveBeenCalled();
	});

	it('returns null when no runtime is registered', () => {
		const {store} = makeStore();
		expect(store.notifyConnectionClosed('c1')).toBeNull();
	});
});

describe('RuntimeBindingStore — connection lifecycle (grace>0)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('marks binding stale on close, expires after grace period', () => {
		let t = 1000;
		const {store, observers} = makeStore({gracePeriodMs: 30_000, now: () => t});

		store.bind(R1);
		t = 2_000;
		store.notifyConnectionClosed('c1');
		expect(store.getCurrent()?.runtimeId).toBe('r1');
		expect(store.getBinding()?.state).toBe('stale');
		expect(store.hasActiveBinding()).toBe(false);

		t = 32_001;
		vi.advanceTimersByTime(30_001);
		expect(store.getCurrent()).toBeNull();
		expect(observers.onRuntimeExpired).toHaveBeenCalledWith({
			runtimeId: 'r1',
			gapMs: 30_001,
		});
		expect(observers.onRuntimeConnectionLost).toHaveBeenCalledWith({
			runtimeId: 'r1',
			graceful: false,
		});
	});

	it('cancels expiry and emits onRuntimeRebind on reconnect during grace', () => {
		let t = 1000;
		const {store, observers} = makeStore({gracePeriodMs: 30_000, now: () => t});

		store.bind(R1);
		t = 2_000;
		store.notifyConnectionClosed('c1');
		t = 5_000;
		store.bind({...R1, connectionId: 'c2'});
		expect(store.hasActiveBinding('r1')).toBe(true);
		expect(observers.onRuntimeRebind).toHaveBeenCalledWith({
			runtimeId: 'r1',
			gapMs: 3_000,
			epoch: 2,
		});

		vi.advanceTimersByTime(60_000);
		expect(observers.onRuntimeExpired).not.toHaveBeenCalled();
	});

	it('stop() cancels the pending expiry timer', () => {
		const {store, observers} = makeStore({gracePeriodMs: 30_000});
		store.bind(R1);
		store.notifyConnectionClosed('c1');
		store.stop();
		vi.advanceTimersByTime(60_000);
		expect(observers.onRuntimeExpired).not.toHaveBeenCalled();
		expect(store.getCurrent()?.runtimeId).toBe('r1'); // not yet expired
	});
});
