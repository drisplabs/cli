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
		duplicateActor: false,
		...overrides,
	};
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
	test('omits the actor cell and folds the outcome inline into DETAILS', () => {
		const entry = makeEntry({
			id: 'row-no-actor',
			actor: 'SUBAGENT',
			summaryOutcome: '13 files',
		});
		const line = stripAnsi(rowLine(entry));

		// No standalone ACTOR cell renders the actor name anymore.
		expect(line).not.toContain('SUBAGENT');
		// The non-error outcome survives, folded into the end of DETAILS.
		expect(line).toContain('13 files');
		// Tool label and detail target are still present.
		expect(line).toContain('Read');
		expect(line).toContain('src/app.ts');
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
				summary: 'Read src/missing.ts',
				summarySegments: [
					{role: 'verb', text: 'Read'},
					{role: 'target', text: ' src/missing.ts'},
				],
				summaryOutcome: 'File does not exist',
			});
			const line = rowLine(entry);

			// The inline error message is visible and tinted red.
			expect(stripAnsi(line)).toContain('File does not exist');
			expect(line).toContain(errEscape);
			// The ACTION pill keeps a background fill (its category color), so a
			// failed Read still looks different from a failed Bash — the pill is
			// not flattened to the error red.
			expect(line).toContain('[48;2;');
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
