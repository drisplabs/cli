import chalk from 'chalk';
import {type Theme} from '../../ui/theme/types';
import {fit as fitImpl, formatClock} from '../../shared/utils/format';
import {getGlyphs} from '../../ui/glyphs/index';
import stripAnsi from 'strip-ansi';

// Re-export fit so all formatter consumers import from one place
export {fit} from '../../shared/utils/format';

function isLifecycleOp(op: string): boolean {
	return (
		op.startsWith('sess.') || op.startsWith('run.') || op.startsWith('stop.')
	);
}

export function opCategoryColor(op: string, theme: Theme): string | undefined {
	if (op === 'tool.fail') return theme.status.error;
	if (op === 'tool.ok') return theme.textMuted;
	if (op.startsWith('tool.')) return theme.textMuted;
	if (op.startsWith('perm.')) return theme.accentSecondary;
	if (op === 'agent.msg') return theme.status.info;
	if (isLifecycleOp(op) || op.startsWith('sub.')) return theme.textMuted;
	return undefined;
}

export type ToolPillCategory = keyof Theme['toolPill'];

const NON_DESTRUCTIVE_TOOL_LABELS = new Set([
	'Read',
	'Grep',
	'Glob',
	'WebFetch',
	'WebSearch',
	'Find',
	'Inspect',
	'Screenshot',
	'Snapshot',
	'FormScan',
	'FieldCtx',
	'ListPages',
	'Ping',
	'Resolve',
	'QueryDocs',
	'AskUser',
	'Task',
	'Agent',
	'TaskOut',
]);

const MUTATING_TOOL_LABELS = new Set([
	'Write',
	'Edit',
	'Notebook',
	'Bash',
	'TodoWrite',
	'TaskStop',
	'PlanMode',
	'Worktree',
	'Cron',
	'Trigger',
]);

const BROWSER_TOOL_LABELS = new Set([
	'Navigate',
	'Click',
	'Type',
	'Press',
	'Select',
	'Hover',
	'Scroll',
	'ScrollTo',
	'Close',
	'ClosePage',
	'Reload',
	'Back',
	'Forward',
]);

export function resolveToolPillCategoryForLabel(
	label: string,
): Exclude<ToolPillCategory, 'subagent.spawn' | 'subagent.return'> {
	if (label === 'Skill') return 'skill';
	if (BROWSER_TOOL_LABELS.has(label)) return 'browser';
	if (MUTATING_TOOL_LABELS.has(label)) return 'mutating';
	if (NON_DESTRUCTIVE_TOOL_LABELS.has(label)) return 'safe';
	return 'neutral';
}

export type FormatGutterOpts = {
	focused: boolean;
	matched: boolean;
	isUserBorder: boolean;
	ascii: boolean;
	theme: Theme;
};

export function formatGutter(opts: FormatGutterOpts): string {
	const {focused, matched, isUserBorder, ascii, theme} = opts;
	const g = getGlyphs(ascii);

	if (focused) {
		return chalk.hex(theme.accent)(g['feed.focusBorder']);
	}
	if (matched) {
		return chalk.hex(theme.accent)(g['feed.searchMatch']);
	}
	if (isUserBorder) {
		return chalk.hex(theme.userMessage.border)(g['feed.userBorder']);
	}
	return ' ';
}

export function formatTime(
	ts: number,
	contentWidth: number,
	theme: Theme,
): string {
	const clock = formatClock(ts);
	return chalk.hex(theme.textMuted)(fitImpl(clock, contentWidth));
}

