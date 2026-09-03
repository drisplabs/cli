import type {CanonicalFrame} from '@drisp/protocol';
import type {DashboardPairedExecution} from './dashboardPairedExecution';

/**
 * Thin socket-frame adapter for Dashboard-paired execution. It owns only the
 * translation from a canonical instance-socket frame (already normalised by
 * `@drisp/protocol`, so `dashboard_decision` / `cancel` arrive here as
 * `answer` / `stop`) into a Run-oriented call on
 * {@link DashboardPairedExecution}; it holds no Run lifecycle rules of its own.
 *
 * `run.start` frames are intentionally NOT routed here: the runtime daemon
 * gates them on attachment readiness through `DashboardAssignmentIntake`, which
 * then calls `admitAssignment`. This router owns the frames that flow straight
 * through to an existing Run.
 *
 * Returns `true` when the frame was a Run-control frame this adapter handled.
 */
export function routeDashboardRunFrame(
	execution: Pick<
		DashboardPairedExecution,
		'cancelRun' | 'submitDashboardDecision' | 'steerRun'
	>,
	frame: CanonicalFrame,
): boolean {
	if (frame.type === 'answer') {
		execution.submitDashboardDecision({
			athenaSessionId: frame.athenaSessionId,
			requestId: frame.requestId,
			decision: frame.decision,
		});
		return true;
	}
	if (frame.type === 'stop') {
		execution.cancelRun(frame.runId);
		return true;
	}
	if (frame.type === 'steer') {
		execution.steerRun({
			runId: frame.runId,
			text: frame.text,
			...(frame.athenaSessionId !== undefined
				? {athenaSessionId: frame.athenaSessionId}
				: {}),
		});
		return true;
	}
	return false;
}
