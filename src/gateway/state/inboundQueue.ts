/**
 * Durable FIFO queue for inbound chat messages that arrive when no runtime
 * is registered. Drained in id order on `session.register`.
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

	enqueue(inbound: NormalizedInbound): EnqueueResult {
		if (this.size() >= this.maxEntries) {
			return {kind: 'rejected', reason: 'queue_full'};
		}
		const stmt = this.db.prepare(
			`INSERT INTO inbound_queue
				(channel_id, account_id, idempotency_key, payload_json, created_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(channel_id, account_id, idempotency_key) DO NOTHING`,
		);
		const result = stmt.run(
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

	/** Atomically read and remove all parked entries in FIFO order. */
	drain(): ParkedInbound[] {
		return this.db.transaction(() => {
			const rows = this.db
				.prepare('SELECT id, payload_json FROM inbound_queue ORDER BY id ASC')
				.all() as Array<{id: number; payload_json: string}>;
			if (rows.length > 0) {
				this.db.prepare('DELETE FROM inbound_queue').run();
			}
			return rows.map(r => ({
				id: r.id,
				inbound: JSON.parse(r.payload_json) as NormalizedInbound,
			}));
		})();
	}
}
