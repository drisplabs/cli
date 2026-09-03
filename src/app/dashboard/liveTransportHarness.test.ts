import {describe, expect, it} from 'vitest';
import {
	runLiveTransportHarness,
	type HubProtocol,
} from './liveTransportHarness';

// Integration test that drives the live-transport harness end to end against a
// fake hub on a real loopback http + ws server, once per frame-name set the
// hub can speak. This is the documented invocation for the harness (see
// liveTransportHarness.README.md) and the regression guard that keeps the real
// handshake / normalise / reconnect / reconcile path working against both the
// hub of today (old names, no hello) and a migrated hub (new names, hello).
describe.each<HubProtocol>(['legacy', 'canonical'])(
	'live-transport dashboard-daemon harness (%s hub)',
	hubProtocol => {
		it('passes every scenario against a real loopback transport', async () => {
			const result = await runLiveTransportHarness({hubProtocol});

			// Surface the per-scenario detail when a scenario regresses.
			const failures = result.checks.filter(check => check.status === 'fail');
			expect(
				failures,
				failures.map(check => `${check.label}: ${check.message}`).join('\n'),
			).toEqual([]);

			expect(result.ok).toBe(true);
			expect(result.checks.map(check => check.label)).toEqual([
				'Versioned hello first',
				'Graceful degradation on 503 reconcile',
				'Wire mode negotiated',
				'Assignment admitted over the wire',
				'Run stream and needs_human on the wire',
				'Answer stored and Run woken while parked',
				'Steer delivered into the next Turn',
				'Phase event on the feed stream',
				'Malformed frames answered with error',
				'Stop cancels the run',
				'Workflow store change pushed',
				'Reconnect after close',
				'Every runner frame in the expected name set',
			]);
			expect(result.checks.every(check => check.status === 'pass')).toBe(true);
		}, 20_000);
	},
);
