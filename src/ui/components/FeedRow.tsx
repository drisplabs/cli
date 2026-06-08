import {performance} from 'node:perf_hooks';
import React from 'react';
import {Box, Text} from 'ink';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import {type TimelineEntry} from '../../core/feed/timeline';
import {type Theme} from '../theme/types';
import {parseToolName} from '../../shared/utils/toolNameParser';
import {
	formatGutter,
	formatTime,
	formatTool,
	type ToolPillCategory,
	resolveToolPillCategoryForLabel,
	formatDetails,
} from '../../core/feed/cellFormatters';
import {fitAnsi, spaces} from '../../shared/utils/format';
import {logVisibleRowFormat} from '../../shared/utils/perf';

type FeedColumnWidths = {
	toolW: number;
	detailsW: number;
	gapW: number;
};

type Props = {
	entry: TimelineEntry;
	cols: FeedColumnWidths;
	focused: boolean;
	expanded: boolean;
	matched: boolean;
	ascii: boolean;
	theme: Theme;
};

type FeedRowLineProps = Props & {
	innerWidth: number;
};

const ROW_LINE_CACHE_MAX_VARIANTS = 16;
const ROW_LINE_CACHE_MAX_ENTRIES = 2_000;
const rowLineCache = new Map<
	string,
	{signature: string; variants: Map<string, string>}
>();
const detailSummaryCache = new WeakMap<
	TimelineEntry,
	{segments: TimelineEntry['summarySegments']; summary: string}
>();
const themeIdCache = new WeakMap<Theme, number>();
let nextThemeId = 1;

const BUILTIN_SUBAGENT_LABELS: Record<string, string> = {
	explore: 'Explore',
	plan: 'Plan',
	'general-purpose': 'General Purpose',
	bash: 'Bash',
};

function normalizeSubagentType(type: string): string {
	return type
		.trim()
		.toLowerCase()
		.replace(/[_\s]+/g, '-');
}

function canonicalSubagentLabel(type: string): string {
	return BUILTIN_SUBAGENT_LABELS[normalizeSubagentType(type)] ?? type;
}

function defaultEventPillLabel(opTag: string): string | undefined {
	switch (opTag) {
		case 'msg.user':
		case 'prompt':
			return 'User';
		default:
			return undefined;
	}
}

function getThemeId(theme: Theme): number {
	const cached = themeIdCache.get(theme);
	if (cached !== undefined) return cached;
	const id = nextThemeId++;
	themeIdCache.set(theme, id);
	return id;
}

function getLineCache(entry: TimelineEntry): Map<string, string> {
	const signature = [
		entry.ts,
		entry.op,
		entry.opTag,
		entry.actor,
		entry.actorId,
		entry.toolColumn,
		entry.summary,
		entry.summaryOutcome ?? '',
		entry.summaryOutcomeZero ? 1 : 0,
		entry.error ? 1 : 0,
		entry.expandable ? 1 : 0,
	].join('\u001F');

	const cached = rowLineCache.get(entry.id);
	if (cached && cached.signature === signature) {
		// Promote recently-used rows so oldest entries can be evicted first.
		rowLineCache.delete(entry.id);
		rowLineCache.set(entry.id, cached);
		return cached.variants;
	}

	const created = {signature, variants: new Map<string, string>()};
	rowLineCache.set(entry.id, created);
	if (rowLineCache.size > ROW_LINE_CACHE_MAX_ENTRIES) {
		const oldestEntryId = rowLineCache.keys().next().value;
		if (oldestEntryId !== undefined) {
			rowLineCache.delete(oldestEntryId);
		}
	}
	return created.variants;
}

function trimVerbPrefix(entry: TimelineEntry): {
	segments: TimelineEntry['summarySegments'];
	summary: string;
} {
	const cached = detailSummaryCache.get(entry);
	if (cached) return cached;

	let verbLen = 0;
	const segments: TimelineEntry['summarySegments'] = [];
	for (const segment of entry.summarySegments) {
		if (segment.role === 'verb') {
			verbLen += segment.text.length;
			continue;
		}
		segments.push(segment);
	}
	if (segments.length > 0) {
		const first = segments[0]!;
		const trimmed = first.text.trimStart();
		if (trimmed !== first.text) {
			segments[0] = {...first, text: trimmed};
		}
	}

	const result = {
		segments,
		summary: entry.summary.slice(verbLen).trimStart(),
	};
	detailSummaryCache.set(entry, result);
	return result;
}

function buildLineCacheKey({
	entry,
	cols,
	focused,
	expanded,
	matched,
	ascii,
	theme,
	innerWidth,
}: FeedRowLineProps): string {
	return [
		innerWidth,
		cols.toolW,
		cols.detailsW,
		cols.gapW,
		focused ? 1 : 0,
		expanded ? 1 : 0,
		matched ? 1 : 0,
		ascii ? 1 : 0,
		entry.expandable ? 1 : 0,
		entry.error ? 1 : 0,
		getThemeId(theme),
	].join('|');
}

/** Optionally apply a single color override to a preformatted cell. */
function cell(content: string, overrideColor?: string): string {
	if (!overrideColor) return content;
	return chalk.hex(overrideColor)(stripAnsi(content));
}

