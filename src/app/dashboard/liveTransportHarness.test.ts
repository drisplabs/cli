import {describe, expect, it} from 'vitest';
import {runLiveTransportHarness} from './liveTransportHarness';

// Integration test that drives the live-transport harness end to end against a
// real loopback http + ws server. This is the documented invocation for the
// harness (see liveTransportHarness.README.md) and the regression guard that
// keeps the real reconnect/reconcile path working.
describe('live-transport dashboard-daemon harness', () => {
	it('passes every scenario against a real loopback transport', async () => {
		const result = await runLiveTransportHarness();

		// Surface the per-scenario detail when a scenario regresses.
		const failures = result.checks.filter(check => check.status === 'fail');
		expect(
			failures,
			failures.map(check => `${check.label}: ${check.message}`).join('\n'),
		).toEqual([]);

		expect(result.ok).toBe(true);
		expect(result.checks.map(check => check.label)).toEqual([
			'Graceful degradation on 503 reconcile',
			'Assignment admitted over the wire',
			'Reconnect after close',
		]);
		expect(result.checks.every(check => check.status === 'pass')).toBe(true);
	}, 20_000);
});
