/** @vitest-environment jsdom */
import {describe, it, expect, vi} from 'vitest';
import {renderHook, act} from '@testing-library/react';
import {useFeed} from '../useFeed';
import type {SessionStore} from '../../../infra/sessions/store';
import type {Runtime} from '../../../core/runtime/types';

function createMockRuntime(): Runtime {
	return {
		onEvent: () => () => {},
		onDecision: () => () => {},
		sendDecision: vi.fn(),
		start: vi.fn(() => Promise.resolve()),
		stop: vi.fn(),
		getStatus: () => 'running',
		getLastError: () => null,
	};
}

function createFakeSessionStore(): SessionStore {
	return {
		close: vi.fn(),
		recordTokens: vi.fn(),
		recordFeedEvents: vi.fn(),
		recordRuntimeEvent: vi.fn(),
		getRestoredTokens: () => null,
		markDegraded: vi.fn(),
		toBootstrap: vi.fn(),
		getAthenaSession: () => ({id: 'athena-1'}),
		saveAdapterSession: vi.fn(),
		loadAdapterSession: vi.fn(),
		getAdapterSessions: vi.fn(),
		deleteAdapterSession: vi.fn(),
		upsertWorkflowRun: vi.fn(),
		getLatestWorkflowRun: vi.fn(),
		listSessionWorkflowRuns: vi.fn(),
	} as unknown as SessionStore;
}

describe('useFeed emitPhase', () => {
	it('puts a phase FeedEvent on the timeline, persists it, and publishes it to the paired feed', () => {
		const runtime = createMockRuntime();
		const store = createFakeSessionStore();
		const publisher = {publish: vi.fn()};

		const {result} = renderHook(() =>
			useFeed(runtime, [], undefined, store, {
				dashboardFeedPublisher: publisher,
				athenaSessionId: 'athena-1',
			}),
		);

		act(() => {
			result.current.emitPhase({
				runId: 'run_42',
				turn: 2,
				step: 'Build',
				stepIndex: 2,
				stepTotal: 3,
			});
		});

		const phase = result.current.feedEvents.find(e => e.kind === 'phase');
		expect(phase).toMatchObject({
			kind: 'phase',
			title: 'Step 2/3: Build',
			actor_id: 'system',
			data: {
				runId: 'run_42',
				turn: 2,
				step: 'Build',
				stepIndex: 2,
				stepTotal: 3,
			},
		});
		expect(store.recordFeedEvents).toHaveBeenCalledWith([
			expect.objectContaining({kind: 'phase'}),
		]);
		expect(publisher.publish).toHaveBeenCalledWith(
			expect.objectContaining({
				origin: 'local',
				athenaSessionId: 'athena-1',
				feedEvents: [expect.objectContaining({kind: 'phase'})],
			}),
		);
	});
});
