import {describe, expect, it, vi} from 'vitest';
import {
	createDashboardPairedExecution,
	type DashboardPairedExecutionExecutor,
} from './dashboardPairedExecution';
import type {InstanceSocketClient} from './instanceSocketClient';
import {
	validateDashboardAssignment,
	type ValidatedAssignment,
} from './remoteRunExecutor';

function validated(frame: {
	type: 'job_assignment';
	runId: string;
	runnerId?: string;
	runSpec?: unknown;
}): ValidatedAssignment {
	const result = validateDashboardAssignment(frame);
	if (result.kind !== 'valid') {
		throw new Error(`test frame should be valid: ${result.rejection.message}`);
	}
	return result.assignment;
}

function makeClient() {
	const runEvents: unknown[] = [];
	const decisionAcks: unknown[] = [];
	const client = {
		sendRunEvent: frame => runEvents.push(frame),
		sendDecisionAck: frame => decisionAcks.push(frame),
	} as Pick<InstanceSocketClient, 'sendRunEvent' | 'sendDecisionAck'>;
	return {client, runEvents, decisionAcks};
}

function makeDecisionInbox() {
	return {
		enqueue: vi.fn(),
		pendingForSession: vi.fn(() => []),
		markConsumed: vi.fn(),
		close: vi.fn(),
	};
}

describe('DashboardPairedExecution', () => {
	it('accepts an assignment and forwards env plus the decision inbox to the executor', async () => {
		const {client} = makeClient();
		const decisionInbox = makeDecisionInbox();
		const pairedFeedPublisher = {
			publish: vi.fn(),
			attachTransport: vi.fn(),
			detachTransport: vi.fn(),
			handleAck: vi.fn(),
			close: vi.fn(),
		};
		const executor = vi.fn(async () => {}) as DashboardPairedExecutionExecutor;
		const execution = createDashboardPairedExecution({
			client,
			executor,
			projectDir: '/tmp/project',
			decisionInbox,
			pairedFeedPublisher,
			now: () => 100,
		});

		const assignment = validated({
			type: 'job_assignment',
			runId: 'run_1',
			runSpec: {prompt: 'hi', env: {FOO: 'bar'}},
		});
		expect(execution.admitAssignment(assignment)).toEqual({kind: 'accepted'});
		await Promise.resolve();

		expect(executor).toHaveBeenCalledWith(
			expect.objectContaining({
				assignment,
				projectDir: '/tmp/project',
				decisionInbox,
				dashboardFeedPublisher: pairedFeedPublisher,
			}),
		);
		expect(execution.listRuns()).toEqual([
			expect.objectContaining({runId: 'run_1', status: 'completed'}),
		]);
	});

	it('rejects a duplicate active assignment', async () => {
		const {client, runEvents} = makeClient();
		let resolveFirst: () => void = () => {};
		const executor = vi.fn(
			async () =>
				new Promise<void>(resolve => {
					resolveFirst = resolve;
				}),
		) as DashboardPairedExecutionExecutor;
		const execution = createDashboardPairedExecution({
			client,
			executor,
			projectDir: '/tmp/project',
			decisionInbox: makeDecisionInbox(),
			now: () => 100,
		});

		const assignment = validated({
			type: 'job_assignment',
			runId: 'run_dup',
			runSpec: {prompt: 'hi'},
		});
		execution.admitAssignment(assignment);
		execution.admitAssignment(assignment);
		await Promise.resolve();

		expect(executor).toHaveBeenCalledTimes(1);
		expect(runEvents).toEqual([]);
		expect(execution.listRuns({active: false})).toContainEqual(
			expect.objectContaining({
				runId: 'run_dup',
				status: 'rejected',
				error: expect.stringContaining('duplicate'),
			}),
		);
		resolveFirst();
		await execution.stop();
	});

	it('rejects assignments when the runner capacity is full', async () => {
		const {client, runEvents} = makeClient();
		let resolveFirst: () => void = () => {};
		const executor = vi.fn(
			async () =>
				new Promise<void>(resolve => {
					resolveFirst = resolve;
				}),
		) as DashboardPairedExecutionExecutor;
		const execution = createDashboardPairedExecution({
			client,
			executor,
			projectDir: '/tmp/project',
			decisionInbox: makeDecisionInbox(),
			maxConcurrentRuns: 1,
			now: () => 100,
		});

		execution.admitAssignment(
			validated({
				type: 'job_assignment',
				runId: 'run_a',
				runnerId: 'runner-1',
				runSpec: {prompt: 'a'},
			}),
		);
		execution.admitAssignment(
			validated({
				type: 'job_assignment',
				runId: 'run_b',
				runnerId: 'runner-1',
				runSpec: {prompt: 'b'},
			}),
		);
		await Promise.resolve();

		expect(executor).toHaveBeenCalledTimes(1);
		expect(runEvents).toEqual([]);
		expect(execution.listRuns({active: false})).toContainEqual(
			expect.objectContaining({
				runId: 'run_b',
				status: 'rejected',
				error: expect.stringContaining('concurrency cap'),
			}),
		);
		resolveFirst();
		await execution.stop();
	});

	it('cancels an active run by runId through the Run-oriented interface', async () => {
		const {client} = makeClient();
		let seenSignal: AbortSignal | undefined;
		let resolveFirst: () => void = () => {};
		const executor = vi.fn(
			async input =>
				new Promise<void>(resolve => {
					seenSignal = input.abortSignal;
					resolveFirst = resolve;
				}),
		) as DashboardPairedExecutionExecutor;
		const execution = createDashboardPairedExecution({
			client,
			executor,
			projectDir: '/tmp/project',
			decisionInbox: makeDecisionInbox(),
		});

		execution.admitAssignment(
			validated({
				type: 'job_assignment',
				runId: 'run_cancel',
				runnerId: 'runner-1',
				runSpec: {prompt: 'a'},
			}),
		);
		await Promise.resolve();
		expect(execution.cancelRun('run_cancel')).toBe(true);

		expect(seenSignal?.aborted).toBe(true);
		expect(execution.listRuns()).toEqual([
			expect.objectContaining({runId: 'run_cancel', status: 'cancelled'}),
		]);
		resolveFirst();
		await execution.stop();
	});

	it('returns false when cancelling an unknown run', () => {
		const {client} = makeClient();
		const execution = createDashboardPairedExecution({
			client,
			executor: vi.fn(async () => {}) as DashboardPairedExecutionExecutor,
			projectDir: '/tmp/project',
			decisionInbox: makeDecisionInbox(),
		});

		expect(execution.cancelRun('missing')).toBe(false);
	});

	it('submits dashboard decisions to the inbox and acks the dashboard', () => {
		const {client, decisionAcks} = makeClient();
		const decisionInbox = makeDecisionInbox();
		const execution = createDashboardPairedExecution({
			client,
			executor: vi.fn(async () => {}) as DashboardPairedExecutionExecutor,
			projectDir: '/tmp/project',
			decisionInbox,
			now: () => 555,
		});

		execution.submitDashboardDecision({
			athenaSessionId: 'athena-1',
			requestId: 'req-1',
			decision: {
				type: 'json',
				source: 'user',
				intent: {kind: 'permission_allow'},
			},
		});

		expect(decisionInbox.enqueue).toHaveBeenCalledWith({
			athenaSessionId: 'athena-1',
			requestId: 'req-1',
			decision: {
				type: 'json',
				source: 'user',
				intent: {kind: 'permission_allow'},
			},
			receivedAt: 555,
		});
		expect(decisionAcks).toEqual([
			{athenaSessionId: 'athena-1', requestId: 'req-1'},
		]);
	});
});
