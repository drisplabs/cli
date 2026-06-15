import {describe, test, expect} from 'vitest';
import stripAnsi from 'strip-ansi';
import chalk from 'chalk';
import {darkTheme} from '../theme/themes';
import type {TimelineEntry} from '../../core/feed/timeline';
import {formatFeedRowLine, type FeedColumnWidths} from './FeedRow';
import {formatFeedHeaderLine} from './FeedHeader';

const theme = darkTheme;

const cols: FeedColumnWidths = {
	toolW: 12,
	detailsW: 50,
	gapW: 2,
};

function makeEntry(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
	return {
		id: 'row',
		ts: new Date('2025-06-15T14:30:00').getTime(),
		op: 'Tool OK',
		opTag: 'tool.ok',
		actor: 'AGENT',
		actorId: 'agent:root',
		toolColumn: 'Read',
		summary: 'Read src/app.ts',
		summarySegments: [
			{role: 'verb', text: 'Read'},
			{role: 'target', text: ' src/app.ts'},
		],
		searchText: 'read src/app.ts',
		error: false,
		expandable: false,
		details: '',
		...overrides,
	};
}

/**
 * A minimal tool.failure feed event — enough for the row's pill-category
 * resolution, which only reads `kind` and `data.tool_name`.
 */
function toolFailureEvent(toolName: string): TimelineEntry['feedEvent'] {
	return {
		kind: 'tool.failure',
		data: {tool_name: toolName, tool_input: {}, error: 'boom'},
	} as unknown as TimelineEntry['feedEvent'];
}

function rowLine(
	entry: TimelineEntry,
	overrides: Partial<Parameters<typeof formatFeedRowLine>[0]> = {},
): string {
	return formatFeedRowLine({
		entry,
		cols,
		focused: false,
		expanded: false,
		matched: false,
		ascii: true,
		theme,
		innerWidth: 80,
		...overrides,
	});
}

describe('formatFeedHeaderLine', () => {
	test('reads TIME · ACTION · DETAILS with no ACTOR or RESULT labels', () => {
		const line = stripAnsi(formatFeedHeaderLine(cols, theme, 80));

		expect(line).toContain('TIME');
		expect(line).toContain('ACTION');
		expect(line).toContain('DETAILS');
		expect(line).not.toContain('ACTOR');
		expect(line).not.toContain('RESULT');

		// Left-to-right order is TIME, then ACTION, then DETAILS.
		expect(line.indexOf('TIME')).toBeLessThan(line.indexOf('ACTION'));
		expect(line.indexOf('ACTION')).toBeLessThan(line.indexOf('DETAILS'));
	});
});

