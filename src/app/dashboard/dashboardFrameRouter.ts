import type {InstanceSocketFrame} from './instanceSocketClient';
import type {DashboardPairedExecution} from './dashboardPairedExecution';

/**
 * Thin socket-frame adapter for Dashboard-paired execution. It owns only the
 * translation from a raw socket frame into a Run-oriented call on
 * {@link DashboardPairedExecution}; it holds no Run lifecycle rules of its own.
 *
 * `job_assignment` frames are intentionally NOT routed here: the runtime daemon
 * gates them on attachment readiness through `DashboardAssignmentIntake`, which
 * then calls `admitAssignment`. This router owns the frames that flow straight
 * through to an existing Run.
 *
 * Returns `true` when the frame was a Run-control frame this adapter handled.
 */
export function routeDashboardRunFrame(
	execution: Pick<
		DashboardPairedExecution,
		'cancelRun' | 'submitDashboardDecision'
	>,
	frame: InstanceSocketFrame,
): boolean {
	if (frame.type === 'dashboard_decision') {
		execution.submitDashboardDecision({
			athenaSessionId: frame.athenaSessionId,
			requestId: frame.requestId,
			decision: frame.decision,
		});
		return true;
	}
	if (frame.type === 'cancel') {
		execution.cancelRun(frame.runId);
		return true;
	}
	return false;
}
