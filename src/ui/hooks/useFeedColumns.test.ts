/** @vitest-environment jsdom */
import {describe, it, expect} from 'vitest';
import {renderHook} from '@testing-library/react';
import {
	computeFeedColumns,
	stabilizeFeedColumns,
	useFeedColumns,
} from './useFeedColumns';
import type {TimelineEntry} from '../../core/feed/timeline';

function makeEntry(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
	return {
		id: 'e1',
		ts: Date.now(),
		op: 'Tool OK',
		opTag: 'tool.ok',
		actor: 'AGENT',
		actorId: 'agent:root',
		toolColumn: 'Read',
		summary: 'Read src/app.ts',
		summarySegments: [{text: 'Read', role: 'verb'}],
		searchText: 'read src/app.ts',
		error: false,
		expandable: false,
		details: '',
		duplicateActor: false,
		...overrides,
	};
}

describe('useFeedColumns', () => {
	it('drops the RESULT column and folds its width into DETAILS', () => {
		const entries = [makeEntry({summaryOutcome: 'exit 1'})];
		const {result} = renderHook(() => useFeedColumns(entries, 160));

		// RESULT is no longer a separate column.
		expect(result.current).not.toHaveProperty('resultW');
		expect(result.current).not.toHaveProperty('detailsResultGapW');

		// Fixed overhead is gutter(1) + time(5) + toolW + 2 gaps; DETAILS
		// absorbs everything else (no ACTOR_W, no RESULT column).
		// gapW is 2 at innerWidth 160; toolW for "Read" is 12.
		expect(result.current.gapW).toBe(2);
		expect(result.current.toolW).toBe(12);
		expect(result.current.detailsW).toBe(160 - (1 + 5) - 12 - 2 * 2);
	});

	it('uses two gaps (time|action and action|details) and no actor column', () => {
		const entries = [makeEntry()];
		const {result} = renderHook(() => useFeedColumns(entries, 260));

		// gutter(1) + time(5) + toolW + 2 gaps; no ACTOR_W, no RESULT column.
		const {toolW, gapW, detailsW} = result.current;
		expect(detailsW).toBe(260 - (1 + 5) - toolW - 2 * gapW);
	});

	it('does not carry RESULT-related widths regardless of outcome presence', () => {
		const withOutcome = renderHook(() =>
			useFeedColumns([makeEntry({summaryOutcome: 'exit 1'})], 160),
		);
		const withoutOutcome = renderHook(() => useFeedColumns([makeEntry()], 160));

		for (const r of [withOutcome.result, withoutOutcome.result]) {
			expect(r.current).not.toHaveProperty('resultW');
			expect(r.current).not.toHaveProperty('detailsResultGapW');
		}
		// An outcome no longer steals width from DETAILS — it is folded inline.
		expect(withOutcome.result.current.detailsW).toBe(
			withoutOutcome.result.current.detailsW,
		);
	});

	it('keeps live feed columns monotonic while scrollback is active', () => {
		const previous = computeFeedColumns(
			[makeEntry({toolColumn: 'General Purpose'})],
			160,
		);
		const next = computeFeedColumns([makeEntry({toolColumn: 'Read'})], 160);
		const stabilized = stabilizeFeedColumns(previous, next, 160);

		// Wider TOOL column must not shrink, so DETAILS must not grow.
		expect(stabilized.toolW).toBe(previous.toolW);
		expect(stabilized.detailsW).toBeLessThanOrEqual(previous.detailsW);
	});

	it('returns the previous object identity when a narrower next collapses back', () => {
		// `next` genuinely differs (narrower TOOL column), but max()-stabilization
		// collapses it back to `previous`, so the same object must be returned
		// (no churn for memoized consumers).
		const previous = computeFeedColumns(
			[makeEntry({toolColumn: 'General Purpose'})],
			160,
		);
		const next = computeFeedColumns([makeEntry({toolColumn: 'Read'})], 160);
		expect(next.toolW).toBeLessThan(previous.toolW);

		const stabilized = stabilizeFeedColumns(previous, next, 160);
		expect(stabilized).toBe(previous);
	});

	it('reuses the previous column object when a patched row does not change widths', () => {
		const initialEntries = [makeEntry({id: 'e1', summary: 'Read src/app.ts'})];
		const {result, rerender} = renderHook(
			({entries}) => useFeedColumns(entries, 160),
			{initialProps: {entries: initialEntries}},
		);

		const initialCols = result.current;
		const patchedEntries = [
			makeEntry({
				id: 'e1',
				summary: 'Read src/app.js',
			}),
		];

		rerender({entries: patchedEntries});

		expect(result.current).toBe(initialCols);
	});
});
