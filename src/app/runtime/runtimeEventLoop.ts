// src/app/runtime/runtimeEventLoop.ts

import type {
	Runtime,
	RuntimeDecision,
	RuntimeEvent,
} from '../../core/runtime/types';
import type {FeedEvent} from '../../core/feed/types';
import type {FeedMapper} from '../../core/feed/mapper';
import type {SessionStore} from '../../infra/sessions/store';
import {
	ingestRuntimeDecision,
	ingestRuntimeEvent,
} from '../../core/feed/ingest';
import type {ControllerCallbacks} from '../../core/controller/runtimeController';
import type {DashboardDecisionReader} from '../dashboard/dashboardDecisionInbox';

/**
 * The non-React runtime-event loop shared by interactive (`useFeed`) and
 * headless (`runExec`) modes.
 *
 * Both modes subscribe to the same `RuntimeEvent`/`RuntimeDecision` streams and
 * run the identical assembly: ingest through the FeedMapper, feed any
 * controller decision back to the runtime via `sendDecision` BEFORE handing the
 * resulting FeedEvents to a mode-specific sink. That ordering, the subscription
 * lifecycle, and the dashboard-decision drain used to be hand-rolled twice and
 * had already started to drift. This module owns them once; each mode injects
 * only its own side effects (perf tracing + React store pushes for interactive,
 * JSONL emission + final-message tracking for headless) through the hooks below.
 */

/** Batch size for a single dashboard-decision drain pass. */
export const DASHBOARD_DECISION_POLL_LIMIT = 25;
/** Default cadence for the dashboard-decision drain interval. */
export const DASHBOARD_DECISION_POLL_INTERVAL_MS = 1_000;

export type RuntimeEventLoopIngest = {
	mapper: FeedMapper;
	store?: SessionStore | undefined;
	controllerCallbacks: ControllerCallbacks;
	onPersistFailure?: (message: string) => void;
};

/**
 * The ingest context, resolved per event/decision. Interactive mode passes a
 * function so a mid-stream session reset (new mapper) or store swap is picked up
 * on the very next event; headless mode passes a stable object.
 */
export type RuntimeEventLoopIngestSource =
	| RuntimeEventLoopIngest
	| (() => RuntimeEventLoopIngest);

export type RuntimeEventLoopOptions = {
	runtime: Runtime;
	ingest: RuntimeEventLoopIngestSource;

	// ── RuntimeEvent handling ──
	/**
	 * Unconditional side effects run for every event before ingest — perf/trace
	 * (interactive) or JSONL emission + adapter-session linking (headless).
	 */
	onEventReceived?: (event: RuntimeEvent) => void;
	/** Return true to skip ingest + decision + sink for this event. */
	skipEvent?: (event: RuntimeEvent) => boolean;
	/** Consume the FeedEvents produced by ingesting a RuntimeEvent. */
	emitEventFeed: (feedEvents: FeedEvent[], event: RuntimeEvent) => void;
	/** Wrap the whole per-event handler (e.g. a perf span). Must invoke `run`. */
	wrapEvent?: (event: RuntimeEvent, run: () => void) => void;

	// ── RuntimeDecision handling ──
	/** Unconditional side effects run for every decision before the skip check. */
	onDecisionReceived?: (eventId: string, decision: RuntimeDecision) => void;
	/** Return true to skip the ingest + sink for this decision. */
	skipDecision?: (eventId: string, decision: RuntimeDecision) => boolean;
	/** Side effects run after the skip check but before ingest (e.g. dequeue). */
	beforeDecisionIngest?: (eventId: string, decision: RuntimeDecision) => void;
	/** Consume the FeedEvent produced by ingesting a RuntimeDecision (may be null). */
	emitDecisionFeed: (
		feedEvent: FeedEvent | null,
		eventId: string,
		decision: RuntimeDecision,
	) => void;
	/** Wrap the whole per-decision handler (e.g. a perf span). Must invoke `run`. */
	wrapDecision?: (
		eventId: string,
		decision: RuntimeDecision,
		run: () => void,
	) => void;
};

export type RuntimeEventLoopHandle = {
	/** Unsubscribe both runtime listeners. Idempotent per underlying runtime. */
	stop(): void;
};

