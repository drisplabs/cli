import {describe, expect, it, vi} from 'vitest';
import type {RunStreamClient} from './runStreamClient';
import {createRemoteRunEventPublisher} from './remoteRunEventPublisher';

describe('RemoteRunEventPublisher', () => {
	it('falls back to legacy run_event when the per-run stream cannot connect', async () => {
		const sentLegacy: unknown[] = [];
		const close = vi.fn(async () => {});
		const publisher = await createRemoteRunEventPublisher({
			runId: 'run-1',
			callbackWsUrl: 'wss://dashboard.test/run-1',
			callbackToken: 'token',
			client: {sendRunEvent: frame => sentLegacy.push(frame)},
			createRunStreamClient: () =>
				({
					connect: async () => {
						throw new Error('offline');
					},
					sendEvent: vi.fn(),
					whenTerminated: async () => {},
					close,
				}) satisfies RunStreamClient,
		});

		publisher.publish('progress', {message: 'hello'}, 1234);

		expect(sentLegacy).toEqual([
			{
				runId: 'run-1',
				seq: 1,
				ts: 1234,
				kind: 'progress',
				payload: {message: 'hello'},
			},
		]);
		expect(close).toHaveBeenCalledWith('connect_failed');
		await publisher.close();
	});
});

it('clears connect and drain timers and closes the callback only once', async () => {
	vi.useFakeTimers();
	try {
		const close = vi.fn(async () => {});
		const sendEvent = vi.fn();
		const publisher = await createRemoteRunEventPublisher({
			runId: 'r',
			callbackWsUrl: 'wss://test',
			callbackToken: 'token',
			client: {sendRunEvent: vi.fn()},
			createRunStreamClient: () => ({
				connect: async () => {},
				sendEvent,
				whenTerminated: async () => {},
				close,
			}),
		});
		expect(vi.getTimerCount()).toBe(0);
		publisher.publish('progress', {}, 1);
		expect(sendEvent).toHaveBeenCalledOnce();
		await Promise.all([publisher.close(), publisher.close()]);
		expect(vi.getTimerCount()).toBe(0);
		expect(close).toHaveBeenCalledOnce();
		publisher.publish('progress', {}, 2);
		expect(sendEvent).toHaveBeenCalledOnce();
	} finally {
		vi.useRealTimers();
	}
});
