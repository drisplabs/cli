import {buildPostByToolUseId, mergeFeedItems} from '../../core/feed/items';
import {IndexedTimeline} from '../../core/feed/indexedTimeline';
import type {FeedEvent} from '../../core/feed/types';
import type {RuntimeEvent} from '../../core/runtime/types';
import {openSessionDbReadonly} from './sessionDbReader';

export type HookAuditReport = {
	runtimeByHookName: Record<string, number>;
	feedByKind: Record<string, number>;
	visibleNormalByKind: Record<string, number>;
	visibleVerboseByKind: Record<string, number>;
};

function increment(counts: Record<string, number>, key: string): void {
	counts[key] = (counts[key] ?? 0) + 1;
}

function countRuntimeEvents(
	runtimeEvents: ReadonlyArray<Pick<RuntimeEvent, 'hookName'>>,
): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const event of runtimeEvents) increment(counts, event.hookName);
	return counts;
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
	const reader = openSessionDbReadonly(dbPath, {fileMustExist: true});
	try {
		const feedEvents = reader.feedEvents();
		return {
			runtimeByHookName: reader.runtimeHookCounts(),
			feedByKind: countFeedKinds(feedEvents),
			visibleNormalByKind: countVisibleKinds(feedEvents, false),
			visibleVerboseByKind: countVisibleKinds(feedEvents, true),
		};
	} finally {
		reader.close();
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
