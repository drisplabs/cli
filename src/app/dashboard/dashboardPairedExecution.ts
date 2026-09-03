import type {AssignmentRejectedReason, SteerFrame} from '@drisp/protocol';
import type {
	InstanceSocketClient,
	InstanceSocketLogger,
} from './instanceSocketClient';
import type {DashboardDecisionInbox} from './dashboardDecisionInbox';
import type {
	ExecuteRemoteAssignmentInput,
	ValidatedAssignment,
} from './remoteRunExecutor';
import type {FeedSink} from './pairedFeedPublisher';
import type {RuntimeDecision} from '../../core/runtime/types';
import {createSteerQueue, type SteerQueue} from '../../core/workflows/steer';

/**
 * A dashboard decision in Run-domain terms, decoupled from the `answer`
 * socket frame. The frame router translates a canonical `answer` frame into
 * this shape before it crosses the execution boundary, so decision submission
 * can be exercised without socket frames.
 */
export type DashboardDecisionSubmission = {
	athenaSessionId: string;
	requestId: string;
	decision: RuntimeDecision;
};

/** A Steer (a human turn text for a Run) in Run-domain terms. */
export type DashboardSteerSubmission = Omit<SteerFrame, 'type'>;

/**
 * A Steer recorded on a Run (#191). A Steer for a running Run is handed to its
 * executor at once (the Runner queues it for the next Turn boundary); one for
 * a Run that is no longer running — parked, or otherwise ended — is held
 * `pending` and handed to the next assignment that continues the same Run.
 */
export type DashboardRunSteer = {
	athenaSessionId?: string;
	text: string;
	receivedAt: number;
	/** Held for the Run's continue; cleared once handed to an executor. */
	pending?: boolean;
};

export type DashboardAssignmentRejection = {
	reason: AssignmentRejectedReason;
	message: string;
};

export type DashboardAssignmentAdmission =
	| {kind: 'accepted'}
	| {kind: 'rejected'; rejection: DashboardAssignmentRejection};

export type DashboardPairedExecutionExecutor = (
	input: ExecuteRemoteAssignmentInput,
) => Promise<void>;

export type DashboardPairedExecutionRunRecord = {
	runId: string;
	startedAt: number;
	endedAt?: number;
	status: 'running' | 'completed' | 'failed' | 'cancelled' | 'rejected';
	error?: string;
	/** Every Steer the hub sent for this Run, in arrival order. */
	steers?: DashboardRunSteer[];
};

export type DashboardPairedExecutionOptions = {
	client: Pick<
		InstanceSocketClient,
		'sendRunEvent' | 'sendDecisionAck' | 'sendNeedsHuman'
	>;
	executor: DashboardPairedExecutionExecutor;
	projectDir: string;
	decisionInbox: DashboardDecisionInbox;
	log?: InstanceSocketLogger;
	maxConcurrentRuns?: number;
	now?: () => number;
	runHistoryLimit?: number;
	pairedFeedPublisher?: FeedSink;
};

export type DashboardPairedExecution = {
	admitAssignment(
		assignment: ValidatedAssignment,
		options?: {projectDir?: string},
	): DashboardAssignmentAdmission;
	cancelRun(runId: string): boolean;
	submitDashboardDecision(submission: DashboardDecisionSubmission): void;
	/**
	 * Record a Steer on the Run it addresses and hand it to the Run's executor
	 * (or hold it for the Run's continue when it is not running). Returns
	 * `false` when this execution has no record of the Run (never admitted
	 * here, or evicted from the history ring).
	 */
	steerRun(submission: DashboardSteerSubmission): boolean;
	rejectAssignment(
		runId: string,
		rejection: DashboardAssignmentRejection,
	): void;
	snapshot(): {activeRuns: number; completedRuns: number};
	listRuns(options?: {
		active?: boolean;
		limit?: number;
	}): DashboardPairedExecutionRunRecord[];
	stop(): Promise<void>;
};

const DEFAULT_MAX_CONCURRENT_RUNS = 1;
const DEFAULT_RUN_HISTORY_LIMIT = 100;