function resolveIngest(
	source: RuntimeEventLoopIngestSource,
): RuntimeEventLoopIngest {
	return typeof source === 'function' ? source() : source;
}

export function attachRuntimeEventLoop(
	options: RuntimeEventLoopOptions,
): RuntimeEventLoopHandle {
	const {runtime} = options;

	const runEvent = (event: RuntimeEvent): void => {
		options.onEventReceived?.(event);
		if (options.skipEvent?.(event)) return;
		const {feedEvents, decision} = ingestRuntimeEvent(
			event,
			resolveIngest(options.ingest),
		);
		if (decision) {
			runtime.sendDecision(event.id, decision);
		}
		options.emitEventFeed(feedEvents, event);
	};

	const runDecision = (eventId: string, decision: RuntimeDecision): void => {
		options.onDecisionReceived?.(eventId, decision);
		if (options.skipDecision?.(eventId, decision)) return;
		options.beforeDecisionIngest?.(eventId, decision);
		// The decision path deliberately takes a narrower context than the event
		// path — it never consumes controllerCallbacks — so pass only what
		// ingestRuntimeDecision reads rather than the full event-ingest shape.
		const ingest = resolveIngest(options.ingest);
		const feedEvent = ingestRuntimeDecision(eventId, decision, {
			mapper: ingest.mapper,
			store: ingest.store,
			onPersistFailure: ingest.onPersistFailure,
		});
		options.emitDecisionFeed(feedEvent, eventId, decision);
	};

	const unsubscribeEvent = runtime.onEvent(event => {
		if (options.wrapEvent) {
			options.wrapEvent(event, () => runEvent(event));
		} else {
			runEvent(event);
		}
	});

	const unsubscribeDecision = runtime.onDecision((eventId, decision) => {
		if (options.wrapDecision) {
			options.wrapDecision(eventId, decision, () =>
				runDecision(eventId, decision),
			);
		} else {
			runDecision(eventId, decision);
		}
	});

	return {
		stop(): void {
			unsubscribeEvent();
			unsubscribeDecision();
		},
	};
}

// ── Dashboard decision drain ─────────────────────────────
//
// The paired dashboard routes user decisions into a local inbox; each mode
// drains pending decisions for its Athena session and forwards them to the
// runtime. This was copy-pasted (`limit: 25`, `1000ms`) in both modes; it now
// lives here. Each caller still owns WHEN the drain starts (interactive: a React
// effect; headless: after `runtime.start()`), so the drain is a standalone
// helper rather than folded into the subscription loop above.

export type DashboardDecisionDrainOptions = {
	runtime: Pick<Runtime, 'sendDecision'>;
	inbox: DashboardDecisionReader;
	athenaSessionId: string;
	pollIntervalMs?: number;
	/**
	 * Called when forwarding a decision throws. When omitted the error
	 * propagates (interactive relies on store degradation elsewhere); headless
	 * passes a warn sink so one bad decision does not abort the drain pass.
	 */
	onError?: (error: unknown) => void;
	/** Hook to configure the interval handle, e.g. `timer.unref()` in headless. */
	configureTimer?: (timer: ReturnType<typeof setInterval>) => void;
};

export type DashboardDecisionDrain = {
	/** Clear the interval. */
	stop(): void;
};

/**
 * Start draining the dashboard decision inbox: one immediate pass, then on an
 * interval. Returns a handle to stop the interval.
 */
export function startDashboardDecisionDrain(
	options: DashboardDecisionDrainOptions,
): DashboardDecisionDrain {
	const {runtime, inbox, athenaSessionId} = options;

	const drainOnce = (): void => {
		const rows = inbox.pendingForSession({
			athenaSessionId,
			limit: DASHBOARD_DECISION_POLL_LIMIT,
		});
		for (const row of rows) {
			try {
				runtime.sendDecision(row.requestId, row.decision);
				inbox.markConsumed({id: row.id});
			} catch (error) {
				if (!options.onError) throw error;
				options.onError(error);
			}
		}
	};

	drainOnce();
	const timer = setInterval(
		drainOnce,
		options.pollIntervalMs ?? DASHBOARD_DECISION_POLL_INTERVAL_MS,
	);
	options.configureTimer?.(timer);

	return {
		stop(): void {
			clearInterval(timer);
		},
	};
}
