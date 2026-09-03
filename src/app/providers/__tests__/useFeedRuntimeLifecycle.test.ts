/** @vitest-environment jsdom */
import {describe, it, expect, vi} from 'vitest';
import {renderHook, act} from '@testing-library/react';
import {useFeed} from '../useFeed';
import type {SessionStore} from '../../../infra/sessions/store';
import type {
	Runtime,
	RuntimeEventHandler,
	RuntimeDecisionHandler,
	RuntimeStartupError,
} from '../../../core/runtime/types';

function createMockRuntime(): Runtime {
	const eventListeners: RuntimeEventHandler[] = [];
	const decisionListeners: RuntimeDecisionHandler[] = [];
	let status: 'stopped' | 'running' = 'running';
	let lastError: RuntimeStartupError | null = null;

	return {
		onEvent: cb => {
			eventListeners.push(cb);
			return () => {
				eventListeners.splice(eventListeners.indexOf(cb), 1);
			};
		},
		onDecision: cb => {
			decisionListeners.push(cb);
			return () => {
				decisionListeners.splice(decisionListeners.indexOf(cb), 1);
			};
		},
		sendDecision: vi.fn(),
		start: vi.fn(() => {
			status = 'running';
			lastError = null;
			return Promise.resolve();
		}),
		stop: vi.fn(() => {
			status = 'stopped';
			lastError = null;
		}),
		getStatus: () => status,
		getLastError: () => lastError,
	};
}

const fakeSessionStore: SessionStore = {
	close: vi.fn(),
	recordTokens: vi.fn(),
	recordFeedEvents: vi.fn(),
	recordRuntimeEvent: vi.fn(),
	getRestoredTokens: () => null,
	markDegraded: vi.fn(),
	toBootstrap: vi.fn(),
	saveAdapterSession: vi.fn(),
	loadAdapterSession: vi.fn(),
	getAdapterSessions: vi.fn(),
	deleteAdapterSession: vi.fn(),
	upsertWorkflowRun: vi.fn(),
	getLatestWorkflowRun: vi.fn(),
	listSessionWorkflowRuns: vi.fn(),
} as unknown as SessionStore;

describe('useFeed runtime lifecycle ownership', () => {
	it('does not start or stop runtime on dep changes or unmount', () => {
		const runtime = createMockRuntime();
		const publisherA = {publish: vi.fn()};
		const publisherB = {publish: vi.fn()};

		const {rerender, unmount} = renderHook(
			({publisher}: {publisher: {publish: () => void}}) =>
				useFeed(runtime, [], undefined, fakeSessionStore, {
					dashboardFeedPublisher: publisher,
				}),
			{initialProps: {publisher: publisherA}},
		);

		expect(runtime.start).not.toHaveBeenCalled();
		expect(runtime.stop).not.toHaveBeenCalled();

		// Simulate an option identity change (a new dashboard feed publisher)
		// so useFeed's subscription effect re-runs.
		act(() => {
			rerender({publisher: publisherB});
		});

		// The bug being regressed: cleanup unconditionally called
		// runtime.stop(), unbinding the hook server while the parent
		// (HookProvider) still owned the lifecycle.
		expect(runtime.stop).not.toHaveBeenCalled();
		expect(runtime.getStatus()).toBe('running');

		unmount();
		// Final unmount also leaves the runtime alone. HookProvider owns
		// teardown.
		expect(runtime.stop).not.toHaveBeenCalled();
	});
});
