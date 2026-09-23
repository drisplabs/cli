import {
	createInstanceSocketClient,
	type InstanceSocketClient,
	type InstanceSocketLogger,
	type InstanceSocketWireMode,
} from './instanceSocketClient';
import {
	executeRemoteAssignment,
	type ExecuteRemoteAssignmentInput,
} from './remoteRunExecutor';
import {
	refreshDashboardAccessToken,
	type DashboardAccessToken,
} from '../../infra/config/dashboardAuth';
import {
	type DashboardClientConfig,
	readDashboardClientConfig,
} from '../../infra/config/dashboardClient';
import {
	type AttachmentMirror,
	writeAttachmentMirror,
} from '../../infra/config/attachmentMirror';
import {
	createAttachmentReconciler,
	type AttachmentReconcilerFetchInput,
} from './attachmentReconciler';
import {
	createPairedFeedPublisher,
	type PairedFeedPublisher,
} from './pairedFeedPublisher';
import {
	createDashboardDecisionInbox,
	type DashboardDecisionInbox,
} from './dashboardDecisionInbox';
import {
	createDashboardPairedExecution,
	type DashboardPairedExecutionRunRecord,
} from './dashboardPairedExecution';
import {createDashboardAssignmentIntake} from './dashboardAssignmentIntake';
import {routeDashboardRunFrame} from './dashboardFrameRouter';
import {resolveRemoteWorkspace} from './remoteWorkspaceResolver';
import type {InstalledWorkflow} from '@drisp/protocol';
import {
	listInstalledWorkflows,
	watchInstalledWorkflows,
	type InstalledWorkflowInventoryOptions,
} from '../../core/workflows/inventory';

type RuntimeDaemonAssignmentExecutor = (
	input: ExecuteRemoteAssignmentInput,
) => Promise<void>;

export type RuntimeDaemonRunRecord = DashboardPairedExecutionRunRecord;

export type RuntimeDaemonSnapshot = {
	startedAt: number;
	socketConnected: boolean;
	/**
	 * Which frame-name set the current connection puts on the wire: `legacy`
	 * until the hub's `hello` announces the protocol version this runner
	 * speaks, then `canonical`. Absent while disconnected.
	 */
	wireMode?: InstanceSocketWireMode;
	lastFrameAt?: number;
	activeRuns: number;
	completedRuns: number;
	instanceId?: string;
	dashboardUrl?: string;
	/**
	 * Token-refresh health. `cooldownUntilMs` is set when the circuit breaker
	 * trips (refresh failures saturate the window). Surfaces in `dashboard
	 * status` so the user understands why the socket is offline.
	 */
	refreshState?: {
		recentFailures: number;
		cooldownUntilMs?: number;
		/**
		 * The last cooldown probe couldn't reach the hub. The cooldown ends as
		 * soon as a probe gets through, rather than at `cooldownUntilMs`.
		 */
		hubUnreachable?: boolean;
	};
};

export type RuntimeDaemonHandle = {
	snapshot(): RuntimeDaemonSnapshot;
	listRuns(options?: {
		active?: boolean;
		limit?: number;
	}): RuntimeDaemonRunRecord[];
	stop(reason?: string): Promise<void>;
};