function lineParts({
	entry,
	cols,
	focused,
	expanded: _expanded,
	matched,
	ascii,
	theme,
}: Props): {
	gutter: string;
	time: string;
	tool: string;
	detail: string;
} {
	const isUserBorder = entry.opTag === 'prompt' || entry.opTag === 'msg.user';
	// Focus wins over error: a focused row keeps the bright focus styling, an
	// unfocused errored row turns its text cells red.
	const errorActive = entry.error && !focused;
	const rowTextOverrideColor = focused
		? theme.text
		: entry.error
			? theme.status.error
			: undefined;
	const isToolRow =
		entry.opTag.startsWith('tool.') || entry.opTag === 'perm.req';
	const isSubagentRow =
		entry.opTag === 'sub.start' || entry.opTag === 'sub.stop';
	const syntheticLabel =
		entry.toolColumn.length === 0
			? defaultEventPillLabel(entry.opTag)
			: undefined;
	const toolText = isSubagentRow
		? canonicalSubagentLabel(entry.toolColumn)
		: entry.toolColumn || syntheticLabel || '';
	const hasSyntheticPill = syntheticLabel !== undefined;
	const toolCategory: ToolPillCategory = (() => {
		if (isSubagentRow) {
			return entry.opTag === 'sub.stop' ? 'subagent.return' : 'subagent.spawn';
		}
		if (!isToolRow || !entry.feedEvent) return 'neutral';
		if (
			entry.feedEvent.kind === 'tool.pre' ||
			entry.feedEvent.kind === 'tool.post' ||
			entry.feedEvent.kind === 'tool.failure' ||
			entry.feedEvent.kind === 'permission.request'
		) {
			const parsed = parseToolName(entry.feedEvent.data.tool_name);
			const label = entry.toolColumn || parsed.displayName;
			return resolveToolPillCategoryForLabel(label);
		}
		return resolveToolPillCategoryForLabel(toolText);
	})();

	const gutter = cell(
		formatGutter({
			focused,
			matched,
			isUserBorder,
			ascii,
			theme,
		}),
		// Tint the gutter red on an errored row, but never stomp a meaningful
		// glyph: focus keeps its accent border, and a search-match / user-border
		// gutter keeps its own signal color.
		errorActive && !matched && !isUserBorder ? theme.status.error : undefined,
	);
	const time = cell(formatTime(entry.ts, 5, theme), rowTextOverrideColor);
	// The ACTION pill keeps its tool-category color even on an errored row, so
	// you can still tell a failed Read from a failed Bash at a glance.
	const tool = formatTool(toolText, cols.toolW, theme, {
		pill: isToolRow || isSubagentRow || hasSyntheticPill,
		category: toolCategory,
	});

	const detailSummaryInfo = trimVerbPrefix(entry);

	const detail = formatDetails({
		segments: detailSummaryInfo.segments,
		summary: detailSummaryInfo.summary,
		outcome: entry.summaryOutcome,
		outcomeZero: entry.summaryOutcomeZero,
		error: errorActive,
		mode: 'full',
		contentWidth: cols.detailsW,
		theme,
		opTag: entry.opTag,
	});
	return {
		gutter,
		time,
		tool,
		detail,
	};
}

export function formatFeedRowLine({
	innerWidth,
	...props
}: FeedRowLineProps): string {
	const startedAt = performance.now();
	try {
		const cachedLines = getLineCache(props.entry);
		const cacheKey = buildLineCacheKey({...props, innerWidth});
		const cached = cachedLines.get(cacheKey);
		if (cached !== undefined) return cached;

		const parts = lineParts(props);
		const {
			cols: {gapW},
		} = props;

		const line =
			parts.gutter +
			parts.time +
			spaces(gapW) +
			parts.tool +
			spaces(gapW) +
			parts.detail;

		const formatted = fitAnsi(line, innerWidth);
		const focusedFormatted = props.focused
			? fitAnsi(
					chalk.bgHex(props.theme.feed.focusBackground)(formatted),
					innerWidth,
				)
			: formatted;
		cachedLines.set(cacheKey, focusedFormatted);
		if (cachedLines.size > ROW_LINE_CACHE_MAX_VARIANTS) {
			const oldestKey = cachedLines.keys().next().value;
			if (oldestKey !== undefined) {
				cachedLines.delete(oldestKey);
			}
		}
		return focusedFormatted;
	} finally {
		logVisibleRowFormat(performance.now() - startedAt);
	}
}

function FeedRowImpl({
	entry,
	cols,
	focused,
	expanded,
	matched,
	ascii,
	theme,
}: Props) {
	const parts = lineParts({
		entry,
		cols,
		focused,
		expanded,
		matched,
		ascii,
		theme,
	});

	return (
		<>
			<Box width={1} flexShrink={0}>
				<Text wrap="truncate-end">{parts.gutter}</Text>
			</Box>
			<Box width={5} flexShrink={0}>
				<Text wrap="truncate-end">{parts.time}</Text>
			</Box>
			<Box width={cols.gapW} flexShrink={0} />
			<Box width={cols.toolW} flexShrink={0}>
				<Text wrap="truncate-end">{parts.tool}</Text>
			</Box>
			<Box width={cols.gapW} flexShrink={0} />
			<Box width={cols.detailsW} flexShrink={0}>
				<Text wrap="truncate-end">{parts.detail}</Text>
			</Box>
			<Box flexGrow={1} flexShrink={1} />
		</>
	);
}

export const FeedRow = React.memo(FeedRowImpl);

export type {FeedColumnWidths};
