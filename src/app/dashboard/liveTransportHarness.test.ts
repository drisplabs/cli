import {describe, expect, it} from 'vitest';
import {
	runLiveTransportHarness,
	runRunnerRecoveryHarness,
	type HubProtocol,
} from './liveTransportHarness';

// Integration test that drives the live-transport harness end to end against a
// fake hub on a real loopback http + ws server, once per frame-name set the
// hub can speak. This is the documented invocation for the harness (see
// liveTransportHarness.README.md) and the regression guard that keeps the real
// handshake / normalise / reconnect / reconcile path working against both the
// hub of today (old names, no hello) and a migrated hub (new names, hello).
describe.each<HubProtocol>(['legacy', 'canonical'])(
	'live-transport drisp runner harness (%s hub)',
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
				'Pid file held and status file current',
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

		// #188: a runner killed mid-Run and restarted drains the outbox and
		// re-delivers the pending decision, at the runner's public seam.
		it('recovers from a crash: drains the outbox and re-delivers the pending decision', async () => {
			const result = await runRunnerRecoveryHarness({hubProtocol});

			const failures = result.checks.filter(check => check.status === 'fail');
			expect(
				failures,
				failures.map(check => `${check.label}: ${check.message}`).join('\n'),
			).toEqual([]);

			expect(result.ok).toBe(true);
			expect(result.checks.map(check => check.label)).toEqual([
				'Runner paired',
				'Run streamed, acks withheld',
				'Answer persisted and acked',
				'Killed mid-Run and restarted',
				'Outbox drained after restart',
				'Pending decision re-delivered',
				'Every runner frame in the expected name set',
			]);
		}, 20_000);
	},
);