export type RunDashboardRuntimeDaemonOptions = {
	readConfig?: () => DashboardClientConfig | null;
	refreshAccessToken?: () => Promise<DashboardAccessToken>;
	makeInstanceSocketClient?: (opts: {
		dashboardUrl: string;
		instanceId: string;
		accessToken: string;
		log: InstanceSocketLogger;
		/** The current Workflow inventory, read at connect time for the hello. */
		installedWorkflows: () => InstalledWorkflow[];
	}) => InstanceSocketClient;
	executeRemoteAssignment?: RuntimeDaemonAssignmentExecutor;
	projectDir?: string;
	log?: InstanceSocketLogger;
	reconnectDelaysMs?: number[];
	/**
	 * Cap on parallel exec sessions. The dashboard already queues offline
	 * assignments; the cap protects against the local box being overwhelmed
	 * when a runner has high parallelism configured. Default 1.
	 */
	maxConcurrentRuns?: number;
	/**
	 * Lead time before access-token expiry to schedule a proactive refresh,
	 * in seconds. A fresh token replaces the cached value so the next
	 * reconnect doesn't race the expiry. Default 60s.
	 */
	refreshLeadSec?: number;
	/**
	 * Refresh circuit-breaker. After `refreshFailureLimit` failures within
	 * `refreshFailureWindowMs`, the daemon sleeps `refreshCooldownMs` before
	 * retrying. Refresh tokens are single-use; a tight retry loop will burn
	 * the rotation history and force the user to re-pair. Defaults: 5
	 * failures within 5 minutes triggers a 5-minute cooldown.
	 */
	refreshFailureLimit?: number;
	refreshFailureWindowMs?: number;
	refreshCooldownMs?: number;
	/**
	 * While the breaker is cooling down, the daemon probes the hub on these
	 * delays (the last one repeats) and ends the cooldown early once the hub
	 * answers again, so a short outage doesn't cost the full cooldown. A probe
	 * spends no refresh token. Empty disables probing. Default 2s, 5s, 10s,
	 * then every 15s.
	 */
	cooldownProbeDelaysMs?: number[];
	/**
	 * Resolves true when the hub answers with a non-5xx status, false when it
	 * can't be reached. Production POSTs a token-less body to the refresh
	 * endpoint. `signal` aborts when the daemon stops.
	 */
	probeHub?: (dashboardUrl: string, signal: AbortSignal) => Promise<boolean>;
	now?: () => number;
	/**
	 * Cap on the `runs` ring buffer. Default 100.
	 */
	runHistoryLimit?: number;
	/**
	 * Test seam. Production uses `writeAttachmentMirror`. Called whenever the
	 * dashboard pushes `attachments.changed` so the local mirror stays in
	 * sync without requiring a re-pair.
	 */
	writeMirror?: (mirror: AttachmentMirror) => void;
	fetchAttachments?: (
		input: AttachmentReconcilerFetchInput,
	) => Promise<AttachmentMirror['attachments']>;
	/**
	 * Durable queue of local feed events waiting for dashboard ACK. Production
	 * uses the dashboard state dir; tests inject a temp database.
	 */
	pairedFeedPublisher?: PairedFeedPublisher;
	/** Poll interval for queued feed events. Default 1000ms. */
	feedDrainIntervalMs?: number;
	/** Durable local inbox for dashboard permission/question decisions. */
	decisionInbox?: DashboardDecisionInbox;
	/**
	 * Keep the long-running daemon alive when the first dashboard socket
	 * connection fails, so transient server/network failures recover through
	 * the normal reconnect loop. Foreground debugging can set false to fail
	 * fast and report the startup error directly.
	 */
	retryInitialConnect?: boolean;
	/**
	 * The Workflow store the runner reports to the hub (`hello.workflows`,
	 * `workflows.changed`). Production uses the registry dir under the user's
	 * home; tests and the live-transport harness point it at a temp dir.
	 */
	workflowStoreDir?: string;
	/** The CLI's own version, reported as the built-in Workflows' version. */
	cliVersion?: string;
};

const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const DEFAULT_MAX_CONCURRENT_RUNS = 1;
const DEFAULT_REFRESH_LEAD_SEC = 60;
const DEFAULT_REFRESH_FAILURE_LIMIT = 5;
const DEFAULT_REFRESH_FAILURE_WINDOW_MS = 5 * 60_000;
const DEFAULT_REFRESH_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_COOLDOWN_PROBE_DELAYS_MS = [2_000, 5_000, 10_000, 15_000];
const HUB_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_RUN_HISTORY_LIMIT = 100;

function delay(ms: number): Promise<void> {
	return new Promise(resolve => {
		const timer = setTimeout(resolve, ms);
		timer.unref();
	});
}

