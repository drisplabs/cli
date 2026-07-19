import {describe, expect, it, vi} from 'vitest';
import {
	attachRuntimeEventLoop,
	startDashboardDecisionDrain,
	DASHBOARD_DECISION_POLL_LIMIT,
	type RuntimeEventLoopIngest,
} from './runtimeEventLoop';
import {createFeedMapper} from '../../core/feed/mapper';
import type {ControllerCallbacks} from '../../core/controller/runtimeController';
import type {
	Runtime,
	RuntimeDecision,
	RuntimeDecisionHandler,
	RuntimeEvent,
	RuntimeEventHandler,
} from '../../core/runtime/types';

class MockRuntime implements Runtime {
	private eventHandlers = new Set<RuntimeEventHandler>();
	private decisionHandlers = new Set<RuntimeDecisionHandler>();
	public decisions: Array<{eventId: string; decision: RuntimeDecision}> = [];

	start(): Promise<void> {
		return Promise.resolve();
	}
	stop(): void {}
	getStatus(): 'stopped' | 'running' {
		return 'running';
	}
	getLastError() {
		return null;
	}
	onEvent(handler: RuntimeEventHandler): () => void {
		this.eventHandlers.add(handler);
		return () => this.eventHandlers.delete(handler);
	}
	onDecision(handler: RuntimeDecisionHandler): () => void {
		this.decisionHandlers.add(handler);
		return () => this.decisionHandlers.delete(handler);
	}
	sendDecision(eventId: string, decision: RuntimeDecision): void {
		this.decisions.push({eventId, decision});
		for (const handler of this.decisionHandlers) handler(eventId, decision);
	}
	emit(event: RuntimeEvent): void {
		for (const handler of this.eventHandlers) handler(event);
	}
	emitDecision(eventId: string, decision: RuntimeDecision): void {
		for (const handler of this.decisionHandlers) handler(eventId, decision);
	}
}

function makeControllerCallbacks(): ControllerCallbacks {
	return {
		getRules: () => [],
		enqueuePermission: vi.fn(),
		enqueueQuestion: vi.fn(),
	};
}

function makeIngest(): RuntimeEventLoopIngest {
	return {
		mapper: createFeedMapper(),
		controllerCallbacks: makeControllerCallbacks(),
	};
}

function makeToolPreEvent(id: string): RuntimeEvent {
	return {
		id,
		timestamp: Date.now(),
		kind: 'tool.pre',
		data: {tool_name: 'Bash', tool_input: {command: 'echo hi'}},
		hookName: 'PreToolUse',
		sessionId: 'adapter-session',
		toolName: 'Bash',
		context: {cwd: '/tmp', transcriptPath: '/tmp/t.jsonl'},
		interaction: {expectsDecision: true},
		payload: {},
	};
}

function makeNotificationEvent(id: string): RuntimeEvent {
	return {
		id,
		timestamp: Date.now(),
		kind: 'notification',
		data: {message: 'hi'},
		hookName: 'Notification',
		sessionId: 'adapter-session',
		context: {cwd: '/tmp', transcriptPath: '/tmp/t.jsonl'},
		interaction: {expectsDecision: false},
		payload: {},
	};
}