describe('formatFeedRowLine', () => {
	test('omits the actor cell and non-error result tail', () => {
		const entry = makeEntry({
			id: 'row-no-actor',
			actor: 'SUBAGENT',
			summaryOutcome: '13 files',
		});
		const line = stripAnsi(rowLine(entry));

		// No standalone ACTOR cell renders the actor name anymore.
		expect(line).not.toContain('SUBAGENT');
		// Successful result summaries stay out of the feed row.
		expect(line).not.toContain('13 files');
		// Tool label and detail target are still present.
		expect(line).toContain('Read');
		expect(line).toContain('src/app.ts');
	});

	test('adds an ellipsis when the details cell is clipped', () => {
		const entry = makeEntry({
			id: 'row-ellipsis',
			summary:
				'Read src/features/feed/very-long-file-name-that-will-not-fit.ts',
			summarySegments: [
				{role: 'verb', text: 'Read'},
				{
					role: 'target',
					text: ' src/features/feed/very-long-file-name-that-will-not-fit.ts',
				},
			],
		});
		const line = stripAnsi(rowLine(entry, {cols: {...cols, detailsW: 24}}));

		expect(line).toContain('src/features/feed/ver...');
	});

	test('an errored row reds the gutter/time/details but keeps the ACTION pill color', () => {
		const prevLevel = chalk.level;
		chalk.level = 3;
		try {
			const errEscape = chalk.hex(theme.status.error)('§').split('§')[0]!;
			const entry = makeEntry({
				id: 'row-error',
				opTag: 'tool.fail',
				error: true,
				feedEvent: toolFailureEvent('Read'),
				summary: 'Read src/missing.ts',
				summarySegments: [
					{role: 'verb', text: 'Read'},
					{role: 'target', text: ' src/missing.ts'},
				],
				summaryOutcome: 'File does not exist',
			});
			const line = rowLine(entry);

			const safeBg = chalk.bgHex(theme.toolPill.safe.bg)('§').split('§')[0]!;
			// The inline error message is visible and tinted red.
			expect(stripAnsi(line)).toContain('File does not exist');
			expect(line).toContain(errEscape);
			// The ACTION pill keeps its category background ('safe' for Read), so
			// it is not flattened to the error red.
			expect(line).toContain(safeBg);
		} finally {
			chalk.level = prevLevel;
		}
	});

	test('a failed Read and a failed Bash keep distinct ACTION pill colors', () => {
		const prevLevel = chalk.level;
		chalk.level = 3;
		try {
			const safeBg = chalk.bgHex(theme.toolPill.safe.bg)('§').split('§')[0]!;
			const mutatingBg = chalk
				.bgHex(theme.toolPill.mutating.bg)('§')
				.split('§')[0]!;
			const read = rowLine(
				makeEntry({
					id: 'fail-read',
					opTag: 'tool.fail',
					error: true,
					toolColumn: 'Read',
					feedEvent: toolFailureEvent('Read'),
				}),
			);
			const bash = rowLine(
				makeEntry({
					id: 'fail-bash',
					opTag: 'tool.fail',
					error: true,
					toolColumn: 'Bash',
					feedEvent: toolFailureEvent('Bash'),
				}),
			);

			// Even errored, a Read pill (safe) is a different color from a Bash
			// pill (mutating) — the category survives the error styling.
			expect(read).toContain(safeBg);
			expect(read).not.toContain(mutatingBg);
			expect(bash).toContain(mutatingBg);
			expect(bash).not.toContain(safeBg);
		} finally {
			chalk.level = prevLevel;
		}
	});

	test('error red does not clobber the search-match gutter glyph', () => {
		const prevLevel = chalk.level;
		chalk.level = 3;
		try {
			const accentEscape = chalk.hex(theme.accent)('§').split('§')[0]!;
			const entry = makeEntry({
				id: 'row-error-matched',
				opTag: 'tool.fail',
				error: true,
				summaryOutcome: 'File does not exist',
			});
			const line = rowLine(entry, {matched: true});

			// The match glyph keeps its accent "search hit" color even though the
			// rest of the row is errored-red.
			expect(line).toContain(accentEscape);
		} finally {
			chalk.level = prevLevel;
		}
	});

	test('a focused errored row uses focus styling instead of error red', () => {
		const prevLevel = chalk.level;
		chalk.level = 3;
		try {
			const errEscape = chalk.hex(theme.status.error)('§').split('§')[0]!;
			const focusBg = chalk
				.bgHex(theme.feed.focusBackground)('§')
				.split('§')[0]!;
			const entry = makeEntry({
				id: 'row-error-focused',
				opTag: 'tool.fail',
				error: true,
				summary: 'Read src/missing.ts',
				summarySegments: [
					{role: 'verb', text: 'Read'},
					{role: 'target', text: ' src/missing.ts'},
				],
				summaryOutcome: 'File does not exist',
			});
			const line = rowLine(entry, {focused: true});

			// Focus highlight takes over; no error-red foreground remains.
			expect(line).toContain(focusBg);
			expect(line).not.toContain(errEscape);
		} finally {
			chalk.level = prevLevel;
		}
	});
});
