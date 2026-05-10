/**
 * Handler-level tests for relay.* dispatcher entries. Boots no daemon —
 * `createDispatcher` is invoked directly with mocked deps so we can assert
 * authorization (a connection that authenticated by token but never
 * registered as a runtime cannot create or cancel relay requests).
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {createDispatcher} from './handlers';
import {RelayCoordinator} from '../relay/coordinator';
import {DispatchPipeline} from '../dispatchPipeline';
import {openGatewayState, type GatewayStateDb} from '../state/db';
import type {ConnectionContext} from './server';
import type {
	ChannelAdapter,
	ControlEnvelope,
	ControlResponseEnvelope,
} from '../../shared/gateway-protocol';

function makeAdapter(): ChannelAdapter {
	return {
		id: 'fake',
		capabilities: {
			chat: true,
			threads: false,
			relayPermission: true,
			relayQuestion: true,
		},
		start: async () => {},
		stop: async () => {},
		send: async () => ({providerMessageId: 'm', deliveredAt: 0}),
		probe: async () => ({ok: true, checkedAt: 0}),
		on: () => {},
		off: () => {},
		requestPermissionVerdict: () => new Promise(() => {}),
		requestQuestionAnswer: () => new Promise(() => {}),
	};
}

function makeConnection(connectionId: string): ConnectionContext {
	return {
		connectionId,
		push: vi.fn(),
		disconnect: vi.fn(),
	};
}

function envelope<K extends string, P>(
	kind: K,
	payload: P,
): ControlEnvelope<K, P> {
	return {request_id: `req-${kind}`, ts: 0, kind, payload};
}

function expectError(
	res: ControlResponseEnvelope,
): Extract<ControlResponseEnvelope, {ok: false}> {
	if (res.ok)
		throw new Error(
			`expected error envelope, got ok payload ${JSON.stringify(res)}`,
		);
	return res;
}

const cleanup: Array<{db: GatewayStateDb; pipeline: DispatchPipeline}> = [];

function makePipeline(): DispatchPipeline {
	const db = openGatewayState(':memory:');
	const pipeline = new DispatchPipeline({
		stateDb: db,
		send: async () => ({providerMessageId: 'm', deliveredAt: 0}),
		outbox: {tickIntervalMs: 60_000},
	});
	cleanup.push({db, pipeline});
	return pipeline;
}

afterEach(async () => {
	while (cleanup.length > 0) {
		const entry = cleanup.pop()!;
		await entry.pipeline.stop();
		entry.db.close();
	}
});

describe('dispatcher: relay.* require a registered runtime connection', () => {
	it('relay.permission.request rejects unregistered authenticated callers', async () => {
		const pipeline = makePipeline();
		const relayCoordinator = new RelayCoordinator({
			adapters: () => [makeAdapter()],
		});
		const handle = createDispatcher({
			startedAt: 0,
			pipeline,
			relayCoordinator,
		});
		const res = await handle(
			envelope('relay.permission.request', {
				toolName: 'Bash',
				description: 'ls',
				inputPreview: '',
			}),
			makeConnection('conn-x'),
		);
		const err = expectError(res);
		expect(err.error.code).toBe('not_registered');
		expect(relayCoordinator.pendingCount()).toBe(0);
	});

	it('relay.question.request rejects unregistered authenticated callers', async () => {
		const pipeline = makePipeline();
		const relayCoordinator = new RelayCoordinator({
			adapters: () => [makeAdapter()],
		});
		const handle = createDispatcher({
			startedAt: 0,
			pipeline,
			relayCoordinator,
		});
		const res = await handle(
			envelope('relay.question.request', {
				title: 'pick',
				questions: [
					{
						key: 'q',
						header: 'h',
						question: 'q?',
						multi_select: false,
						options: [],
					},
				],
			}),
			makeConnection('conn-x'),
		);
		const err = expectError(res);
		expect(err.error.code).toBe('not_registered');
		expect(relayCoordinator.pendingCount()).toBe(0);
	});

	it('relay.permission.cancel rejects unregistered authenticated callers', async () => {
		const pipeline = makePipeline();
		const relayCoordinator = new RelayCoordinator({
			adapters: () => [makeAdapter()],
		});
		const cancelSpy = vi.spyOn(relayCoordinator, 'cancel');
		const handle = createDispatcher({
			startedAt: 0,
			pipeline,
			relayCoordinator,
		});
		const res = await handle(
			envelope('relay.permission.cancel', {
				channelRequestId: 'cr1',
				reason: 'resolved_locally',
			}),
			makeConnection('conn-x'),
		);
		const err = expectError(res);
		expect(err.error.code).toBe('not_registered');
		expect(cancelSpy).not.toHaveBeenCalled();
	});

	it('relay.question.cancel rejects unregistered authenticated callers', async () => {
		const pipeline = makePipeline();
		const relayCoordinator = new RelayCoordinator({
			adapters: () => [makeAdapter()],
		});
		const cancelSpy = vi.spyOn(relayCoordinator, 'cancel');
		const handle = createDispatcher({
			startedAt: 0,
			pipeline,
			relayCoordinator,
		});
		const res = await handle(
			envelope('relay.question.cancel', {
				channelRequestId: 'cr1',
				reason: 'resolved_locally',
			}),
			makeConnection('conn-x'),
		);
		const err = expectError(res);
		expect(err.error.code).toBe('not_registered');
		expect(cancelSpy).not.toHaveBeenCalled();
	});

	it('relay.permission.request succeeds once the connection is bound to a runtime', async () => {
		const pipeline = makePipeline();
		const relayCoordinator = new RelayCoordinator({
			adapters: () => [makeAdapter()],
		});
		pipeline.registerRuntime({
			runtimeId: 'r1',
			defaultAgentId: 'main',
			pid: 1,
			connectionId: 'conn-r1',
			push: vi.fn(),
		});
		const handle = createDispatcher({
			startedAt: 0,
			pipeline,
			relayCoordinator,
		});
		const reqPromise = handle(
			envelope('relay.permission.request', {
				channelRequestId: 'cr1',
				toolName: 'Bash',
				description: 'ls',
				inputPreview: '',
			}),
			makeConnection('conn-r1'),
		);
		// Adapter never resolves; cancel to free the pending entry so the
		// handler resolves and the test exits cleanly.
		await Promise.resolve();
		expect(relayCoordinator.pendingCount()).toBe(1);
		relayCoordinator.cancel('cr1', 'resolved_locally', 'r1');
		const res = await reqPromise;
		expect(res.ok).toBe(true);
	});
});

describe('dispatcher: channels.reload', () => {
	it('delegates to the configured channel reloader', async () => {
		const reloadChannels = vi.fn(async () => ({
			results: [
				{
					id: 'console',
					ok: true,
					action: 'registered' as const,
				},
			],
		}));
		const handle = createDispatcher({
			startedAt: 0,
			reloadChannels,
		});

		const res = await handle(
			envelope('channels.reload', {}),
			makeConnection('conn-x'),
		);

		expect(reloadChannels).toHaveBeenCalledTimes(1);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.payload).toEqual({
			results: [{id: 'console', ok: true, action: 'registered'}],
		});
	});

	it('returns unsupported when the daemon did not configure a reloader', async () => {
		const handle = createDispatcher({startedAt: 0});

		const res = await handle(
			envelope('channels.reload', {}),
			makeConnection('conn-x'),
		);

		const err = expectError(res);
		expect(err.error.code).toBe('unsupported');
	});
});

describe('dispatcher: session.register attachmentId routing', () => {
	it('places the runtime in the attachmentId-keyed slot when the payload carries one', async () => {
		const pipeline = makePipeline();
		const handle = createDispatcher({startedAt: 0, pipeline});

		const res = await handle(
			envelope('session.register', {
				runtimeId: 'r1',
				defaultAgentId: 'main',
				pid: 100,
				attachmentId: 'a1',
			}),
			makeConnection('conn-r1'),
		);

		expect(res.ok).toBe(true);
		expect(pipeline.getCurrentRuntimeByAttachment('a1')?.runtimeId).toBe('r1');
		expect(pipeline.getCurrentRuntime()).toBeNull(); // legacy slot is empty
	});

	it('places the runtime in the legacy slot when the payload omits attachmentId', async () => {
		const pipeline = makePipeline();
		const handle = createDispatcher({startedAt: 0, pipeline});

		const res = await handle(
			envelope('session.register', {
				runtimeId: 'r-legacy',
				defaultAgentId: 'main',
				pid: 1,
			}),
			makeConnection('conn-legacy'),
		);

		expect(res.ok).toBe(true);
		expect(pipeline.getCurrentRuntime()?.runtimeId).toBe('r-legacy');
		expect(pipeline.getCurrentRuntimeByAttachment('a1')).toBeNull();
	});

	it('accepts two runtimes registering under distinct attachmentIds without conflict', async () => {
		const pipeline = makePipeline();
		const handle = createDispatcher({startedAt: 0, pipeline});

		const r1 = await handle(
			envelope('session.register', {
				runtimeId: 'r1',
				defaultAgentId: 'main',
				pid: 100,
				attachmentId: 'a1',
			}),
			makeConnection('conn-r1'),
		);
		const r2 = await handle(
			envelope('session.register', {
				runtimeId: 'r2',
				defaultAgentId: 'main',
				pid: 200,
				attachmentId: 'a2',
			}),
			makeConnection('conn-r2'),
		);

		expect(r1.ok).toBe(true);
		expect(r2.ok).toBe(true);
		expect(pipeline.getCurrentRuntimeByAttachment('a1')?.runtimeId).toBe('r1');
		expect(pipeline.getCurrentRuntimeByAttachment('a2')?.runtimeId).toBe('r2');
	});
});