describe('attachRuntimeEventLoop', () => {
	it('ingests, forwards the controller decision, then emits the feed events in order', () => {
		const runtime = new MockRuntime();
		const order: string[] = [];
		const originalSend = runtime.sendDecision.bind(runtime);
		vi.spyOn(runtime, 'sendDecision').mockImplementation((id, decision) => {
			order.push('sendDecision');
			originalSend(id, decision);
		});

		const emitEventFeed = vi.fn(() => order.push('emitEventFeed'));
		const loop = attachRuntimeEventLoop({
			runtime,
			ingest: makeIngest(),
			emitEventFeed,
			emitDecisionFeed: vi.fn(),
		});

		runtime.emit(makeToolPreEvent('evt-1'));

		// The controller auto-allows a non-denied PreToolUse tool.
		expect(runtime.decisions).toContainEqual(
			expect.objectContaining({
				eventId: 'evt-1',
				decision: expect.objectContaining({intent: {kind: 'pre_tool_allow'}}),
			}),
		);
		expect(emitEventFeed).toHaveBeenCalledTimes(1);
		// sendDecision must fire before the feed sink sees the events.
		expect(order).toEqual(['sendDecision', 'emitEventFeed']);

		loop.stop();
	});

	it('skips ingest, decision, and sink when skipEvent returns true', () => {
		const runtime = new MockRuntime();
		const emitEventFeed = vi.fn();
		const loop = attachRuntimeEventLoop({
			runtime,
			ingest: makeIngest(),
			skipEvent: () => true,
			onEventReceived: vi.fn(),
			emitEventFeed,
			emitDecisionFeed: vi.fn(),
		});

		runtime.emit(makeToolPreEvent('evt-skip'));

		expect(runtime.decisions).toHaveLength(0);
		expect(emitEventFeed).not.toHaveBeenCalled();
		loop.stop();
	});

	it('wraps the per-event handler and resolves the ingest source per event', () => {
		const runtime = new MockRuntime();
		const wrapOrder: string[] = [];
		let calls = 0;
		const loop = attachRuntimeEventLoop({
			runtime,
			// Function form: resolved fresh on each event.
			ingest: () => {
				calls += 1;
				return makeIngest();
			},
			wrapEvent: (_event, run) => {
				wrapOrder.push('before');
				run();
				wrapOrder.push('after');
			},
			emitEventFeed: () => wrapOrder.push('emit'),
			emitDecisionFeed: vi.fn(),
		});

		// Notification events produce no controller decision, so the ingest
		// source resolves exactly once per event (no decision echo).
		runtime.emit(makeNotificationEvent('evt-a'));
		runtime.emit(makeNotificationEvent('evt-b'));

		expect(wrapOrder).toEqual([
			'before',
			'emit',
			'after',
			'before',
			'emit',
			'after',
		]);
		expect(calls).toBe(2);
		loop.stop();
	});

	it('runs decision hooks in order and skips ingest when skipDecision is true', () => {
		const runtime = new MockRuntime();
		const seen: string[] = [];
		const loop = attachRuntimeEventLoop({
			runtime,
			ingest: makeIngest(),
			emitEventFeed: vi.fn(),
			onDecisionReceived: () => seen.push('received'),
			beforeDecisionIngest: () => seen.push('beforeIngest'),
			skipDecision: () => true,
			emitDecisionFeed: () => seen.push('emit'),
		});

		runtime.emitDecision('evt-1', {type: 'passthrough', source: 'timeout'});

		// onDecisionReceived always runs; the skip prevents ingest + sink.
		expect(seen).toEqual(['received']);
		loop.stop();
	});

	it('stop() unsubscribes both listeners', () => {
		const runtime = new MockRuntime();
		const emitEventFeed = vi.fn();
		const loop = attachRuntimeEventLoop({
			runtime,
			ingest: makeIngest(),
			emitEventFeed,
			emitDecisionFeed: vi.fn(),
		});

		loop.stop();
		runtime.emit(makeToolPreEvent('evt-after-stop'));
		expect(emitEventFeed).not.toHaveBeenCalled();
	});
});

describe('startDashboardDecisionDrain', () => {
	const decision: RuntimeDecision = {
		type: 'json',
		source: 'user',
		intent: {kind: 'permission_allow'},
	};

	it('drains pending decisions immediately with the shared limit and marks them consumed', () => {
		vi.useFakeTimers();
		try {
			const sendDecision = vi.fn();
			const markConsumed = vi.fn();
			const pendingForSession = vi
				.fn()
				.mockReturnValueOnce([
					{
						id: 7,
						athenaSessionId: 'athena-1',
						requestId: 'req-1',
						decision,
						receivedAt: 1,
					},
				])
				.mockReturnValue([]);
			const configureTimer = vi.fn();

			const drain = startDashboardDecisionDrain({
				runtime: {sendDecision},
				inbox: {pendingForSession, markConsumed},
				athenaSessionId: 'athena-1',
				pollIntervalMs: 50,
				configureTimer,
			});

			expect(pendingForSession).toHaveBeenCalledWith({
				athenaSessionId: 'athena-1',
				limit: DASHBOARD_DECISION_POLL_LIMIT,
			});
			expect(sendDecision).toHaveBeenCalledWith('req-1', decision);
			expect(markConsumed).toHaveBeenCalledWith({id: 7});
			expect(configureTimer).toHaveBeenCalledTimes(1);

			// Interval fires with an empty pending set (no further sends).
			vi.advanceTimersByTime(50);
			expect(sendDecision).toHaveBeenCalledTimes(1);

			drain.stop();
			vi.advanceTimersByTime(200);
			expect(pendingForSession).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('routes a failed decision to onError and continues the pass', () => {
		vi.useFakeTimers();
		try {
			const sendDecision = vi
				.fn()
				.mockImplementationOnce(() => {
					throw new Error('boom');
				})
				.mockImplementation(() => {});
			const markConsumed = vi.fn();
			const onError = vi.fn();
			const rows = [
				{
					id: 1,
					athenaSessionId: 'a',
					requestId: 'r-1',
					decision,
					receivedAt: 1,
				},
				{
					id: 2,
					athenaSessionId: 'a',
					requestId: 'r-2',
					decision,
					receivedAt: 2,
				},
			];

			const drain = startDashboardDecisionDrain({
				runtime: {sendDecision},
				inbox: {
					pendingForSession: vi
						.fn()
						.mockReturnValueOnce(rows)
						.mockReturnValue([]),
					markConsumed,
				},
				athenaSessionId: 'a',
				onError,
			});

			expect(onError).toHaveBeenCalledTimes(1);
			// The first row threw before markConsumed; the second still processed.
			expect(sendDecision).toHaveBeenCalledTimes(2);
			expect(markConsumed).toHaveBeenCalledTimes(1);
			expect(markConsumed).toHaveBeenCalledWith({id: 2});
			drain.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});
