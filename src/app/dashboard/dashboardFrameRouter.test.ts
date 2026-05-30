import {describe, expect, it, vi} from 'vitest';
import {routeDashboardRunFrame} from './dashboardFrameRouter';
import type {DashboardPairedExecution} from './dashboardPairedExecution';
import type {InstanceSocketFrame} from './instanceSocketClient';

function makeExecution() {
	return {
		cancelRun: vi.fn(() => true),
		submitDashboardDecision: vi.fn(),
	} satisfies Pick<
		DashboardPairedExecution,
		'cancelRun' | 'submitDashboardDecision'
	>;
}

describe('routeDashboardRunFrame', () => {
	it('routes a dashboard_decision frame to submitDashboardDecision', () => {
		const execution = makeExecution();
		const decision = {
			type: 'json',
			source: 'user',
			intent: {kind: 'permission_allow'},
		} as const;

		const handled = routeDashboardRunFrame(execution, {
			type: 'dashboard_decision',
			athenaSessionId: 'athena-1',
			requestId: 'req-1',
			decision,
		});

		expect(handled).toBe(true);
		expect(execution.submitDashboardDecision).toHaveBeenCalledWith({
			athenaSessionId: 'athena-1',
			requestId: 'req-1',
			decision,
		});
		expect(execution.cancelRun).not.toHaveBeenCalled();
	});

	it('routes a cancel frame to cancelRun by runId', () => {
		const execution = makeExecution();

		const handled = routeDashboardRunFrame(execution, {
			type: 'cancel',
			runId: 'run_cancel',
		});

		expect(handled).toBe(true);
		expect(execution.cancelRun).toHaveBeenCalledWith('run_cancel');
		expect(execution.submitDashboardDecision).not.toHaveBeenCalled();
	});

	it('returns false for frames it does not own', () => {
		const execution = makeExecution();

		const handled = routeDashboardRunFrame(execution, {
			type: 'pong',
			ts: 1,
		} as InstanceSocketFrame);

		expect(handled).toBe(false);
		expect(execution.cancelRun).not.toHaveBeenCalled();
		expect(execution.submitDashboardDecision).not.toHaveBeenCalled();
	});
});
