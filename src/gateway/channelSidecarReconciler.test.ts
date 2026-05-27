import {describe, expect, it, vi} from 'vitest';
import {ChannelManager} from './channelManager';
import {ChannelSidecarReconciler} from './channelSidecarReconciler';
import type {ChannelSidecar} from '../infra/config/channels';
import type {
	AdapterContext,
	ChannelAdapter,
	OutboundMessage,
	StopReason,
} from '../shared/gateway-protocol';

class TestAdapter implements ChannelAdapter {
	readonly capabilities = {
		chat: true,
		threads: false,
		relayPermission: false,
		relayQuestion: false,
	} as const;
	readonly starts: AdapterContext[] = [];
	readonly stops: StopReason[] = [];

	constructor(
		readonly id: string,
		private readonly opts: {
			startError?: Error;
			stopError?: Error;
		} = {},
	) {}

	async start(ctx: AdapterContext): Promise<void> {
		this.starts.push(ctx);
		if (this.opts.startError) throw this.opts.startError;
	}

	async stop(reason: StopReason): Promise<void> {
		this.stops.push(reason);
		if (this.opts.stopError) throw this.opts.stopError;
	}

	async send(_msg: OutboundMessage) {
		return {providerMessageId: 'msg-1', deliveredAt: 1};
	}

	async probe() {
		return {ok: true, checkedAt: 1};
	}
}

function sidecar(
	instanceId: string,
	opts: Partial<ChannelSidecar> = {},
): ChannelSidecar {
	return {
		name: instanceId,
		path: `/tmp/channels/${instanceId}.json`,
		kind: 'test',
		instanceId,
		allowedUserIds: [],
		options: {},
		...opts,
	};
}

describe('ChannelSidecarReconciler', () => {
	it('reconciles loaded channel sidecars into registered channels', async () => {
		const channelManager = new ChannelManager();
		const stale = new TestAdapter('stale');
		const oldConsole = new TestAdapter('console:old');
		await channelManager.register(stale);
		await channelManager.register(oldConsole);
		const newConsole = new TestAdapter('console:old');
		const newSlack = new TestAdapter('slack');
		const instantiateAdapter = vi.fn((loaded: ChannelSidecar) => {
			if (loaded.instanceId === 'broken') {
				return {ok: false as const, reason: 'broken config'};
			}
			return {
				ok: true as const,
				adapter: loaded.instanceId === 'console:old' ? newConsole : newSlack,
			};
		});
		const reconciler = new ChannelSidecarReconciler({
			channelManager,
			home: '/tmp/home',
			loadSidecars: vi.fn(() => ({
				sidecars: [
					sidecar('console:old', {attachmentId: 'runner-1'}),
					sidecar('broken'),
					sidecar('slack'),
				],
				errors: [{path: '/tmp/channels/bad.json', reason: 'bad json'}],
			})),
			instantiateAdapter,
		});

		const result = await reconciler.reconcile({unregisterStale: true});

		expect(result.results).toEqual([
			{id: 'bad', ok: false, action: 'failed', reason: 'bad json'},
			{id: 'stale', ok: true, action: 'unregistered'},
			{id: 'console:old', ok: true, action: 'replaced'},
			{id: 'broken', ok: false, action: 'failed', reason: 'broken config'},
			{id: 'slack', ok: true, action: 'registered'},
		]);
		expect(instantiateAdapter).toHaveBeenCalledTimes(3);
		expect(stale.stops).toEqual(['shutdown']);
		expect(oldConsole.stops).toEqual(['shutdown']);
		expect(newConsole.starts).toHaveLength(1);
		expect(newSlack.starts).toHaveLength(1);
		expect(channelManager.listChannels().map(channel => channel.id)).toEqual([
			'console:old',
			'slack',
		]);
		expect(channelManager.getAttachmentId('console:old')).toBe('runner-1');
	});

	it('can load sidecars without unregistering channels absent from config', async () => {
		const channelManager = new ChannelManager();
		const existing = new TestAdapter('manual');
		const loaded = new TestAdapter('console');
		await channelManager.register(existing);
		const reconciler = new ChannelSidecarReconciler({
			channelManager,
			loadSidecars: () => ({
				sidecars: [sidecar('console')],
				errors: [],
			}),
			instantiateAdapter: () => ({ok: true, adapter: loaded}),
		});

		const result = await reconciler.reconcile({unregisterStale: false});

		expect(result.results).toEqual([
			{id: 'console', ok: true, action: 'registered'},
		]);
		expect(existing.stops).toEqual([]);
		expect(channelManager.listChannels().map(channel => channel.id)).toEqual([
			'manual',
			'console',
		]);
	});

	it('reports unregister failures without blocking unrelated sidecars', async () => {
		const channelManager = new ChannelManager();
		const stale = new TestAdapter('stale', {
			stopError: new Error('stop failed'),
		});
		const loaded = new TestAdapter('console');
		await channelManager.register(stale);
		const reconciler = new ChannelSidecarReconciler({
			channelManager,
			loadSidecars: () => ({
				sidecars: [sidecar('console')],
				errors: [],
			}),
			instantiateAdapter: () => ({ok: true, adapter: loaded}),
		});

		const result = await reconciler.reconcile({unregisterStale: true});

		expect(result.results).toEqual([
			{
				id: 'stale',
				ok: false,
				action: 'failed',
				reason: 'stop failed',
			},
			{id: 'console', ok: true, action: 'registered'},
		]);
		expect(stale.stops).toEqual(['shutdown']);
		expect(channelManager.listChannels().map(channel => channel.id)).toEqual([
			'console',
		]);
	});

	it('reports register failures without leaving hidden partial state', async () => {
		const channelManager = new ChannelManager();
		const failing = new TestAdapter('console', {
			startError: new Error('start failed'),
		});
		const reconciler = new ChannelSidecarReconciler({
			channelManager,
			loadSidecars: () => ({
				sidecars: [sidecar('console')],
				errors: [],
			}),
			instantiateAdapter: () => ({ok: true, adapter: failing}),
		});

		const result = await reconciler.reconcile({unregisterStale: true});

		expect(result.results).toEqual([
			{
				id: 'console',
				ok: false,
				action: 'failed',
				reason: 'start failed',
			},
		]);
		expect(failing.starts).toHaveLength(1);
		expect(channelManager.listChannels()).toEqual([]);
	});
});
