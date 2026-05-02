/**
 * Durable retry queue for outbound channel sends.
 *
 * When `ChannelManager.send()` fails transiently (network blip, provider
 * 5xx, timeout), the OutboundDispatcher parks the message here and a retry
 * loop drains due entries with exponential backoff. Survives daemon
 * restart since rows live in `~/.config/athena/gateway/state.db`.
 *
 * Idempotency is the caller's responsibility: the parked `OutboundMessage`
 * carries an `idempotencyKey` that the adapter must honour to avoid
 * double-delivery if the first attempt partially succeeded.
 */

import type {OutboundMessage} from '../../shared/gateway-protocol';
import type {GatewayStateDb} from './db';

export type OutboxRow = {
	id: number;
	channelId: string;
	message: OutboundMessage;
	attempt: number;
	nextAttemptAt: number;
	lastError: string | null;
};

export class Outbox {
	private readonly db: GatewayStateDb;

	constructor(db: GatewayStateDb) {
		this.db = db;
	}

	size(): number {
		const row = this.db
			.prepare('SELECT COUNT(*) as n FROM channel_outbox')
			.get() as {n: number};
		return row.n;
	}

	enqueue(input: {
		channelId: string;
		message: OutboundMessage;
		nextAttemptAt: number;
		lastError?: string;
	}): number {
		const result = this.db
			.prepare(
				`INSERT INTO channel_outbox
					(channel_id, payload_json, attempt, next_attempt_at, last_error, created_at)
				 VALUES (?, ?, 0, ?, ?, ?)`,
			)
			.run(
				input.channelId,
				JSON.stringify(input.message),
				input.nextAttemptAt,
				input.lastError ?? null,
				Date.now(),
			);
		return Number(result.lastInsertRowid);
	}

	/** Rows whose `next_attempt_at` is at or before `now`, oldest first. */
	peekDue(now: number, limit: number): OutboxRow[] {
		const rows = this.db
			.prepare(
				`SELECT id, channel_id, payload_json, attempt, next_attempt_at, last_error
				 FROM channel_outbox
				 WHERE next_attempt_at <= ?
				 ORDER BY next_attempt_at ASC, id ASC
				 LIMIT ?`,
			)
			.all(now, limit) as Array<{
			id: number;
			channel_id: string;
			payload_json: string;
			attempt: number;
			next_attempt_at: number;
			last_error: string | null;
		}>;
		return rows.map(r => ({
			id: r.id,
			channelId: r.channel_id,
			message: JSON.parse(r.payload_json) as OutboundMessage,
			attempt: r.attempt,
			nextAttemptAt: r.next_attempt_at,
			lastError: r.last_error,
		}));
	}

	delete(id: number): void {
		this.db.prepare('DELETE FROM channel_outbox WHERE id = ?').run(id);
	}

	recordFailure(input: {
		id: number;
		nextAttemptAt: number;
		lastError: string;
	}): void {
		this.db
			.prepare(
				`UPDATE channel_outbox
				 SET attempt = attempt + 1,
				     next_attempt_at = ?,
				     last_error = ?
				 WHERE id = ?`,
			)
			.run(input.nextAttemptAt, input.lastError, input.id);
	}
}
