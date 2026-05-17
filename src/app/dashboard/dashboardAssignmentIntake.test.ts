import {describe, expect, it, vi} from 'vitest';
import {createDashboardAssignmentIntake} from './dashboardAssignmentIntake';

describe('DashboardAssignmentIntake', () => {
	it('buffers assignments until admission is allowed, then truthfully accepts them', () => {
		const sendAssignmentAccepted = vi.fn();
		const sendAssignmentRejected = vi.fn();
		const admitAssignment = vi.fn(() => ({kind: 'accepted' as const}));
		const rejectAssignment = vi.fn();
		const intake = createDashboardAssignmentIntake({
			client: {sendAssignmentAccepted, sendAssignmentRejected},
			execution: {admitAssignment, rejectAssignment},
			resolveWorkspace: () => ({kind: 'resolved', projectDir: '/tmp/project'}),
		});

		const frame = {
			type: 'job_assignment' as const,
			runId: 'run_1',
			runSpec: {prompt: 'hi'},
		};
		intake.receive(frame);
		expect(admitAssignment).not.toHaveBeenCalled();
		expect(sendAssignmentAccepted).not.toHaveBeenCalled();

		intake.markReady();
		expect(admitAssignment).toHaveBeenCalledWith(frame, {
			projectDir: '/tmp/project',
		});
		expect(sendAssignmentAccepted).toHaveBeenCalledWith('run_1');
		expect(sendAssignmentRejected).not.toHaveBeenCalled();
	});

	it('rejects malformed assignments with a first-class rejection frame', () => {
		const sendAssignmentAccepted = vi.fn();
		const sendAssignmentRejected = vi.fn();
		const admitAssignment = vi.fn(() => ({kind: 'accepted' as const}));
		const rejectAssignment = vi.fn();
		const intake = createDashboardAssignmentIntake({
			client: {sendAssignmentAccepted, sendAssignmentRejected},
			execution: {admitAssignment, rejectAssignment},
			resolveWorkspace: () => ({kind: 'resolved', projectDir: '/tmp/project'}),
		});
		intake.markReady();
		intake.receive({
			type: 'job_assignment',
			runId: 'run_bad',
			runSpec: {},
		});

		expect(admitAssignment).not.toHaveBeenCalled();
		expect(sendAssignmentAccepted).not.toHaveBeenCalled();
		expect(rejectAssignment).toHaveBeenCalledWith('run_bad', {
			reason: 'malformed_assignment',
			message: 'remote assignment missing prompt',
		});
		expect(sendAssignmentRejected).toHaveBeenCalledWith({
			runId: 'run_bad',
			reason: 'malformed_assignment',
			message: 'remote assignment missing prompt',
		});
	});

	it('sends local admission rejections without sending assignment_accepted', () => {
		const sendAssignmentAccepted = vi.fn();
		const sendAssignmentRejected = vi.fn();
		const admitAssignment = vi.fn(() => ({
			kind: 'rejected' as const,
			rejection: {
				reason: 'local_capacity' as const,
				message: 'runtime daemon at concurrency cap',
			},
		}));
		const intake = createDashboardAssignmentIntake({
			client: {sendAssignmentAccepted, sendAssignmentRejected},
			execution: {admitAssignment, rejectAssignment: vi.fn()},
			resolveWorkspace: () => ({kind: 'resolved', projectDir: '/tmp/project'}),
		});
		intake.markReady();
		intake.receive({
			type: 'job_assignment',
			runId: 'run_full',
			runSpec: {prompt: 'go'},
		});

		expect(sendAssignmentAccepted).not.toHaveBeenCalled();
		expect(sendAssignmentRejected).toHaveBeenCalledWith({
			runId: 'run_full',
			reason: 'local_capacity',
			message: 'runtime daemon at concurrency cap',
		});
	});

	it('rejects assignments when workspace resolution fails', () => {
		const sendAssignmentAccepted = vi.fn();
		const sendAssignmentRejected = vi.fn();
		const admitAssignment = vi.fn(() => ({kind: 'accepted' as const}));
		const rejectAssignment = vi.fn();
		const intake = createDashboardAssignmentIntake({
			client: {sendAssignmentAccepted, sendAssignmentRejected},
			execution: {admitAssignment, rejectAssignment},
			resolveWorkspace: () => ({
				kind: 'rejected',
				rejection: {
					reason: 'workspace_invalid',
					message: 'remote workspace cannot be the user home directory',
				},
			}),
		});
		intake.markReady();
		intake.receive({
			type: 'job_assignment',
			runId: 'run_home',
			runSpec: {prompt: 'go'},
		});

		expect(admitAssignment).not.toHaveBeenCalled();
		expect(sendAssignmentAccepted).not.toHaveBeenCalled();
		expect(rejectAssignment).toHaveBeenCalledWith('run_home', {
			reason: 'workspace_invalid',
			message: 'remote workspace cannot be the user home directory',
		});
		expect(sendAssignmentRejected).toHaveBeenCalledWith({
			runId: 'run_home',
			reason: 'workspace_invalid',
			message: 'remote workspace cannot be the user home directory',
		});
	});
});
