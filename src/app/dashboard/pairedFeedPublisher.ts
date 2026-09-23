import type {FeedAckFrame} from '@drisp/protocol';
import type {FeedEvent} from '../../core/feed/types';
import {
	readDashboardClientConfig,
	type DashboardClientConfig,
} from '../../infra/config/dashboardClient';
import {
	createDashboardFeedOutbox,
	type DashboardFeedEnvelope,
	type DashboardFeedOrigin,
	type DashboardFeedOutbox,
} from './dashboardFeedPublisher';

export type PairedFeedTransport = {
	sendFeedEvent(frame: {
		deliverySeq: number;
		envelope: DashboardFeedEnvelope;
	}): void;
};

/**
 * The narrow capability a Run's execution path needs: publish FeedEvents and
 * nothing else. Execution receives this — never the full publisher — so it
 * cannot reach the dashboard transport lifecycle (attach/detach/handleAck/close),
 * which the runtime daemon owns exclusively.
 */
export type FeedSink = {
	publish(input: {
		origin: DashboardFeedOrigin;
		athenaSessionId: string;
		feedEvents: readonly FeedEvent[];
	}): void;
};

export type PairedFeedPublisher = FeedSink & {
	attachTransport(transport: PairedFeedTransport): void;
	detachTransport(): void;
	handleAck(frame: FeedAckFrame): void;
	close(): void;
};

export type CreatePairedFeedPublisherOptions = {
	readConfig?: () => DashboardClientConfig | null;
	outbox?: DashboardFeedOutbox;
	now?: () => number;
	onError?: (message: string) => void;
	onInfo?: (message: string) => void;
	drainIntervalMs?: number;
	/** Rows from previous pairings deleted per drain tick (see `pruneStep`). */
	pruneBatchSize?: number;
};

const DEFAULT_DRAIN_INTERVAL_MS = 1_000;
// ~30ms of deletes per drain tick; a 100k-row backlog clears in a few minutes.
const DEFAULT_PRUNE_BATCH_SIZE = 500;

export function createPairedFeedPublisher(
	options: CreatePairedFeedPublisherOptions = {},
): PairedFeedPublisher {
	const readConfig = options.readConfig ?? (() => readDashboardClientConfig());
	const now = options.now ?? (() => Date.now());
	const onError = options.onError ?? (() => {});
	const onInfo = options.onInfo ?? (() => {});
	const drainIntervalMs = options.drainIntervalMs ?? DEFAULT_DRAIN_INTERVAL_MS;
	const pruneBatchSize = options.pruneBatchSize ?? DEFAULT_PRUNE_BATCH_SIZE;
	let ownedOutbox: DashboardFeedOutbox | null = null;
	let transport: PairedFeedTransport | null = null;
	let drainTimer: NodeJS.Timeout | null = null;
	/** Rows pruned by the prune in progress; `null` when none is running. */
	let prunedSoFar: number | null = null;

	function getOutbox(): DashboardFeedOutbox {
		if (options.outbox) return options.outbox;
		ownedOutbox ??= createDashboardFeedOutbox();
		return ownedOutbox;
	}

	function clearDrainTimer(): void {
		if (!drainTimer) return;
		clearInterval(drainTimer);
		drainTimer = null;
	}

	/** Send due rows; returns the config it drained for, or `null`. */
	function drain(force = false): DashboardClientConfig | null {
		if (!transport) return null;
		let config: DashboardClientConfig | null;
		try {
			config = readConfig();
		} catch (err) {
			onError(
				`paired feed drain failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return null;
		}
		if (!config) return null;
		const rows = getOutbox().pendingBatch({
			instanceId: config.instanceId,
			limit: 100,
			now: force ? Number.POSITIVE_INFINITY : now(),
		});
		for (const row of rows) {
			transport.sendFeedEvent({
				deliverySeq: row.deliverySeq,
				envelope: row.envelope,
			});
			getOutbox().markAttempted({
				deliverySeq: row.deliverySeq,
				nextAttemptAt: now() + Math.min(30_000, (row.attempt + 1) * 1_000),
			});
		}
		return config;
	}

	/**
	 * A drain tick (timer or attach): send first, then prune one batch, so the
	 * prune never delays current rows. `publish` drains without pruning, which
	 * keeps deletes off the per-event hot path.
	 */
	function tick(force = false): void {
		const config = drain(force);
		if (config) pruneStep(config.instanceId);
	}

	/**
	 * Rows stamped for a previous pairing can never be delivered (the hub
	 * rejects another instance's envelope), so drop them rather than let them
	 * pile up in the outbox. A prune starts on every attach (where a re-paired
	 * runner first talks to the hub as its new instance) and deletes one small
	 * batch per drain tick, so a large backlog never blocks the event loop.
	 */
	function pruneStep(instanceId: string): void {
		if (prunedSoFar === null) return;
		try {
			const deleted = getOutbox().pruneOtherInstances({
				instanceId,
				limit: pruneBatchSize,
			});
			prunedSoFar += deleted;
			if (deleted < pruneBatchSize) {
				if (prunedSoFar > 0) {
					onInfo(
						`paired feed: pruned ${prunedSoFar} outbox row(s) left by previous pairings`,
					);
				}
				prunedSoFar = null;
			}
		} catch (err) {
			prunedSoFar = null;
			onError(
				`paired feed prune failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	function startDrainTimer(): void {
		clearDrainTimer();
		const timer = setInterval(() => tick(), drainIntervalMs);
		timer.unref();
		drainTimer = timer;
		tick(true);
	}

	return {
		publish(input) {
			if (input.feedEvents.length === 0) return;
			try {
				const config = readConfig();
				if (!config) return;
				getOutbox().enqueue({
					instanceId: config.instanceId,
					athenaSessionId: input.athenaSessionId,
					origin: input.origin,
					feedEvents: input.feedEvents,
					emittedAt: now(),
				});
				drain();
			} catch (err) {
				onError(
					`paired feed publish failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		},
		attachTransport(nextTransport) {
			transport = nextTransport;
			prunedSoFar ??= 0;
			startDrainTimer();
		},
		detachTransport() {
			transport = null;
			clearDrainTimer();
		},
		handleAck(frame) {
			getOutbox().markAcked({
				...(typeof frame.deliverySeq === 'number'
					? {deliverySeq: frame.deliverySeq}
					: {}),
				...(typeof frame.eventId === 'string' ? {eventId: frame.eventId} : {}),
			});
		},
		close() {
			this.detachTransport();
			ownedOutbox?.close();
		},
	};
}