export function formatTool(
	toolColumn: string,
	contentWidth: number,
	theme: Theme,
	options?: {
		pill?: boolean;
		category?: ToolPillCategory;
	},
): string {
	if (contentWidth <= 0) return '';
	if (!toolColumn) return fitImpl('', contentWidth);

	if (!options || options.pill !== true) {
		return chalk.hex(theme.textMuted)(fitImpl(toolColumn, contentWidth));
	}

	const category = options.category ?? 'neutral';
	const palette = theme.toolPill[category];
	if (contentWidth < 4) {
		return chalk.hex(palette.fg)(fitImpl(toolColumn, contentWidth));
	}

	// Fixed-width pill without bracket caps. Keep plain trailing padding so
	// adjacent rows don't visually fuse into a single vertical block.
	const maxLabelWidth = Math.max(1, contentWidth - 4); // pill padding (2) + min 2 trailing
	const label = fitImpl(toolColumn, maxLabelWidth).trimEnd();
	const trailingPad = ' '.repeat(Math.max(0, contentWidth - 2 - label.length));
	const pill = chalk.bgHex(palette.bg).hex(palette.fg)(` ${label} `);
	return `${pill}${trailingPad}`;
}

export function formatSuffix(
	expandable: boolean,
	_expanded: boolean,
	_ascii: boolean,
	_theme: Theme,
): string {
	if (!expandable) return '  ';
	return '  ';
}

export function buildDetailsPrefix(
	mode: 'full' | 'compact' | 'narrow',
	toolColumn: string | undefined,
	actorStr: string | undefined,
	theme: Theme,
): {text: string; length: number} {
	if (mode === 'full') return {text: '', length: 0};

	let prefix = '';

	// Narrow: actor comes first
	if (mode === 'narrow' && actorStr) {
		prefix += chalk.hex(theme.textMuted)(fitImpl(actorStr, 10)) + ' ';
	}

	// Compact & narrow: tool as bright prefix
	if (toolColumn) {
		prefix += chalk.hex(theme.text)(toolColumn) + '  ';
	}

	if (!prefix) return {text: '', length: 0};
	return {text: prefix, length: stripAnsi(prefix).length};
}

export function layoutTargetAndOutcome(
	target: string,
	outcomeStr: string | undefined,
	width: number,
): string {
	if (width <= 0) return '';
	if (!outcomeStr) {
		return fitImpl(target, width);
	}

	const outcomeLen = outcomeStr.length;
	const targetBudget = width - outcomeLen - 2; // 2 = minimum gap

	// Not enough room to separate — inline fallback
	if (targetBudget < 10) {
		return fitImpl(`${target}  ${outcomeStr}`, width);
	}

	// Right-align outcome
	const fittedTarget = fitImpl(target, targetBudget);
	const padNeeded = width - fittedTarget.length - outcomeLen;
	const padding = padNeeded > 0 ? ' '.repeat(padNeeded) : '  ';
	return fittedTarget + padding + outcomeStr;
}

// ── Internal: render segments with role-based styling ────────

import type {SummarySegment, SummarySegmentRole} from './timeline';

function renderSegments(
	segments: SummarySegment[],
	summary: string,
	width: number,
	theme: Theme,
	opTag: string,
	error = false,
): string {
	if (width <= 0) return '';
	const normalizePathPrefix = (text: string): string =>
		text.replace(/(^|\s)(?:\u2026\/|\.{3}\/)/g, '$1/');
	if (segments.length === 0) {
		const fitted = fitImpl(normalizePathPrefix(summary), width);
		return error ? chalk.hex(theme.status.error)(fitted) : fitted;
	}

	const isAgentMsg = opTag === 'agent.msg';
	const isSubReturn = opTag === 'sub.stop';
	const isLifecycle = isLifecycleOp(opTag);
	const baseColor = isAgentMsg
		? theme.status.info
		: isLifecycle || isSubReturn
			? theme.textMuted
			: theme.text;
	// An errored row paints every segment red and never dims, so the failure
	// is unmissable regardless of the row's normal tool-category styling.
	const shouldDim = !error && (isAgentMsg || isLifecycle);
	const hasFilename = segments.some(seg => seg.role === 'filename');

	const roleColor = (role: SummarySegmentRole): string => {
		if (error) return theme.status.error;
		switch (role) {
			case 'verb':
				return baseColor;
			case 'target':
				return hasFilename ? theme.textMuted : baseColor;
			case 'filename':
				return theme.text;
			case 'outcome':
				return theme.textMuted;
			case 'plain':
				return baseColor;
		}
	};

	let result = '';
	let usedWidth = 0;
	for (const seg of segments) {
		if (usedWidth >= width) break;
		const remaining = width - usedWidth;
		const normalizedText = normalizePathPrefix(seg.text);
		const text =
			normalizedText.length > remaining
				? fitImpl(normalizedText, remaining)
				: normalizedText;
		const styled = chalk.hex(roleColor(seg.role))(text);
		result += shouldDim ? chalk.dim(styled) : styled;
		usedWidth += text.length;
	}

	// Pad to width
	if (usedWidth < width) {
		result += ' '.repeat(width - usedWidth);
	}
	return result;
}

