import {describe, expect, it, vi} from 'vitest';
import {PermissionRelay} from './permissionRelay';
import type {Runtime, RuntimeEvent} from '../core/runtime/types';

type DecisionStub = {
	source: 'rule' | 'user' | 'timeout';
	intent?: {kind: string};
};

function makeRuntime(): Runtime & {
	emitDecision: (eventId: string, decision: DecisionStub) => void;
} {
	const decisionHandlers = new Set<
		(eventId: string, decision: DecisionStub) => void
	>();
	const runtime: Partial<Runtime> & {
		emitDecision: (eventId: string, decision: DecisionStub) => void;
	} = {
		start: vi.fn(),
		stop: vi.fn(),
		getStatus: vi.fn(() => 'running'),
		getLastError: vi.fn(() => null),
		onEvent: vi.fn(() => () => {}),
		onDecision: vi.fn(
			(handler: (eventId: string, decision: DecisionStub) => void) => {
				decisionHandlers.add(handler);
				return () => {
					decisionHandlers.delete(handler);
				};
			},
		),
		sendDecision: vi.fn(),
		emitDecision: (eventId, decision) => {
			for (const h of decisionHandlers) h(eventId, decision);
		},
	};
	return runtime as Runtime & {
		emitDecision: (eventId: string, decision: DecisionStub) => void;
	};
}

function makeEvent(id: string): RuntimeEvent {
	return {
		id,
		timestamp: 0,
		kind: 'permission.request',
		data: {tool_name: 'Bash', tool_input: {}},
		hookName: 'PreToolUse',
		sessionId: 's',
		context: {cwd: '/', transcriptPath: ''},
		interaction: {expectsDecision: true},
		payload: {},
	};
}

describe('PermissionRelay', () => {
	it('tryClaim is atomic — first wins, second returns false', () => {
		const runtime = makeRuntime();
		const relay = new PermissionRelay({runtime});
		const ev = makeEvent('e1');
		relay.register(ev, 'abcde', 'Bash');

		expect(relay.isPending('e1')).toBe(true);
		expect(relay.tryClaim('e1', 'local')).toBe(true);
		expect(relay.tryClaim('e1', 'channel')).toBe(false);
		expect(relay.isPending('e1')).toBe(false);
		relay.dispose();
	});

	it('onClaimed fires with source and context for the winner', () => {
		const runtime = makeRuntime();
		const relay = new PermissionRelay({runtime});
		const onClaimed = vi.fn();
		relay.setOnClaimed(onClaimed);

		const ev = makeEvent('e1');
		relay.register(ev, 'abcde', 'Bash');
		relay.tryClaim('e1', 'channel', {
			behavior: 'allow',
			resolvingChannelName: 'telegram',
		});

		expect(onClaimed).toHaveBeenCalledTimes(1);
		expect(onClaimed.mock.calls[0]![1]).toBe('channel');
		expect(onClaimed.mock.calls[0]![2]).toEqual({
			behavior: 'allow',
			resolvingChannelName: 'telegram',
		});
		relay.dispose();
	});

	it('runtime.onDecision triggers tryClaim with mapped source and behavior', () => {
		const runtime = makeRuntime();
		const relay = new PermissionRelay({runtime});
		const onClaimed = vi.fn();
		relay.setOnClaimed(onClaimed);

		const ev = makeEvent('rule-event');
		relay.register(ev, 'aaaaa', 'Bash');
		runtime.emitDecision('rule-event', {
			source: 'rule',
			intent: {kind: 'permission_allow'},
		});
		expect(onClaimed).toHaveBeenCalledWith(
			expect.objectContaining({channelRequestId: 'aaaaa'}),
			'rule',
			{behavior: 'allow', resolvingChannelName: null},
		);

		const ev2 = makeEvent('timeout-event');
		relay.register(ev2, 'bbbbb', 'Edit');
		runtime.emitDecision('timeout-event', {source: 'timeout'});
		expect(onClaimed).toHaveBeenCalledWith(
			expect.objectContaining({channelRequestId: 'bbbbb'}),
			'timeout',
			{behavior: null, resolvingChannelName: null},
		);
		relay.dispose();
	});

	it('register throws on channelRequestId collision', () => {
		const runtime = makeRuntime();
		const relay = new PermissionRelay({runtime});
		relay.register(makeEvent('e1'), 'aaaaa', 'Bash');
		expect(() => relay.register(makeEvent('e2'), 'aaaaa', 'Edit')).toThrow(
			/collision/,
		);
		relay.dispose();
	});

	it('resolveByChannelId looks up runtimeEventId', () => {
		const runtime = makeRuntime();
		const relay = new PermissionRelay({runtime});
		relay.register(makeEvent('rt-1'), 'abcde', 'Bash');

		const found = relay.resolveByChannelId('abcde');
		expect(found?.runtimeEventId).toBe('rt-1');
		expect(relay.resolveByChannelId('zzzzz')).toBeUndefined();
		relay.dispose();
	});

	it('dispose unsubscribes the runtime listener', () => {
		const runtime = makeRuntime();
		const relay = new PermissionRelay({runtime});
		const onClaimed = vi.fn();
		relay.setOnClaimed(onClaimed);
		relay.register(makeEvent('e'), 'aaaaa', 'Bash');

		relay.dispose();
		runtime.emitDecision('e', {source: 'rule'});
		expect(onClaimed).not.toHaveBeenCalled();
	});

	it('user-source decisions collapse onto local ClaimSource', () => {
		const runtime = makeRuntime();
		const relay = new PermissionRelay({runtime});
		const onClaimed = vi.fn();
		relay.setOnClaimed(onClaimed);
		relay.register(makeEvent('e'), 'aaaaa', 'Bash');

		runtime.emitDecision('e', {
			source: 'user',
			intent: {kind: 'permission_allow'},
		});
		expect(onClaimed).toHaveBeenCalledWith(
			expect.objectContaining({channelRequestId: 'aaaaa'}),
			'local',
			{behavior: 'allow', resolvingChannelName: null},
		);
	});

	it('handler exceptions do not corrupt relay state', () => {
		const runtime = makeRuntime();
		const relay = new PermissionRelay({runtime});
		relay.setOnClaimed(() => {
			throw new Error('boom');
		});
		relay.register(makeEvent('e'), 'aaaaa', 'Bash');

		expect(() => relay.tryClaim('e', 'local')).not.toThrow();
		expect(relay.isPending('e')).toBe(false);
		relay.dispose();
	});
});
