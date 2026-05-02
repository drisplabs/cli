/**
 * OutboundDispatcher — wraps `ChannelManager.send()` with a durable retry
 * outbox. Try-send first; on failure, park the message and let the drain
 * loop retry with exponential backoff.
 *
 * The dispatcher's `dispatch()` returns synchronously after the first
 * attempt — the caller learns whether the message went out immediately or
 * was queued. Either way, delivery is guaranteed (until `MAX_ATTEMPTS` is
 * hit, after which the message is dropped with a logged audit).
 */

import type {OutboundMessage, SendResult} from '../shared/gateway-protocol';
import type {Outbox, OutboxRow} from './state/outbox';

export type Sender = (
	channelId: string,
	msg: OutboundMessage,
) => Promise<SendResult>;

export type DispatchResult =
	| {kind: 'sent'; result: SendResult}
	| {kind: 'queued'; outboxId: number; error: string};

export type OutboundDispatcherOptions = {
	outbox: Outbox;
	send: Sender;
	/** Backoff schedule in ms; capped at the last entry. */
	backoffSchedule?: number[];
	/** Max attempts before dropping. */
	maxAttempts?: number;
	/** Drain loop tick interval. */
	tickIntervalMs?: number;
	/** Max rows pulled per tick. */
	drainBatchSize?: number;
	now?: () => number;
	log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
};

const DEFAULT_BACKOFF = [
	1_000, // 1s
	2_000, // 2s
	4_000, // 4s
	8_000, // 8s
	16_000, // 16s
	30_000, // 30s
];
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_TICK_MS = 1_000;
const DEFAULT_BATCH = 16;

export class OutboundDispatcher {
	private readonly outbox: Outbox;
	private readonly send: Sender;
	private readonly backoff: number[];
	private readonly maxAttempts: number;
	private readonly tickMs: number;
	private readonly batchSize: number;
	private readonly now: () => number;
	private readonly log: OutboundDispatcherOptions['log'];
	private timer: NodeJS.Timeout | null = null;
	private draining = false;
	private stopped = false;

	constructor(opts: OutboundDispatcherOptions) {
		this.outbox = opts.outbox;
		this.send = opts.send;
		this.backoff = opts.backoffSchedule ?? DEFAULT_BACKOFF;
		this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
		this.tickMs = opts.tickIntervalMs ?? DEFAULT_TICK_MS;
		this.batchSize = opts.drainBatchSize ?? DEFAULT_BATCH;
		this.now = opts.now ?? Date.now;
		this.log = opts.log;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.drain();
		}, this.tickMs);
		// Don't keep the event loop alive solely for the drain timer.
		this.timer.unref();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	async dispatch(
		channelId: string,
		msg: OutboundMessage,
	): Promise<DispatchResult> {
		try {
			const result = await this.send(channelId, msg);
			return {kind: 'sent', result};
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			const nextAttemptAt = this.now() + this.backoffFor(0);
			const id = this.outbox.enqueue({
				channelId,
				message: msg,
				nextAttemptAt,
				lastError: error,
			});
			this.log?.(
				'warn',
				`send to ${channelId} failed; parked as outbox#${id}: ${error}`,
			);
			return {kind: 'queued', outboxId: id, error};
		}
	}

	/**
	 * Drain due entries. Exposed for tests; the timer also calls this. Safe
	 * to call concurrently — a re-entry guard short-circuits.
	 */
	async drain(): Promise<{
		retried: number;
		succeeded: number;
		dropped: number;
	}> {
		if (this.draining || this.stopped) {
			return {retried: 0, succeeded: 0, dropped: 0};
		}
		this.draining = true;
		let retried = 0;
		let succeeded = 0;
		let dropped = 0;
		try {
			const due = this.outbox.peekDue(this.now(), this.batchSize);
			for (const row of due) {
				retried += 1;
				const outcome = await this.attempt(row);
				if (outcome === 'succeeded') succeeded += 1;
				else if (outcome === 'dropped') dropped += 1;
			}
		} finally {
			this.draining = false;
		}
		return {retried, succeeded, dropped};
	}

	private async attempt(
		row: OutboxRow,
	): Promise<'succeeded' | 'requeued' | 'dropped'> {
		try {
			await this.send(row.channelId, row.message);
			this.outbox.delete(row.id);
			this.log?.(
				'info',
				`outbox#${row.id} delivered to ${row.channelId} on attempt ${row.attempt + 1}`,
			);
			return 'succeeded';
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			const nextAttempt = row.attempt + 1;
			if (nextAttempt >= this.maxAttempts) {
				this.outbox.delete(row.id);
				this.log?.(
					'error',
					`outbox#${row.id} dropped after ${nextAttempt} attempts: ${error}`,
				);
				return 'dropped';
			}
			const nextAttemptAt = this.now() + this.backoffFor(nextAttempt);
			this.outbox.recordFailure({
				id: row.id,
				nextAttemptAt,
				lastError: error,
			});
			return 'requeued';
		}
	}

	private backoffFor(attempt: number): number {
		if (this.backoff.length === 0) return 1_000;
		const idx = Math.min(attempt, this.backoff.length - 1);
		return this.backoff[idx] as number;
	}
}