// ── Internal: style outcome string ──────────────────────────

function renderOutcome(
	outcome: string | undefined,
	outcomeZero: boolean | undefined,
	theme: Theme,
	error = false,
): string | undefined {
	if (!outcome) return undefined;
	if (error) return chalk.hex(theme.status.error)(outcome);
	if (outcomeZero) return chalk.hex(theme.status.warning)(outcome);
	return chalk.hex(theme.textMuted)(outcome);
}

export type FormatDetailsOpts = {
	segments: SummarySegment[];
	summary: string;
	outcome?: string;
	outcomeZero?: boolean;
	mode: 'full' | 'compact' | 'narrow';
	toolColumn?: string;
	actorStr?: string;
	contentWidth: number;
	theme: Theme;
	opTag: string;
	/** When set, segments and the inline outcome are tinted with the error color. */
	error?: boolean;
};

export function formatDetails(opts: FormatDetailsOpts): string {
	const {
		segments,
		summary,
		outcome,
		outcomeZero,
		mode,
		toolColumn,
		actorStr,
		contentWidth,
		theme,
		opTag,
		error = false,
	} = opts;

	// Step 1: merged-column prefix
	const prefix = buildDetailsPrefix(mode, toolColumn, actorStr, theme);
	const innerWidth = Math.max(0, contentWidth - prefix.length);

	// Step 2: render outcome
	const outcomeStr = renderOutcome(outcome, outcomeZero, theme, error);
	const outcomeClean = outcomeStr ? stripAnsi(outcomeStr) : undefined;

	// Step 3: if no outcome, just render segments into innerWidth
	if (!outcomeStr || innerWidth <= 0) {
		return (
			prefix.text +
			renderSegments(segments, summary, innerWidth, theme, opTag, error)
		);
	}

	// Step 4: lay out target + outcome with right-alignment
	const outcomeLen = outcomeClean!.length;
	const targetBudget = innerWidth - outcomeLen - 2;
	if (targetBudget < 10) {
		// Inline: outcome wins the tail, segments truncate first. Color is
		// dropped here because the pieces are re-fitted from stripped text.
		const segStr = renderSegments(
			segments,
			summary,
			Math.max(0, innerWidth - outcomeLen - 2),
			theme,
			opTag,
			error,
		);
		const segClean = stripAnsi(segStr).trimEnd();
		const padNeeded = innerWidth - segClean.length - outcomeLen;
		const pad = padNeeded >= 2 ? ' '.repeat(padNeeded) : '  ';
		const truncated = fitImpl(
			segClean + pad + stripAnsi(outcomeStr),
			innerWidth,
		);
		// Re-apply the error tint the strip+refit above discarded, so a narrow
		// errored row stays unmistakably red. Only the segment+outcome run is
		// tinted; the merged-column prefix keeps its own color regardless of
		// mode (it is empty in full mode, the only mode that sets `error`).
		return (
			prefix.text +
			(error ? chalk.hex(theme.status.error)(truncated) : truncated)
		);
	}

	const segStr = renderSegments(
		segments,
		summary,
		targetBudget,
		theme,
		opTag,
		error,
	);
	const segClean = stripAnsi(segStr);
	const padNeeded = innerWidth - segClean.length - outcomeLen;
	const pad = padNeeded > 0 ? ' '.repeat(padNeeded) : '  ';
	return prefix.text + segStr + pad + outcomeStr;
}