export function createDashboardPairedExecution(
	options: DashboardPairedExecutionOptions,
): DashboardPairedExecution {
	const client = options.client;
	const executor = options.executor;
	const projectDir = options.projectDir;
	const decisionInbox = options.decisionInbox;
	const log = options.log ?? (() => {});
	const maxConcurrentRuns =
		options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
	const runHistoryLimit = options.runHistoryLimit ?? DEFAULT_RUN_HISTORY_LIMIT;
	const pairedFeedPublisher = options.pairedFeedPublisher;
	const now = options.now ?? (() => Date.now());

	let completedRuns = 0;
	const active = new Map<
		string,
		{
			controller: AbortController;
			promise: Promise<void>;
			record: DashboardPairedExecutionRunRecord;
			runnerKey: string;
			steerQueue: SteerQueue;
		}
	>();
	const activeByRunner = new Map<string, Set<string>>();
	const runHistory: DashboardPairedExecutionRunRecord[] = [];

	function recordRun(record: DashboardPairedExecutionRunRecord): void {
		runHistory.push(record);
		while (runHistory.length > runHistoryLimit) {
			runHistory.shift();
		}
	}

	function rejectAssignment(
		runId: string,
		rejection: DashboardAssignmentRejection,
	): void {
		recordRun({
			runId,
			startedAt: now(),
			endedAt: now(),
			status: 'rejected',
			error: rejection.message,
		});
		log('warn', `run ${runId} rejected: ${rejection.message}`);
	}

	function submitDashboardDecision(
		submission: DashboardDecisionSubmission,
	): void {
		decisionInbox.enqueue({
			athenaSessionId: submission.athenaSessionId,
			requestId: submission.requestId,
			decision: submission.decision,
			receivedAt: now(),
		});
		client.sendDecisionAck({
			athenaSessionId: submission.athenaSessionId,
			requestId: submission.requestId,
		});
	}

	function cancelRun(runId: string): boolean {
		const entry = active.get(runId);
		if (!entry) return false;
		entry.record.status = 'cancelled';
		entry.controller.abort();
		return true;
	}

	function steerRun(submission: DashboardSteerSubmission): boolean {
		// A parked Run (awaiting a human) is no longer `active` — its executor
		// has returned — so look the record up in the history, not the active
		// map: a Steer is exactly what wakes such a Run.
		const record = [...runHistory]
			.reverse()
			.find(r => r.runId === submission.runId);
		if (!record) {
			log(
				'warn',
				`steer for unknown run ${submission.runId} ignored: ${submission.text}`,
			);
			return false;
		}
		// Running: the executor's queue carries it to the Runner, which delivers
		// it at the next Turn boundary. Otherwise it is held for the continue.
		const entry = active.get(submission.runId);
		const steer: DashboardRunSteer = {
			...(submission.athenaSessionId !== undefined
				? {athenaSessionId: submission.athenaSessionId}
				: {}),
			text: submission.text,
			receivedAt: now(),
			...(entry ? {} : {pending: true}),
		};
		record.steers = [...(record.steers ?? []), steer];
		entry?.steerQueue.push({
			text: steer.text,
			origin: 'hub',
			receivedAt: steer.receivedAt,
		});
		log(
			'info',
			`steer ${entry ? 'queued for the next Turn of' : 'held for the continue of'} run ${submission.runId} (${record.status}): ${submission.text}`,
		);
		return true;
	}

	/**
	 * Steers held while the Run was not running (#191), moved onto the queue
	 * of the assignment that now continues it, in arrival order.
	 */
	function takeHeldSteers(runId: string, steerQueue: SteerQueue): void {
		for (const prior of runHistory) {
			if (prior.runId !== runId) continue;
			for (const steer of prior.steers ?? []) {
				if (!steer.pending) continue;
				steer.pending = false;
				steerQueue.push({
					text: steer.text,
					origin: 'hub',
					receivedAt: steer.receivedAt,
				});
			}
		}
	}

	function handleAssignment(
		assignment: ValidatedAssignment,
		input: {projectDir?: string} = {},
	): DashboardAssignmentAdmission {
		const {runId, runnerId} = assignment;
		if (active.has(runId)) {
			const rejection = {
				reason: 'duplicate',
				message: `duplicate active assignment ${runId}`,
			} satisfies DashboardAssignmentRejection;
			rejectAssignment(runId, rejection);
			return {kind: 'rejected', rejection};
		}
		const bucket = activeByRunner.get(runnerId) ?? new Set<string>();
		if (bucket.size >= maxConcurrentRuns) {
			const rejection = {
				reason: 'local_capacity',
				message: `runtime daemon at concurrency cap (${maxConcurrentRuns}) for runner ${runnerId}`,
			} satisfies DashboardAssignmentRejection;
			rejectAssignment(runId, rejection);
			return {kind: 'rejected', rejection};
		}

		const controller = new AbortController();
		const steerQueue = createSteerQueue();
		takeHeldSteers(runId, steerQueue);
		const record: DashboardPairedExecutionRunRecord = {
			runId,
			startedAt: now(),
			status: 'running',
		};
		recordRun(record);
		bucket.add(runId);
		activeByRunner.set(runnerId, bucket);

		const promise = executor({
			assignment,
			client,
			projectDir: input.projectDir ?? projectDir,
			log,
			abortSignal: controller.signal,
			decisionInbox,
			steerQueue,
			...(pairedFeedPublisher
				? {dashboardFeedPublisher: pairedFeedPublisher}
				: {}),
		})
			.then(() => {
				if (record.status === 'running') record.status = 'completed';
			})
			.catch(err => {
				if (record.status === 'running') {
					record.status = 'failed';
				}
				record.error = err instanceof Error ? err.message : String(err);
				log(
					'error',
					`run ${runId} failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			})
			.finally(() => {
				record.endedAt = now();
				completedRuns += 1;
				active.delete(runId);
				const remaining = activeByRunner.get(runnerId);
				if (remaining) {
					remaining.delete(runId);
					if (remaining.size === 0) activeByRunner.delete(runnerId);
				}
			});
		active.set(runId, {
			controller,
			promise,
			record,
			runnerKey: runnerId,
			steerQueue,
		});
		return {kind: 'accepted'};
	}

	return {
		// `run.start` is intentionally not handled here: the runtime daemon
		// routes assignments through `DashboardAssignmentIntake`, which gates
		// admission on attachment readiness and then calls `admitAssignment`
		// directly. Run-control frames (`answer`, `stop`, `steer`) are
		// translated by `routeDashboardRunFrame` into `submitDashboardDecision`,
		// `cancelRun`, and `steerRun` calls.
		admitAssignment(assignment, input) {
			return handleAssignment(assignment, input);
		},
		cancelRun,
		submitDashboardDecision,
		steerRun,
		rejectAssignment,
		snapshot() {
			return {
				activeRuns: active.size,
				completedRuns,
			};
		},
		listRuns(opts = {}) {
			let out = runHistory.slice();
			if (typeof opts.limit === 'number' && opts.limit > 0) {
				out = out.slice(-opts.limit);
			}
			if (opts.active) {
				out = out.filter(r => r.status === 'running');
			}
			return out;
		},
		async stop() {
			for (const run of active.values()) {
				run.controller.abort();
			}
			await Promise.allSettled([...active.values()].map(run => run.promise));
		},
	};
}
