import Database from 'better-sqlite3';
import type {RuntimeDecision} from '../../core/runtime/types';
import {ensureDaemonStateDir} from '../../infra/daemon/stateDir';

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

export type CreateDashboardDecisionInboxOptions = {
	dbPath?: string;
};

function dashboardDecisionInboxPath(): string {
	return `${ensureDaemonStateDir().dir}/dashboard-decision-inbox.db`;
}

function hasLegacyUniqueConstraint(db: Database.Database): boolean {
	const rows = db
		.prepare(`PRAGMA index_list('dashboard_decision_inbox')`)
		.all() as Array<{unique: number; origin: string}>;
	return rows.some(row => row.unique === 1 && row.origin === 'u');
}

function migrateLegacyUniqueConstraint(db: Database.Database): void {
	if (!hasLegacyUniqueConstraint(db)) return;
	db.exec(`
		ALTER TABLE dashboard_decision_inbox
			RENAME TO dashboard_decision_inbox_legacy;

		CREATE TABLE dashboard_decision_inbox (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			athena_session_id TEXT NOT NULL,
			request_id TEXT NOT NULL,
			decision_json TEXT NOT NULL,
			received_at INTEGER NOT NULL,
			consumed_at INTEGER
		);

		INSERT INTO dashboard_decision_inbox (
			id,
			athena_session_id,
			request_id,
			decision_json,
			received_at,
			consumed_at
		)
		SELECT
			id,
			athena_session_id,
			request_id,
			decision_json,
			received_at,
			consumed_at
		FROM dashboard_decision_inbox_legacy;

		DROP TABLE dashboard_decision_inbox_legacy;
	`);
}

function initInboxSchema(db: Database.Database): void {
	db.exec(`
		PRAGMA journal_mode = WAL;

		CREATE TABLE IF NOT EXISTS dashboard_decision_inbox (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			athena_session_id TEXT NOT NULL,
			request_id TEXT NOT NULL,
			decision_json TEXT NOT NULL,
			received_at INTEGER NOT NULL,
			consumed_at INTEGER
		);
	`);

	migrateLegacyUniqueConstraint(db);

	db.exec(`

		CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_decision_unconsumed
			ON dashboard_decision_inbox(athena_session_id, request_id)
			WHERE consumed_at IS NULL;

		CREATE INDEX IF NOT EXISTS idx_dashboard_decision_pending
			ON dashboard_decision_inbox(athena_session_id, consumed_at, id);
	`);
}

export function createDashboardDecisionInbox(
	options: CreateDashboardDecisionInboxOptions = {},
): DashboardDecisionInbox {
	const db = new Database(options.dbPath ?? dashboardDecisionInboxPath());
	initInboxSchema(db);

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
			db.close();
		},
	};
}
