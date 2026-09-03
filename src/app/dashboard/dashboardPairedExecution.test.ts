import {describe, expect, it, vi} from 'vitest';
import {
	createDashboardPairedExecution,
	type DashboardPairedExecutionExecutor,
} from './dashboardPairedExecution';
import type {InstanceSocketClient} from './instanceSocketClient';
import {
	validateDashboardAssignment,
	type ExecuteRemoteAssignmentInput,
	type ValidatedAssignment,
} from './remoteRunExecutor';

function validated(frame: {
	type: 'run.start';
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
		sendNeedsHuman: () => {},
	} as Pick<
		InstanceSocketClient,
		'sendRunEvent' | 'sendDecisionAck' | 'sendNeedsHuman'
	>;
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
		// A bare publish-only FeedSink — no transport methods — must suffice:
		// paired execution forwards the capability to the executor and never
		// touches transport lifecycle (attach/detach/handleAck/close).
		const pairedFeedPublisher = {
			publish: vi.fn(),
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
			type: 'run.start',
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
			type: 'run.start',
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
				type: 'run.start',
				runId: 'run_a',
				runnerId: 'runner-1',
				runSpec: {prompt: 'a'},
			}),
		);
		execution.admitAssignment(
			validated({
				type: 'run.start',
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
				type: 'run.start',
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

	describe('answer arrives while parked (#190)', () => {
		const ALLOW = {
			type: 'json' as const,
			source: 'user' as const,
			intent: {kind: 'permission_allow' as const},
		};
		const PARKED_INTERRUPTION = {
			kind: 'question' as const,
			message:
				'permission request (Bash) unanswered within the grace window (60s); deferred: git push',
			requestId: 'req-1',
			question: 'Bash: git push',
		};

		function makeRecordingClient() {
			const needsHuman: unknown[] = [];
			const decisionAcks: unknown[] = [];
			const client = {
				sendRunEvent: () => {},
				sendDecisionAck: (frame: unknown) => decisionAcks.push(frame),
				sendNeedsHuman: (frame: unknown) => needsHuman.push(frame),
			} as Pick<
				InstanceSocketClient,
				'sendRunEvent' | 'sendDecisionAck' | 'sendNeedsHuman'
			>;
			return {client, needsHuman, decisionAcks};
		}

		/**
		 * An executor that parks on its first launch (reports `needs_human`
		 * with a deferred permission and returns) and, when woken, records the
		 * wake and stays active until aborted.
		 */
		function makeParkingExecutor() {
			const launches: Parameters<DashboardPairedExecutionExecutor>[0][] = [];
			const executor: DashboardPairedExecutionExecutor = async input => {
				launches.push(input);
				if (!input.wake) {
					input.client.sendNeedsHuman({
						runId: input.assignment.runId,
						athenaSessionId: 'athena-1',
						interruption: PARKED_INTERRUPTION,
					});
					return;
				}
				await new Promise<void>(resolve => {
					if (input.abortSignal?.aborted) return resolve();
					input.abortSignal?.addEventListener('abort', () => resolve(), {
						once: true,
					});
				});
			};
			return {executor, launches};
		}

		const settle = () => new Promise(resolve => setImmediate(resolve));

		it('records the Interruption a Run parked on and marks the record awaiting_attention', async () => {
			const {client, needsHuman} = makeRecordingClient();
			const {executor} = makeParkingExecutor();
			const execution = createDashboardPairedExecution({
				client,
				executor,
				projectDir: '/tmp/project',
				decisionInbox: makeDecisionInbox(),
				now: () => 100,
			});

			execution.admitAssignment(
				validated({type: 'run.start', runId: 'run_1', runSpec: {prompt: 'go'}}),
			);
			await settle();

			// The frame still reaches the hub through the real client...
			expect(needsHuman).toHaveLength(1);
			// ...and the Run's record shows it parked on that question.
			expect(execution.listRuns()).toEqual([
				expect.objectContaining({
					runId: 'run_1',
					status: 'awaiting_attention',
					athenaSessionId: 'athena-1',
					interruption: PARKED_INTERRUPTION,
				}),
			]);
			expect(execution.snapshot().activeRuns).toBe(0);
		});

		it('stores an answer against the parked Interruption and wakes the Run by re-launching the executor with the reply', async () => {
			const {client, decisionAcks} = makeRecordingClient();
			const {executor, launches} = makeParkingExecutor();
			const decisionInbox = makeDecisionInbox();
			const execution = createDashboardPairedExecution({
				client,
				executor,
				projectDir: '/tmp/project',
				decisionInbox,
				now: () => 100,
			});
			const assignment = validated({
				type: 'run.start',
				runId: 'run_1',
				runSpec: {prompt: 'go'},
			});
			execution.admitAssignment(assignment);
			await settle();

			execution.submitDashboardDecision({
				athenaSessionId: 'athena-1',
				requestId: 'req-1',
				decision: ALLOW,
			});
			await settle();

			// Stored durably (the inbox) and acked, as any answer is...
			expect(decisionInbox.enqueue).toHaveBeenCalledWith(
				expect.objectContaining({
					athenaSessionId: 'athena-1',
					requestId: 'req-1',
				}),
			);
			expect(decisionAcks).toEqual([
				{athenaSessionId: 'athena-1', requestId: 'req-1'},
			]);
			// ...and against the Interruption on the Run's record.
			const record = execution.listRuns()[0]!;
			expect(record.answer).toEqual({
				requestId: 'req-1',
				decision: ALLOW,
				receivedAt: 100,
			});
			// The Run was woken: the executor ran again for the same assignment
			// with a wake reply naming the answer, and is active once more.
			expect(launches).toHaveLength(2);
			expect(launches[1]!.assignment).toBe(assignment);
			expect(launches[1]!.wake?.reply).toContain('allow');
			expect(launches[1]!.wake?.reply).toContain('Bash: git push');
			expect(record.status).toBe('running');
			expect(execution.snapshot().activeRuns).toBe(1);

			await execution.stop();
		});

		it('an answer no parked Run is waiting on is stored and acked but wakes nothing', async () => {
			const {client, decisionAcks} = makeRecordingClient();
			const {executor, launches} = makeParkingExecutor();
			const execution = createDashboardPairedExecution({
				client,
				executor,
				projectDir: '/tmp/project',
				decisionInbox: makeDecisionInbox(),
				now: () => 100,
			});
			execution.admitAssignment(
				validated({type: 'run.start', runId: 'run_1', runSpec: {prompt: 'go'}}),
			);
			await settle();

			execution.submitDashboardDecision({
				athenaSessionId: 'athena-1',
				requestId: 'req-someone-else',
				decision: ALLOW,
			});
			await settle();

			expect(decisionAcks).toHaveLength(1);
			expect(launches).toHaveLength(1);
			expect(execution.listRuns()[0]!.status).toBe('awaiting_attention');
			expect(execution.listRuns()[0]!.answer).toBeUndefined();
		});
	});

	it('records a steer on the Run it addresses and logs it', async () => {
		const {client} = makeClient();
		const logs: string[] = [];
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
			log: (_level, message) => logs.push(message),
			now: () => 777,
		});

		execution.admitAssignment(
			validated({
				type: 'run.start',
				runId: 'run_steer',
				runnerId: 'runner-1',
				runSpec: {prompt: 'a'},
			}),
		);
		await Promise.resolve();

		expect(
			execution.steerRun({
				runId: 'run_steer',
				athenaSessionId: 'athena-1',
				text: 'use the other branch',
			}),
		).toBe(true);

		expect(execution.listRuns()).toEqual([
			expect.objectContaining({
				runId: 'run_steer',
				status: 'running',
				steers: [
					{
						athenaSessionId: 'athena-1',
						text: 'use the other branch',
						receivedAt: 777,
					},
				],
			}),
		]);
		expect(logs).toContainEqual(expect.stringContaining('steer'));
		expect(logs).toContainEqual(expect.stringContaining('run_steer'));
		resolveFirst();
		await execution.stop();
	});

	it('returns false for a steer addressed to a Run it has never seen', () => {
		const {client} = makeClient();
		const execution = createDashboardPairedExecution({
			client,
			executor: vi.fn(async () => {}) as DashboardPairedExecutionExecutor,
			projectDir: '/tmp/project',
			decisionInbox: makeDecisionInbox(),
		});

		expect(execution.steerRun({runId: 'missing', text: 'hello'})).toBe(false);
	});

	it('hands a steer for a running Run to its executor through the steer queue, tagged hub (#191)', async () => {
		const {client} = makeClient();
		const received: unknown[] = [];
		let resolveRun: () => void = () => {};
		const executor = vi.fn(async (input: ExecuteRemoteAssignmentInput) => {
			input.steerQueue?.subscribe(steer => received.push(steer));
			await new Promise<void>(resolve => {
				resolveRun = resolve;
			});
		}) as DashboardPairedExecutionExecutor;
		const execution = createDashboardPairedExecution({
			client,
			executor,
			projectDir: '/tmp/project',
			decisionInbox: makeDecisionInbox(),
			now: () => 777,
		});

		execution.admitAssignment(
			validated({type: 'run.start', runId: 'run_live', runSpec: {prompt: 'a'}}),
		);
		await Promise.resolve();
		execution.steerRun({runId: 'run_live', text: 'use the other branch'});
		execution.steerRun({runId: 'run_live', text: 'be brief'});

		expect(received).toEqual([
			{text: 'use the other branch', origin: 'hub', receivedAt: 777},
			{text: 'be brief', origin: 'hub', receivedAt: 777},
		]);
		expect(
			execution.listRuns()[0]!.steers!.map(s => s.pending ?? false),
		).toEqual([false, false]);
		resolveRun();
		await execution.stop();
	});

	it('holds a steer for a parked Run and delivers it when that Run is assigned again (#191)', async () => {
		const {client} = makeClient();
		const queues: unknown[][] = [];
		const executor = vi.fn(async (input: ExecuteRemoteAssignmentInput) => {
			const received: unknown[] = [];
			queues.push(received);
			input.steerQueue?.subscribe(steer => received.push(steer));
		}) as DashboardPairedExecutionExecutor;
		let clock = 100;
		const execution = createDashboardPairedExecution({
			client,
			executor,
			projectDir: '/tmp/project',
			decisionInbox: makeDecisionInbox(),
			now: () => clock,
		});

		const assignment = validated({
			type: 'run.start',
			runId: 'run_parked',
			runSpec: {prompt: 'a'},
		});
		execution.admitAssignment(assignment);
		await new Promise(resolve => setImmediate(resolve));
		expect(execution.listRuns()[0]!.status).toBe('completed');

		// The Run has parked (its executor returned); a steer now is stored.
		clock = 200;
		expect(execution.steerRun({runId: 'run_parked', text: 'wake up'})).toBe(
			true,
		);
		expect(execution.listRuns()[0]!.steers).toEqual([
			{text: 'wake up', receivedAt: 200, pending: true},
		]);

		// The hub continues the same Run: the held steer heads its queue.
		clock = 300;
		execution.admitAssignment(assignment);
		await new Promise(resolve => setImmediate(resolve));
		expect(queues[1]).toEqual([
			{text: 'wake up', origin: 'hub', receivedAt: 200},
		]);
		expect(execution.listRuns()[0]!.steers).toEqual([
			{text: 'wake up', receivedAt: 200, pending: false},
		]);
	});
});
