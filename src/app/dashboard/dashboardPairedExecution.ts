import type {
	AssignmentRejectedReason,
	Interruption,
	SteerFrame,
} from '@drisp/protocol';
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
import {describeAnswer} from '../exec/permissionHold';

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

/** An `answer` the hub sent for the request a parked Run is waiting on (#190). */
export type DashboardRunAnswer = {
	requestId: string;
	decision: RuntimeDecision;
	receivedAt: number;
};

export type DashboardPairedExecutionRunRecord = {
	runId: string;
	startedAt: number;
	endedAt?: number;
	/**
	 * `awaiting_attention` is the parked state (#190): the executor has
	 * returned, but the Run is waiting on a human and can be woken.
	 */
	status:
		| 'running'
		| 'awaiting_attention'
		| 'completed'
		| 'failed'
		| 'cancelled'
		| 'rejected';
	error?: string;
	/** The Athena Session the Run reported when it parked. */
	athenaSessionId?: string;
	/** Why the Run parked, as reported on its `needs_human` frame. */
	interruption?: Interruption;
	/** The answer stored against `interruption` while parked. */
	answer?: DashboardRunAnswer;
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
	// What a wake needs to re-launch a parked Run: the assignment it was
	// admitted with, and the workspace it ran in.
	const launched = new Map<
		string,
		{assignment: ValidatedAssignment; projectDir: string}
	>();

	// The executor reports a park through the client it is handed; observing
	// that frame here is what lets an `answer` find the Run it is for.
	const executionClient: typeof client = {
		sendRunEvent: event => client.sendRunEvent(event),
		sendDecisionAck: input => client.sendDecisionAck(input),
		sendNeedsHuman(input) {
			const record = [...runHistory]
				.reverse()
				.find(r => r.runId === input.runId);
			if (record) {
				record.status = 'awaiting_attention';
				record.interruption = input.interruption;
				if (input.athenaSessionId !== undefined) {
					record.athenaSessionId = input.athenaSessionId;
				}
				delete record.answer;
			}
			client.sendNeedsHuman(input);
		},
	};

	function recordRun(record: DashboardPairedExecutionRunRecord): void {
		runHistory.push(record);
		while (runHistory.length > runHistoryLimit) {
			runHistory.shift();
		}
	}

	/**
	 * The parked Run an answer is for: parked on a deferred permission whose
	 * request id and Athena Session match the answer's.
	 */
	function findParkedRunFor(
		submission: DashboardDecisionSubmission,
	): DashboardPairedExecutionRunRecord | undefined {
		return [...runHistory]
			.reverse()
			.find(
				r =>
					r.status === 'awaiting_attention' &&
					r.athenaSessionId === submission.athenaSessionId &&
					r.interruption?.kind === 'question' &&
					r.interruption.requestId === submission.requestId,
			);
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

		// Answer arrives while parked (#190): store it against the Interruption
		// and wake the Run. The re-launched run finds the answer in the inbox
		// and replays it into the re-issued call.
		const parked = findParkedRunFor(submission);
		if (!parked) return;
		const launch = launched.get(parked.runId);
		if (!launch) return;
		parked.answer = {
			requestId: submission.requestId,
			decision: submission.decision,
			receivedAt: now(),
		};
		const call =
			parked.interruption?.kind === 'question'
				? (parked.interruption.question ?? 'the deferred call')
				: 'the deferred call';
		const verdict = describeAnswer(submission.decision);
		log(
			'info',
			`answer (${verdict}) stored for run ${parked.runId} request ${submission.requestId}; waking it`,
		);
		const admission = launch_(launch.assignment, {
			projectDir: launch.projectDir,
			wake: {
				reply: `Your deferred ${call} (request ${submission.requestId}) was answered: ${verdict}. Re-issue that call now and continue.`,
			},
		});
		if (admission.kind === 'rejected') {
			log(
				'warn',
				`run ${parked.runId} could not be woken: ${admission.rejection.message}`,
			);
		}
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
	 * of the assignment that now continues it, in arrival order. A wake
	 * (#190) launches the same assignment under the same runId, so a Steer
	 * held against a parked Run rides its continue.
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

	/**
	 * Launch the executor for an assignment: a fresh Run, or — with `wake` —
	 * the continuation of a parked one, which reuses its record.
	 */
	function launch_(
		assignment: ValidatedAssignment,
		input: {projectDir?: string; wake?: {reply: string}} = {},
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
		const resumed = input.wake
			? [...runHistory].reverse().find(r => r.runId === runId)
			: undefined;
		const record: DashboardPairedExecutionRunRecord = resumed ?? {
			runId,
			startedAt: now(),
			status: 'running',
		};
		if (resumed) {
			resumed.status = 'running';
			delete resumed.endedAt;
			delete resumed.error;
		} else {
			recordRun(record);
		}
		const runProjectDir = input.projectDir ?? projectDir;
		launched.set(runId, {assignment, projectDir: runProjectDir});
		bucket.add(runId);
		activeByRunner.set(runnerId, bucket);

		const promise = executor({
			assignment,
			client: executionClient,
			projectDir: runProjectDir,
			log,
			abortSignal: controller.signal,
			decisionInbox,
			steerQueue,
			...(pairedFeedPublisher
				? {dashboardFeedPublisher: pairedFeedPublisher}
				: {}),
			...(input.wake ? {wake: input.wake} : {}),
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
			return launch_(assignment, input);
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
