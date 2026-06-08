import {useMemo, useRef} from 'react';
import {type TimelineEntry} from '../../core/feed/timeline';
import {startPerfStage} from '../../shared/utils/perf';

export type FeedColumns = {
	toolW: number;
	detailsW: number;
	gapW: number;
};

function areFeedColumnsEqual(left: FeedColumns, right: FeedColumns): boolean {
	return (
		left.toolW === right.toolW &&
		left.detailsW === right.detailsW &&
		left.gapW === right.gapW
	);
}

const GUTTER_W = 1;
const TIME_W = 5;
// Suffix glyph column removed (no chevrons in table rows).
const SUFFIX_W = 0;
/** Fixed non-gap overhead: gutter + time + suffix (ACTOR column removed). */
const BASE_FIXED = GUTTER_W + TIME_W + SUFFIX_W;
// Two gaps remain: time|action and action|details.
const GAP_COUNT = 2;

export function computeFeedColumns(
	entries: TimelineEntry[],
	innerWidth: number,
): FeedColumns {
	let maxToolLen = 0;
	for (const e of entries) {
		const len = e.toolColumn.length;
		if (len > maxToolLen) maxToolLen = len;
	}

	const gapW = innerWidth >= 120 ? 2 : 1;
	// Pill rendering adds visual overhead (" label " padding), so reserve
	// a wider TOOL column to avoid truncating labels like "General Purpose".
	const toolW = Math.min(24, Math.max(12, maxToolLen + 4));
	// DETAILS is the single flex column and absorbs all freed width
	// (the dropped ACTOR + RESULT columns now flow here).
	const fixedWithoutDetails = BASE_FIXED + toolW + GAP_COUNT * gapW;
	const availableForDetails = Math.max(0, innerWidth - fixedWithoutDetails);
	return {
		toolW,
		detailsW: availableForDetails,
		gapW,
	};
}

export function stabilizeFeedColumns(
	previous: FeedColumns,
	next: FeedColumns,
	innerWidth: number,
): FeedColumns {
	const gapW = Math.max(previous.gapW, next.gapW);
	const toolW = Math.max(previous.toolW, next.toolW);
	const fixedWithoutDetails = BASE_FIXED + toolW + GAP_COUNT * gapW;
	const stabilized = {
		toolW,
		detailsW: Math.max(0, innerWidth - fixedWithoutDetails),
		gapW,
	};
	return areFeedColumnsEqual(previous, stabilized) ? previous : stabilized;
}

export function useFeedColumns(
	entries: TimelineEntry[],
	innerWidth: number,
): FeedColumns {
	const cacheRef = useRef<{
		entries: TimelineEntry[];
		innerWidth: number;
		cols: FeedColumns;
	} | null>(null);

	return useMemo(() => {
		const previous = cacheRef.current;
		if (
			!previous ||
			previous.innerWidth !== innerWidth ||
			entries.length < previous.entries.length
		) {
			const done = startPerfStage('feed.columns', {
				op: 'full',
				entries: entries.length,
				inner_width: innerWidth,
			});
			const cols = computeFeedColumns(entries, innerWidth);
			done();
			cacheRef.current = {entries, innerWidth, cols};
			return cols;
		}

		let appendedOnly = true;
		for (let i = 0; i < previous.entries.length; i++) {
			if (previous.entries[i] !== entries[i]) {
				appendedOnly = false;
				break;
			}
		}

		if (!appendedOnly) {
			const done = startPerfStage('feed.columns', {
				op: 'recompute',
				entries: entries.length,
				inner_width: innerWidth,
			});
			const cols = computeFeedColumns(entries, innerWidth);
			done();
			const stableCols = areFeedColumnsEqual(previous.cols, cols)
				? previous.cols
				: cols;
			cacheRef.current = {entries, innerWidth, cols: stableCols};
			return stableCols;
		}

		if (entries.length === previous.entries.length) {
			cacheRef.current = {entries, innerWidth, cols: previous.cols};
			return previous.cols;
		}

		const done = startPerfStage('feed.columns', {
			op: 'append-full',
			entries: entries.length,
			inner_width: innerWidth,
		});
		// Compute from ALL entries so that existing entries whose toolColumn
		// widened after the initial computation (e.g. via paired tool.post
		// merge) are accounted for in toolW.
		const nextCols = computeFeedColumns(entries, innerWidth);
		const cols = stabilizeFeedColumns(previous.cols, nextCols, innerWidth);
		done();
		cacheRef.current = {entries, innerWidth, cols};
		return cols;
	}, [entries, innerWidth]);
}
