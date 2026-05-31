import {describe, expect, it} from 'vitest';
import {planChannelReconciliation} from './channelReconcilePlan';
import type {ChannelSidecar} from '../infra/config/channels';

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

describe('planChannelReconciliation', () => {
	it('plans a register action for a desired sidecar with no current channel', () => {
		const plan = planChannelReconciliation({
			desired: [sidecar('console')],
			currentChannelIds: [],
			loadErrors: [],
			unregisterStale: true,
		});

		expect(plan.actions).toEqual([
			{kind: 'register', sidecar: sidecar('console')},
		]);
	});

	it('plans a replace action when the sidecar is already registered', () => {
		const plan = planChannelReconciliation({
			desired: [sidecar('console')],
			currentChannelIds: ['console'],
			loadErrors: [],
			unregisterStale: true,
		});

		expect(plan.actions).toEqual([
			{kind: 'replace', sidecar: sidecar('console')},
		]);
	});

	it('plans unregister-stale for current channels absent from desired when unregisterStale is true', () => {
		const plan = planChannelReconciliation({
			desired: [sidecar('console')],
			currentChannelIds: ['stale', 'console'],
			loadErrors: [],
			unregisterStale: true,
		});

		expect(plan.actions).toEqual([
			{kind: 'unregister-stale', id: 'stale'},
			{kind: 'replace', sidecar: sidecar('console')},
		]);
	});

	it('omits unregister-stale actions when unregisterStale is false', () => {
		const plan = planChannelReconciliation({
			desired: [sidecar('console')],
			currentChannelIds: ['manual'],
			loadErrors: [],
			unregisterStale: false,
		});

		expect(plan.actions).toEqual([
			{kind: 'register', sidecar: sidecar('console')},
		]);
	});

	it('orders load-errors, then stale unregisters, then desired sidecars', () => {
		const plan = planChannelReconciliation({
			desired: [
				sidecar('console', {attachmentId: 'runner-1'}),
				sidecar('slack'),
			],
			currentChannelIds: ['stale', 'console'],
			loadErrors: [{path: '/tmp/channels/bad.json', reason: 'bad json'}],
			unregisterStale: true,
		});

		expect(plan.actions).toEqual([
			{
				kind: 'load-error',
				id: 'bad',
				path: '/tmp/channels/bad.json',
				reason: 'bad json',
			},
			{kind: 'unregister-stale', id: 'stale'},
			{
				kind: 'replace',
				sidecar: sidecar('console', {attachmentId: 'runner-1'}),
			},
			{kind: 'register', sidecar: sidecar('slack')},
		]);
	});
});
