import type {
	InstanceSocketClient,
	InstanceSocketFrame,
	InstanceSocketLogger,
} from './instanceSocketClient';
import type {DashboardPairedExecution} from './dashboardPairedExecution';
import {
	validateDashboardAssignment,
	type ValidatedAssignment,
} from './remoteRunExecutor';
import {
	resolveRemoteWorkspace,
	type RemoteWorkspaceResolution,
} from './remoteWorkspaceResolver';

type JobAssignmentFrame = Extract<
	InstanceSocketFrame,
	{type: 'job_assignment'}
>;

export type DashboardAssignmentIntakeOptions = {
	client: Pick<
		InstanceSocketClient,
		'sendAssignmentAccepted' | 'sendAssignmentRejected'
	>;
	execution: Pick<
		DashboardPairedExecution,
		'admitAssignment' | 'rejectAssignment'
	>;
	log?: InstanceSocketLogger;
	resolveWorkspace?: (
		assignment: ValidatedAssignment,
		context: DashboardConnectionContext,
	) => RemoteWorkspaceResolution;
};

export type DashboardConnectionContext = {
	dashboardUrl: string;
	instanceId: string;
};

export type DashboardAssignmentIntake = {
	receive(frame: JobAssignmentFrame): void;
	markReady(context: DashboardConnectionContext): void;
	markNotReady(): void;
};

export function createDashboardAssignmentIntake(
	options: DashboardAssignmentIntakeOptions,
): DashboardAssignmentIntake {
	const log = options.log ?? (() => {});
	const resolveWorkspace =
		options.resolveWorkspace ??
		((assignment, context) =>
			resolveRemoteWorkspace(assignment, {dashboardUrl: context.dashboardUrl}));
	const pending: JobAssignmentFrame[] = [];
	let context: DashboardConnectionContext | null = null;

	function handle(
		frame: JobAssignmentFrame,
		readyContext: DashboardConnectionContext,
	): void {
		const validation = validateDashboardAssignment(frame);
		if (validation.kind === 'rejected') {
			options.execution.rejectAssignment(frame.runId, validation.rejection);
			options.client.sendAssignmentRejected({
				runId: frame.runId,
				...validation.rejection,
			});
			return;
		}
		const assignment = validation.assignment;
		const workspace = resolveWorkspace(assignment, readyContext);
		if (workspace.kind === 'rejected') {
			options.execution.rejectAssignment(frame.runId, workspace.rejection);
			options.client.sendAssignmentRejected({
				runId: frame.runId,
				...workspace.rejection,
			});
			return;
		}
		const outcome = options.execution.admitAssignment(assignment, {
			projectDir: workspace.projectDir,
		});
		if (outcome.kind === 'accepted') {
			options.client.sendAssignmentAccepted(frame.runId);
			return;
		}
		options.client.sendAssignmentRejected({
			runId: frame.runId,
			...outcome.rejection,
		});
	}

	function drain(): void {
		if (!context) return;
		while (pending.length > 0) {
			const frame = pending.shift();
			if (frame) handle(frame, context);
		}
	}

	return {
		receive(frame) {
			if (!context) {
				pending.push(frame);
				log(
					'debug',
					`dashboard assignment buffered until attachments are current: runId=${frame.runId}`,
				);
				return;
			}
			handle(frame, context);
		},
		markReady(nextContext) {
			context = nextContext;
			drain();
		},
		markNotReady() {
			context = null;
		},
	};
}
