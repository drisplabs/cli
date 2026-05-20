import Database from 'better-sqlite3';
import {buildPostByToolUseId, mergeFeedItems} from '../../core/feed/items';
import {IndexedTimeline} from '../../core/feed/indexedTimeline';
import type {FeedEvent} from '../../core/feed/types';
import type {RuntimeEvent} from '../../core/runtime/types';

export type HookAuditReport = {
	runtimeByHookName: Record<string, number>;
	feedByKind: Record<string, number>;
	visibleNormalByKind: Record<string, number>;
	visibleVerboseByKind: Record<string, number>;
};

function increment(counts: Record<string, number>, key: string): void {
	counts[key] = (counts[key] ?? 0) + 1;
}

function countRuntimeRows(db: Database.Database): Record<string, number> {
	const rows = db
		.prepare(
			'SELECT hook_name, COUNT(*) AS count FROM runtime_events GROUP BY hook_name',
		)
		.all() as Array<{hook_name: string; count: number}>;
	const counts: Record<string, number> = {};
	for (const row of rows) counts[row.hook_name] = row.count;
	return counts;
}

function countRuntimeEvents(
	runtimeEvents: ReadonlyArray<Pick<RuntimeEvent, 'hookName'>>,
): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const event of runtimeEvents) increment(counts, event.hookName);
	return counts;
}

function readFeedEvents(db: Database.Database): FeedEvent[] {
	const rows = db
		.prepare('SELECT data FROM feed_events ORDER BY seq')
		.all() as Array<{
		data: string;
	}>;
	return rows.map(row => JSON.parse(row.data) as FeedEvent);
}

function countFeedKinds(feedEvents: FeedEvent[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const event of feedEvents) increment(counts, event.kind);
	return counts;
}

function countVisibleKinds(
	feedEvents: FeedEvent[],
	verbose: boolean,
): Record<string, number> {
	const timeline = new IndexedTimeline();
	timeline.update(
		mergeFeedItems([], feedEvents),
		feedEvents,
		buildPostByToolUseId(feedEvents),
		verbose,
	);
	const counts: Record<string, number> = {};
	for (const entry of timeline.getEntries()) {
		if (entry.feedEvent) increment(counts, entry.feedEvent.kind);
	}
	return counts;
}

/**
 * Audits a persisted session database. This is intended for closed sessions or
 * readable DB snapshots; live session stores can hold an exclusive SQLite lock.
 */
export function auditSessionHookPipeline(dbPath: string): HookAuditReport {
	const db = new Database(dbPath, {readonly: true, fileMustExist: true});
	try {
		const feedEvents = readFeedEvents(db);
		return {
			runtimeByHookName: countRuntimeRows(db),
			feedByKind: countFeedKinds(feedEvents),
			visibleNormalByKind: countVisibleKinds(feedEvents, false),
			visibleVerboseByKind: countVisibleKinds(feedEvents, true),
		};
	} finally {
		db.close();
	}
}

/**
 * Audits an already materialized runtime/feed snapshot, including the same
 * timeline visibility rules used by the TUI. Use this for live sessions; the
 * persisted DB audit can be blocked by the writer's SQLite lock.
 */
export function auditHookPipelineSnapshot(args: {
	runtimeEvents: ReadonlyArray<Pick<RuntimeEvent, 'hookName'>>;
	feedEvents: readonly FeedEvent[];
}): HookAuditReport {
	const feedEvents = [...args.feedEvents];
	return {
		runtimeByHookName: countRuntimeEvents(args.runtimeEvents),
		feedByKind: countFeedKinds(feedEvents),
		visibleNormalByKind: countVisibleKinds(feedEvents, false),
		visibleVerboseByKind: countVisibleKinds(feedEvents, true),
	};
}
