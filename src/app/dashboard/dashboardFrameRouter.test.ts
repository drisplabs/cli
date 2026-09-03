import {describe, expect, it, vi} from 'vitest';
import {routeDashboardRunFrame} from './dashboardFrameRouter';
import type {DashboardPairedExecution} from './dashboardPairedExecution';
import type {CanonicalFrame} from '@drisp/protocol';

function makeExecution() {
	return {
		cancelRun: vi.fn(() => true),
		submitDashboardDecision: vi.fn(),
		steerRun: vi.fn(() => true),
	} satisfies Pick<
		DashboardPairedExecution,
		'cancelRun' | 'submitDashboardDecision' | 'steerRun'
	>;
}

describe('routeDashboardRunFrame', () => {
	it('routes an answer frame (the canonical dashboard_decision) to submitDashboardDecision', () => {
		const execution = makeExecution();
		const decision = {
			type: 'json',
			source: 'user',
			intent: {kind: 'permission_allow'},
		} as const;

		const handled = routeDashboardRunFrame(execution, {
			type: 'answer',
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

	it('routes a stop frame (the canonical cancel) to cancelRun by runId', () => {
		const execution = makeExecution();

		const handled = routeDashboardRunFrame(execution, {
			type: 'stop',
			runId: 'run_cancel',
		});

		expect(handled).toBe(true);
		expect(execution.cancelRun).toHaveBeenCalledWith('run_cancel');
		expect(execution.submitDashboardDecision).not.toHaveBeenCalled();
		expect(execution.steerRun).not.toHaveBeenCalled();
	});

	it('routes a steer frame to steerRun with the human turn text', () => {
		const execution = makeExecution();

		const handled = routeDashboardRunFrame(execution, {
			type: 'steer',
			runId: 'run_steer',
			athenaSessionId: 'athena-1',
			text: 'use the other branch',
		});

		expect(handled).toBe(true);
		expect(execution.steerRun).toHaveBeenCalledWith({
			runId: 'run_steer',
			athenaSessionId: 'athena-1',
			text: 'use the other branch',
		});
		expect(execution.cancelRun).not.toHaveBeenCalled();
		expect(execution.submitDashboardDecision).not.toHaveBeenCalled();
	});

	it('returns false for frames it does not own', () => {
		const execution = makeExecution();

		const handled = routeDashboardRunFrame(execution, {
			type: 'pong',
			ts: 1,
		} as CanonicalFrame);

		expect(handled).toBe(false);
		expect(execution.cancelRun).not.toHaveBeenCalled();
		expect(execution.submitDashboardDecision).not.toHaveBeenCalled();
	});
});
