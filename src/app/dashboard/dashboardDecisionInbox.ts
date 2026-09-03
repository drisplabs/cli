import type Database from 'better-sqlite3';
import type {RuntimeDecision} from '../../core/runtime/types';
import {openRunnerDb, type RunnerDb} from '../runner/runnerDb';

export type DashboardDecisionInboxRow = {
	id: number;
	athenaSessionId: string;
	requestId: string;
	decision: RuntimeDecision;
	receivedAt: number;
};

/**
 * The narrow capability a Run's execution path needs: poll pending decisions
 * and mark them consumed. Execution receives this — never the full inbox — so
 * it cannot enqueue decisions or close the durable store; those stay owned by
 * the runtime daemon (which routes dashboard decisions in).
 */
export type DashboardDecisionReader = {
	pendingForSession(input: {
		athenaSessionId: string;
		limit: number;
	}): DashboardDecisionInboxRow[];
	markConsumed(input: {id: number}): void;
};

export type DashboardDecisionInbox = DashboardDecisionReader & {
	enqueue(input: {
		athenaSessionId: string;
		requestId: string;
		decision: RuntimeDecision;
		receivedAt: number;
	}): void;
	close(): void;
};

/**
 * The inbox is a table in `runner.db` (see `runnerDb.ts`, which owns the
 * schema; a legacy `dashboard-decision-inbox.db` — including the oldest shape
 * with a full UNIQUE constraint — is imported there once). Pass the owner's
 * open handle to share it — `close()` then leaves the handle open; with no
 * handle the inbox opens `runner.db` itself (the interactive TUI draining
 * decisions without a runner in the process) and owns that connection.
 */
export type CreateDashboardDecisionInboxOptions = {
	/** An open `runner.db` handle to share (the runner's). */
	db?: Database.Database;
	/** Open `runner.db` at this path instead of the state dir's (tests). */
	dbPath?: string;
};

export function createDashboardDecisionInbox(
	options: CreateDashboardDecisionInboxOptions = {},
): DashboardDecisionInbox {
	const owned: RunnerDb | null = options.db
		? null
		: openRunnerDb({
				...(options.dbPath !== undefined ? {dbPath: options.dbPath} : {}),
			});
	const db = options.db ?? owned!.db;

	const upsertUnconsumed = db.prepare(`
		INSERT INTO dashboard_decision_inbox (
			athena_session_id,
			request_id,
			decision_json,
			received_at
		)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(athena_session_id, request_id) WHERE consumed_at IS NULL
		DO UPDATE SET
			decision_json = excluded.decision_json,
			received_at = excluded.received_at
	`);
	const selectPending = db.prepare(`
		SELECT id, athena_session_id, request_id, decision_json, received_at
		FROM dashboard_decision_inbox
		WHERE athena_session_id = ? AND consumed_at IS NULL
		ORDER BY id ASC
		LIMIT ?
	`);
	const consume = db.prepare(`
		UPDATE dashboard_decision_inbox
		SET consumed_at = ?
		WHERE id = ?
	`);

	return {
		enqueue(input) {
			upsertUnconsumed.run(
				input.athenaSessionId,
				input.requestId,
				JSON.stringify(input.decision),
				input.receivedAt,
			);
		},
		pendingForSession(input) {
			const rows = selectPending.all(
				input.athenaSessionId,
				input.limit,
			) as Array<{
				id: number;
				athena_session_id: string;
				request_id: string;
				decision_json: string;
				received_at: number;
			}>;
			return rows.map(row => ({
				id: row.id,
				athenaSessionId: row.athena_session_id,
				requestId: row.request_id,
				decision: JSON.parse(row.decision_json) as RuntimeDecision,
				receivedAt: row.received_at,
			}));
		},
		markConsumed(input) {
			consume.run(Date.now(), input.id);
		},
		close() {
			owned?.close();
		},
	};
}
