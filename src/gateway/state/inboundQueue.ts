/**
 * Durable FIFO queue for inbound chat messages that arrive when no runtime
 * is registered for an attachment slot. Drained in id order on
 * `session.register` for that same slot.
 *
 * `enqueue` is idempotent on `(channelId, accountId, idempotencyKey)` — a
 * provider retrying the same update_id will not double-park.
 */

import type {NormalizedInbound} from '../../shared/gateway-protocol';
import type {GatewayStateDb} from './db';

export type ParkedInbound = {
	id: number;
	inbound: NormalizedInbound;
};

export type EnqueueResult =
	| {kind: 'queued'; id: number}
	| {kind: 'duplicate'}
	| {kind: 'rejected'; reason: 'queue_full'};

export type InboundQueueOptions = {
	maxEntries?: number;
};

const DEFAULT_MAX_ENTRIES = 1000;

type AttachmentKey = string | undefined;

export class InboundQueue {
	private readonly db: GatewayStateDb;
	private readonly maxEntries: number;

	constructor(db: GatewayStateDb, opts: InboundQueueOptions = {}) {
		this.db = db;
		this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
	}

	size(): number {
		const row = this.db
			.prepare('SELECT COUNT(*) as n FROM inbound_queue')
			.get() as {n: number};
		return row.n;
	}

	enqueue(inbound: NormalizedInbound, key: AttachmentKey): EnqueueResult {
		if (this.size() >= this.maxEntries) {
			return {kind: 'rejected', reason: 'queue_full'};
		}
		const stmt = this.db.prepare(
			`INSERT INTO inbound_queue
				(attachment_id, channel_id, account_id, idempotency_key, payload_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(channel_id, account_id, idempotency_key) DO NOTHING`,
		);
		const result = stmt.run(
			key ?? null,
			inbound.location.channelId,
			inbound.location.accountId,
			inbound.idempotencyKey,
			JSON.stringify(inbound),
			Date.now(),
		);
		if (result.changes === 0) {
			return {kind: 'duplicate'};
		}
		return {kind: 'queued', id: Number(result.lastInsertRowid)};
	}

	/** Atomically read and remove parked entries for one attachment slot. */
	drain(key: AttachmentKey): ParkedInbound[] {
		return this.db.transaction(() => {
			const rows = this.db
				.prepare(
					`SELECT id, payload_json
					   FROM inbound_queue
					  WHERE attachment_id IS ?
				   ORDER BY id ASC`,
				)
				.all(key ?? null) as Array<{id: number; payload_json: string}>;
			if (rows.length > 0) {
				this.db
					.prepare('DELETE FROM inbound_queue WHERE attachment_id IS ?')
					.run(key ?? null);
			}
			return rows.map(r => ({
				id: r.id,
				inbound: JSON.parse(r.payload_json) as NormalizedInbound,
			}));
		})();
	}
}