// The probe is a POST with an empty body: it carries no refresh token, so it
// can't burn the rotation history, yet it travels the same path as a real
// refresh. On the hosted hub the edge worker answers a HEAD (405) by itself
// even while the backend that serves refreshes is down, so a HEAD would report
// "up" throughout that outage. The backend rejects a token-less body with a
// 400 before any token work. Any non-5xx answer proves the refresh path is
// serving again; a network failure or a 5xx (a proxy or edge in front of a
// dead backend) means it is still down.
async function probeHubReachable(
	dashboardUrl: string,
	signal: AbortSignal,
): Promise<boolean> {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal.addEventListener('abort', onAbort, {once: true});
	const timer = setTimeout(onAbort, HUB_PROBE_TIMEOUT_MS);
	timer.unref();
	try {
		const response = await fetch(`${dashboardUrl}/api/instances/refresh`, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: '{}',
			redirect: 'manual',
			signal: controller.signal,
		});
		return response.status < 500;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener('abort', onAbort);
	}
}

export async function runDashboardRuntimeDaemon(
	options: RunDashboardRuntimeDaemonOptions = {},
): Promise<RuntimeDaemonHandle> {
	const readConfig = options.readConfig ?? (() => readDashboardClientConfig());
	const refreshAccessTokenFn =
		options.refreshAccessToken ?? (async () => refreshDashboardAccessToken({}));
	const makeClient =
		options.makeInstanceSocketClient ??
		(opts =>
			createInstanceSocketClient({
				dashboardUrl: opts.dashboardUrl,
				instanceId: opts.instanceId,
				accessToken: opts.accessToken,
				log: opts.log,
				installedWorkflows: opts.installedWorkflows,
			}));
	const executor = options.executeRemoteAssignment ?? executeRemoteAssignment;
	const projectDir = options.projectDir ?? process.cwd();
	const log = options.log ?? (() => {});
	const reconnectDelays =
		options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
	const maxConcurrentRuns =
		options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
	const refreshLeadSec = options.refreshLeadSec ?? DEFAULT_REFRESH_LEAD_SEC;
	const refreshFailureLimit =
		options.refreshFailureLimit ?? DEFAULT_REFRESH_FAILURE_LIMIT;
	const refreshFailureWindowMs =
		options.refreshFailureWindowMs ?? DEFAULT_REFRESH_FAILURE_WINDOW_MS;
	const refreshCooldownMs =
		options.refreshCooldownMs ?? DEFAULT_REFRESH_COOLDOWN_MS;
	const cooldownProbeDelays =
		options.cooldownProbeDelaysMs ?? DEFAULT_COOLDOWN_PROBE_DELAYS_MS;
	const probeHub = options.probeHub ?? probeHubReachable;
	const runHistoryLimit = options.runHistoryLimit ?? DEFAULT_RUN_HISTORY_LIMIT;
	const now = options.now ?? (() => Date.now());
	const writeMirror = options.writeMirror ?? writeAttachmentMirror;
	const pairedFeedPublisher =
		options.pairedFeedPublisher ??
		createPairedFeedPublisher({
			readConfig,
			now,
			drainIntervalMs: options.feedDrainIntervalMs,
		});
	const decisionInbox = options.decisionInbox ?? createDashboardDecisionInbox();
	const retryInitialConnect = options.retryInitialConnect ?? true;
	const inventoryOptions: InstalledWorkflowInventoryOptions = {
		...(options.workflowStoreDir !== undefined
			? {storeDir: options.workflowStoreDir}
			: {}),
		...(options.cliVersion !== undefined
			? {cliVersion: options.cliVersion}
			: {}),
	};

	const startedAt = now();
	let stopped = false;
	let reconnectAttempt = 0;
	let client: InstanceSocketClient | null = null;
	let lastSocketClient: InstanceSocketClient | null = null;
	let currentInstanceId: string | undefined;
	let currentDashboardUrl: string | undefined;
	let lastFrameAt: number | undefined;
	let refreshTimer: NodeJS.Timeout | null = null;
	const refreshFailures: number[] = [];
	let cooldownUntil = 0;
	// Set when a probe cut the cooldown short. The refresh that follows is on
	// probation: if it fails too, the full cooldown comes straight back rather
	// than spending another `refreshFailureLimit` refresh attempts.
	let cooldownEndedEarly = false;
	let hubUnreachable = false;
	// Aborted by stop() so an in-flight probe doesn't outlive the daemon.
	const probeAbort = new AbortController();
	const executionClient: Pick<
		InstanceSocketClient,
		'sendRunEvent' | 'sendDecisionAck' | 'sendNeedsHuman'
	> = {
		sendRunEvent(event) {
			const current = client ?? lastSocketClient;
			if (!current) {
				log(
					'warn',
					`instance socket dropped run event (socket not connected): runId=${event.runId} kind=${event.kind}`,
				);
				return;
			}
			current.sendRunEvent(event);
		},
		sendNeedsHuman(input) {
			const current = client ?? lastSocketClient;
			if (!current) {
				log(
					'warn',
					`instance socket dropped needs_human (socket not connected): runId=${input.runId} kind=${input.interruption.kind}`,
				);
				return;
			}
			current.sendNeedsHuman(input);
		},
		sendDecisionAck(input) {
			const current = client;
			if (!current) return;
			current.sendDecisionAck(input);
		},
	};
	const pairedExecution = createDashboardPairedExecution({
		client: executionClient,
		executor,
		projectDir,
		decisionInbox,
		pairedFeedPublisher,
		log,
		maxConcurrentRuns,
		now,
		runHistoryLimit,
	});
	const attachmentReconciler = createAttachmentReconciler({
		writeMirror,
		...(options.fetchAttachments
			? {fetchAttachments: options.fetchAttachments}
			: {}),
		now,
	});
	// The hub's picture of what this machine can run: `hello` carries the
	// inventory on every connect (read at connect time), and a change to the
	// store while connected is pushed as a full-list replace — the same
	// semantics as the hub's `attachments.changed` push, in the other
	// direction. While disconnected nothing is sent; the next hello is current.
	const workflowWatcher = watchInstalledWorkflows({
		...inventoryOptions,
		log,
		onChange: workflows => {
			const current = client;
			if (!current) return;
			current.sendWorkflowsChanged(workflows);
		},
	});
	const assignmentIntake = createDashboardAssignmentIntake({
		client: {
			sendAssignmentAccepted(runId) {
				const current = client;
				if (!current) return;
				current.sendAssignmentAccepted(runId);
			},
			sendAssignmentRejected(input) {
				const current = client;
				if (!current) return;
				current.sendAssignmentRejected(input);
			},
		},
		execution: pairedExecution,
		log,
		resolveWorkspace: (assignment, context) =>
			resolveRemoteWorkspace(assignment, {dashboardUrl: context.dashboardUrl}),
	});

	function nextReconnectDelay(): number {
		if (reconnectDelays.length === 0) return 0;
		const delayMs =
			reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)] ??
			0;
		reconnectAttempt += 1;
		return delayMs;
	}

	function clearRefreshTimer(): void {
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = null;
		}
	}

	function scheduleRefresh(expiresInSec: number): void {
		clearRefreshTimer();
		if (!Number.isFinite(expiresInSec) || expiresInSec <= refreshLeadSec) {
			return;
		}
		const ms = (expiresInSec - refreshLeadSec) * 1_000;
		const timer = setTimeout(() => {
			void proactiveRefresh();
		}, ms);
		timer.unref();
		refreshTimer = timer;
	}

	async function proactiveRefresh(): Promise<void> {
		if (stopped) return;
		try {
			const token = await refreshAccessTokenFn();
			refreshFailures.length = 0;
			scheduleRefresh(token.expiresInSec);
			log('debug', `runtime daemon refreshed token (proactive)`);
		} catch (err) {
			noteRefreshFailure();
			log(
				'warn',
				`runtime daemon proactive refresh failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	function noteRefreshFailure(): void {
		const ts = now();
		refreshFailures.push(ts);
		while (
			refreshFailures.length > 0 &&
			ts - (refreshFailures[0] ?? 0) > refreshFailureWindowMs
		) {
			refreshFailures.shift();
		}
		if (refreshFailures.length >= refreshFailureLimit || cooldownEndedEarly) {
			cooldownUntil = ts + refreshCooldownMs;
			cooldownEndedEarly = false;
			refreshFailures.length = 0;
			log(
				'warn',
				`runtime daemon refresh circuit-broken; cooling down for ${Math.round(
					refreshCooldownMs / 1_000,
				)}s`,
			);
		}
	}

	// Sleeps out the breaker's cooldown, probing the hub meanwhile. Only an
	// outage that ends — a probe that failed, then one that answers — cuts the
	// cooldown short. A hub that answers from the first probe was reachable
	// all along, so the failures were auth failures and keep the full cooldown.
	async function waitOutCooldown(dashboardUrl: string): Promise<void> {
		let attempt = 0;
		let sawHubDown = false;
		try {
			while (!stopped && cooldownUntil > now()) {
				const remainingMs = cooldownUntil - now();
				if (cooldownProbeDelays.length === 0) {
					await delay(remainingMs);
					return;
				}
				const probeDelayMs =
					cooldownProbeDelays[
						Math.min(attempt, cooldownProbeDelays.length - 1)
					] ?? remainingMs;
				attempt += 1;
				await delay(Math.min(remainingMs, probeDelayMs));
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- values may change during await
				if (stopped || cooldownUntil <= now()) return;
				const reachable = await probeHub(dashboardUrl, probeAbort.signal);
				hubUnreachable = !reachable;
				if (!reachable) {
					sawHubDown = true;
				} else if (sawHubDown) {
					cooldownUntil = 0;
					cooldownEndedEarly = true;
					log(
						'info',
						'runtime daemon: hub is reachable again; ending refresh cooldown early',
					);
					return;
				}
			}
		} finally {
			hubUnreachable = false;
		}
	}

	async function connectOnce(): Promise<void> {
		const config = readConfig();
		if (!config) {
			throw new Error('runner: not paired. Run "drisp runner pair" first.');
		}
		// If the circuit breaker has tripped, wait out the cooldown (or until a
		// probe sees the hub come back) rather than throwing immediately. Throwing inside reconnectLoop with a
		// 0ms backoff turns into a tight microtask spin; sleeping yields to
		// other timers and lets `stop()` interrupt cleanly.
		if (cooldownUntil > now()) {
			const remainingMs = Math.max(0, cooldownUntil - now());
			log(
				'warn',
				`runtime daemon: refresh cooldown active for ${Math.ceil(
					remainingMs / 1_000,
				)}s; probing the hub meanwhile`,
			);
			await waitOutCooldown(config.dashboardUrl);
			if (stopped) return;
		}
		let token: DashboardAccessToken;
		try {
			token = await refreshAccessTokenFn();
			refreshFailures.length = 0;
			cooldownEndedEarly = false;
		} catch (err) {
			noteRefreshFailure();
			throw err;
		}
		const next = makeClient({
			dashboardUrl: config.dashboardUrl,
			instanceId: token.instanceId,
			accessToken: token.accessToken,
			log,
			installedWorkflows: () => listInstalledWorkflows(inventoryOptions),
		});
		next.onFrame(frame => {
			lastFrameAt = now();
			if (frame.type === 'attachments.changed') {
				try {
					attachmentReconciler.applyPush({
						instanceId: token.instanceId,
						attachments: frame.attachments.map(a => ({
							runnerId: a.runnerId,
							...(a.name !== undefined ? {name: a.name} : {}),
							...(a.executionTarget !== undefined
								? {executionTarget: a.executionTarget}
								: {}),
							...(a.remoteInstanceId !== undefined
								? {remoteInstanceId: a.remoteInstanceId}
								: {}),
						})),
					});
				} catch (err) {
					log(
						'warn',
						`runtime daemon: failed to write attachment mirror: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				}
				return;
			}
			if (frame.type === 'feed_ack') {
				pairedFeedPublisher.handleAck(frame);
				return;
			}
			if (frame.type === 'run.start') {
				assignmentIntake.receive(frame);
				return;
			}
			if (frame.type === 'hello') {
				// The socket client already negotiated the wire mode; this is the
				// daemon's record of who is on the other end.
				log(
					'info',
					`runtime daemon: hub hello protocolVersion=${frame.protocolVersion}${
						frame.agent ? ` agent=${frame.agent.name}` : ''
					}`,
				);
				return;
			}
			if (frame.type === 'error') {
				log(
					'warn',
					`runtime daemon: hub error frame code=${frame.code}${
						frame.message ? `: ${frame.message}` : ''
					}`,
				);
				return;
			}
			if (frame.type === 'pong') return;
			if (!routeDashboardRunFrame(pairedExecution, frame)) {
				log('debug', `runtime daemon: unhandled frame type=${frame.type}`);
			}
		});
		next.onClose(reason => {
			if (stopped || client !== next) return;
			log('warn', `instance socket closed: ${reason}`);
			client = null;
			assignmentIntake.markNotReady();
			attachmentReconciler.markStale(token.instanceId);
			currentInstanceId = undefined;
			clearRefreshTimer();
			pairedFeedPublisher.detachTransport();
			void reconnectLoop();
		});
		await next.connect();
		client = next;
		lastSocketClient = next;
		try {
			await attachmentReconciler.reconcileNow({
				dashboardUrl: config.dashboardUrl,
				instanceId: token.instanceId,
				accessToken: token.accessToken,
			});
		} catch (err) {
			// Reconnect refetch is an optimization, not a precondition: the
			// push-based `attachments.changed` stream keeps the mirror current on
			// its own. A dashboard that lacks the REST endpoint (or a transient
			// failure) must not wedge the control channel in a reconnect loop, so
			// degrade to push-only instead of tearing the connection down.
			attachmentReconciler.markStale(token.instanceId);
			log(
				'warn',
				`runtime daemon: attachment reconciliation failed; continuing with push-only mirror: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
		// The socket may have closed while we awaited reconciliation (onClose
		// nulls `client` and schedules a reconnect). Bail before marking ready so
		// we never admit assignments against a dead client.
		if (stopped || client !== next) return;
		currentInstanceId = token.instanceId;
		currentDashboardUrl = config.dashboardUrl;
		assignmentIntake.markReady({
			dashboardUrl: config.dashboardUrl,
			instanceId: token.instanceId,
		});
		reconnectAttempt = 0;
		scheduleRefresh(token.expiresInSec);
		pairedFeedPublisher.attachTransport(next);
		log('info', `dashboard runtime daemon connected as ${token.instanceId}`);
	}

	async function reconnectLoop(): Promise<void> {
		while (!stopped && client === null) {
			const waitMs = nextReconnectDelay();
			if (waitMs > 0) await delay(waitMs);
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- values may change during await
			if (stopped || client !== null) return;
			try {
				await connectOnce();
				return;
			} catch (err) {
				log(
					'warn',
					`dashboard runtime daemon reconnect failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		}
	}

	try {
		await connectOnce();
	} catch (err) {
		if (!retryInitialConnect) {
			throw err;
		}
		log(
			'warn',
			`dashboard runtime daemon initial connect failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		void reconnectLoop();
	}

	return {
		snapshot(): RuntimeDaemonSnapshot {
			const executionSnapshot = pairedExecution.snapshot();
			const refreshState =
				refreshFailures.length > 0 || cooldownUntil > now()
					? {
							recentFailures: refreshFailures.length,
							...(cooldownUntil > now()
								? {cooldownUntilMs: cooldownUntil}
								: {}),
							...(hubUnreachable ? {hubUnreachable: true} : {}),
						}
					: undefined;
			return {
				startedAt,
				socketConnected: client !== null,
				...(client ? {wireMode: client.wireMode()} : {}),
				...(lastFrameAt !== undefined ? {lastFrameAt} : {}),
				activeRuns: executionSnapshot.activeRuns,
				completedRuns: executionSnapshot.completedRuns,
				...(currentInstanceId ? {instanceId: currentInstanceId} : {}),
				...(currentDashboardUrl ? {dashboardUrl: currentDashboardUrl} : {}),
				...(refreshState ? {refreshState} : {}),
			};
		},
		listRuns(opts = {}): RuntimeDaemonRunRecord[] {
			return pairedExecution.listRuns(opts);
		},
		async stop(reason = 'stopped') {
			stopped = true;
			clearRefreshTimer();
			probeAbort.abort();
			workflowWatcher.close();
			pairedFeedPublisher.close();
			const current = client;
			client = null;
			current?.close(reason);
			await pairedExecution.stop();
		},
	};
}
