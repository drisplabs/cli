/**
 * Journal reader — the read-only inspector for the Turn Protocol.
 *
 * Athena spawns `claude -p` Turns in a loop. The agent owns the Journal file
 * (creates/updates it); the Runner only reads it between Turns to learn the
 * Journal's end state. This module is that inspector: pure functions that turn
 * Journal text into a {@link JournalState}, plus the Terminal Marker constants
 * and the Continue Prompt.
 *
 * It holds no loop state of its own. The Iteration counter lives on the Runner
 * (a single source of truth — see `workflowRunner.ts`), and the mapping from a
 * Journal end-state to a Run Status lives in `terminalOutcome.ts`.
 *
 * Deprecated spellings (#185): the Journal was the "Tracker" and the
 * needs-a-human marker was `WORKFLOW_BLOCKED` before 0.6. Both are still
 * recognised here for one release and reported as deprecated; they are
 * removed in {@link DEPRECATION_REMOVAL_RELEASE}.
 */

import fs from 'node:fs';
import path from 'node:path';
import type {LoopConfig} from './types';
import {substituteVariables} from './templateVars';

/** The release that removes every name deprecated by #185. */
export const DEPRECATION_REMOVAL_RELEASE = '0.7.0';

export const DEFAULT_COMPLETION_MARKER = '<!-- WORKFLOW_COMPLETE -->';
/**
 * The one way a Turn asks for a person: `<!-- NEEDS_HUMAN: reason -->` as the
 * Journal's final non-empty line. Matches the `needs_human` frame in
 * `@drisp/protocol`.
 */
export const DEFAULT_NEEDS_HUMAN_MARKER = '<!-- NEEDS_HUMAN';
/**
 * @deprecated Pre-0.6 spelling of {@link DEFAULT_NEEDS_HUMAN_MARKER}. Still
 * parsed as a needs-human Terminal Marker; `JournalState.deprecatedMarker`
 * reports it so the Runner can log a deprecation. Removed in 0.7.0.
 */
export const LEGACY_BLOCKED_MARKER = '<!-- WORKFLOW_BLOCKED';

export const DEFAULT_JOURNAL_PATH = '.athena/{sessionId}/journal.md';
/**
 * @deprecated Pre-0.6 default Journal filename. A Dossier that already holds
 * one (and no `journal.md`) keeps being read from it — see
 * `resolveJournalPath`. Removed in 0.7.0.
 */
export const LEGACY_JOURNAL_FILENAME = 'tracker.md';

export const JOURNAL_SKELETON_MARKER = '<!-- JOURNAL_SKELETON -->';
/**
 * @deprecated Pre-0.6 skeleton sentinel. Still treated as an unreplaced
 * skeleton wherever it appears. Removed in 0.7.0.
 */
export const LEGACY_TRACKER_SKELETON_MARKER = '<!-- TRACKER_SKELETON -->';

/**
 * Backstop for shedding a long single unit's completed detail into the
 * Dossier (ADR 0015 §3) — "roughly 32,000 characters", not a target to
 * design toward. Distinct from {@link DEFAULT_MAX_TURN_TOKEN_COUNT} in
 * `types.ts`, which bounds a Turn's conversation window; this bounds the
 * Journal file's own size.
 */
export const DEFAULT_JOURNAL_TOKEN_BOUND = 8000;

const DEFAULT_CONTINUE_PROMPT =
	'Continue the task. Read the journal at {journalPath} for current progress. If the work is complete or you need a human, the terminal marker must be the final non-empty line of the journal; do not write any prose after it.';

/** The Terminal Markers that resolve a Workflow Run, as configured for a loop. */
export type JournalMarkers = Pick<
	LoopConfig,
	'completionMarker' | 'needsHumanMarker' | 'blockedMarker'
>;

/**
 * What the Journal's text says about the Workflow Run's progress — the part of
 * the terminal outcome that is a pure function of the Journal file. The
 * Iteration count and its limit are owned by the Runner, not derived here.
 */
export type JournalState = {
	/** The last non-empty line is the completion Terminal Marker. */
	completed: boolean;
	/** The last non-empty line is a needs-human Terminal Marker. */
	needsHuman: boolean;
	/** Reason parsed from a needs-human Terminal Marker, when present. */
	needsHumanReason?: string;
	/** A Terminal Marker appears, but not as the final non-empty line. */
	misplacedTerminalMarker?: string;
	/** The runner's Skeleton is still present — Orient never replaced it. */
	skeletonNotReplaced: boolean;
	/**
	 * The deprecated marker spelling the terminal line used, when it did
	 * (`LEGACY_BLOCKED_MARKER`). Absent for the current spelling.
	 */
	deprecatedMarker?: string;
};

/** The configured needs-human marker, honouring the deprecated `blockedMarker` key. */
export function loopNeedsHumanMarker(markers: JournalMarkers): string {
	return (
		markers.needsHumanMarker ??
		markers.blockedMarker ??
		DEFAULT_NEEDS_HUMAN_MARKER
	);
}

/** The configured Journal path template, honouring the deprecated `trackerPath` key. */
export function loopJournalPath(
	loop: Pick<LoopConfig, 'journalPath' | 'trackerPath'>,
): string {
	return loop.journalPath ?? loop.trackerPath ?? DEFAULT_JOURNAL_PATH;
}

/**
 * Every marker prefix accepted as "the agent needs a human": the workflow's
 * own (if any), the canonical `NEEDS_HUMAN`, and — for one release — the
 * legacy `WORKFLOW_BLOCKED`. Order matters: the first match wins, so a
 * workflow that explicitly configures the legacy spelling still sees it
 * reported as deprecated.
 */
function needsHumanMarkersFor(markers: JournalMarkers): string[] {
	return [
		...new Set([
			loopNeedsHumanMarker(markers),
			DEFAULT_NEEDS_HUMAN_MARKER,
			LEGACY_BLOCKED_MARKER,
		]),
	];
}

/** Whether the content still carries a runner skeleton sentinel (current or legacy). */
export function hasSkeletonMarker(content: string): boolean {
	return (
		content.includes(JOURNAL_SKELETON_MARKER) ||
		content.includes(LEGACY_TRACKER_SKELETON_MARKER)
	);
}

/** The deprecation notice the Runner logs when a Turn used a deprecated marker. */
export function buildMarkerDeprecation(deprecatedMarker: string): string {
	const name = deprecatedMarker.replace(/^<!--\s*/, '').replace(/:?$/, '');
	return `${name} is deprecated and is removed in ${DEPRECATION_REMOVAL_RELEASE}; declare NEEDS_HUMAN: <reason> as the journal's final non-empty line instead.`;
}

/** Read the Journal file, failing open to empty content when it is unreadable. */
export function readJournal(journalPath: string): string {
	try {
		return fs.readFileSync(journalPath, 'utf-8');
	} catch {
		return '';
	}
}

function getNonEmptyLines(content: string): string[] {
	return content
		.trimEnd()
		.split('\n')
		.map(line => line.trim())
		.filter(line => line.length > 0);
}

function isNeedsHumanLine(line: string, marker: string): boolean {
	return line === `${marker} -->` || line.startsWith(`${marker}:`);
}

/** The needs-human marker prefix the line declares, if any. */
function matchNeedsHumanMarker(
	line: string,
	markers: string[],
): string | undefined {
	return markers.find(marker => isNeedsHumanLine(line, marker));
}

function isTerminalMarkerLine(
	line: string,
	completionMarker: string,
	needsHumanMarkers: string[],
): boolean {
	return (
		line === completionMarker ||
		matchNeedsHumanMarker(line, needsHumanMarkers) !== undefined
	);
}

function getMisplacedTerminalMarker(
	lines: string[],
	completionMarker: string,
	needsHumanMarkers: string[],
): string | undefined {
	if (lines.length < 2) return undefined;
	const terminalLine = lines.at(-1);
	if (
		terminalLine &&
		isTerminalMarkerLine(terminalLine, completionMarker, needsHumanMarkers)
	) {
		return undefined;
	}
	return lines
		.slice(0, -1)
		.find(line =>
			isTerminalMarkerLine(line, completionMarker, needsHumanMarkers),
		);
}

function extractNeedsHumanReason(
	line: string,
	marker: string,
): string | undefined {
	if (!line.startsWith(marker)) return undefined;
	const afterMarker = line.slice(marker.length);
	const match = afterMarker.match(/^:\s*(.+?)(?:\s*-->|$)/);
	return match?.[1]?.trim();
}

/**
 * Parse raw Journal text into a {@link JournalState}. Only the last non-empty
 * line is an authoritative Terminal Marker; a marker anywhere above it is
 * reported as misplaced rather than terminal.
 */
export function parseJournalState(
	content: string,
	markers: JournalMarkers = {},
): JournalState {
	const completionMarker =
		markers.completionMarker ?? DEFAULT_COMPLETION_MARKER;
	const needsHumanMarkers = needsHumanMarkersFor(markers);

	const lines = getNonEmptyLines(content);
	const terminalLine = lines.at(-1);
	const completed = terminalLine === completionMarker;
	const matchedMarker =
		terminalLine !== undefined
			? matchNeedsHumanMarker(terminalLine, needsHumanMarkers)
			: undefined;
	const needsHuman = matchedMarker !== undefined;
	const needsHumanReason =
		matchedMarker && terminalLine
			? extractNeedsHumanReason(terminalLine, matchedMarker)
			: undefined;

	return {
		completed,
		needsHuman,
		needsHumanReason,
		misplacedTerminalMarker: getMisplacedTerminalMarker(
			lines,
			completionMarker,
			needsHumanMarkers,
		),
		skeletonNotReplaced: hasSkeletonMarker(content),
		...(matchedMarker === LEGACY_BLOCKED_MARKER
			? {deprecatedMarker: LEGACY_BLOCKED_MARKER}
			: {}),
	};
}

/**
 * Rewrite every Terminal Marker line into an inert historical note.
 *
 * The Journal is keyed on the Athena Session, so a second Workflow Run in the
 * same Session inherits the Journal its predecessor left behind. Leaving that
 * predecessor's marker in place breaks the new Run two ways: while it is still
 * the final non-empty line the new Run resolves terminal at its first Turn, and
 * once the new Run writes below it, it is reported as a misplaced marker and
 * nudges the agent to "move" a marker that belongs to finished work.
 *
 * Only lines that are exactly a Terminal Marker are touched; marker-like text
 * inside notes or examples is left alone, matching {@link parseJournalState}.
 */
export function demoteTerminalMarkers(
	content: string,
	markers: JournalMarkers = {},
): string {
	const completionMarker =
		markers.completionMarker ?? DEFAULT_COMPLETION_MARKER;
	const needsHumanMarkers = needsHumanMarkersFor(markers);

	return content
		.split('\n')
		.map(line => {
			const trimmed = line.trim();
			if (trimmed === completionMarker) return '> _Prior Run ended: complete._';
			const matched = matchNeedsHumanMarker(trimmed, needsHumanMarkers);
			if (matched) {
				const reason = extractNeedsHumanReason(trimmed, matched);
				return reason
					? `> _Prior Run ended: needed a human — ${reason}._`
					: '> _Prior Run ended: needed a human._';
			}
			return line;
		})
		.join('\n');
}

/**
 * Append `entry` to Journal content without displacing a Terminal Marker.
 *
 * The protocol makes the last non-empty line authoritative and forbids prose
 * after a marker, so a Runner-written entry (a delivered Steer, #191) that
 * landed below a marker would turn it into a misplaced marker and fail the
 * next Turn. When the content ends in a marker line the entry is inserted
 * just above it — the marker stays last, exactly as the agent left it;
 * otherwise the entry is appended.
 */
export function insertAboveTerminalMarker(
	content: string,
	entry: string,
	markers: JournalMarkers = {},
): string {
	const completionMarker =
		markers.completionMarker ?? DEFAULT_COMPLETION_MARKER;
	const needsHumanMarkers = needsHumanMarkersFor(markers);
	const trimmed = content.trimEnd();
	const lastBreak = trimmed.lastIndexOf('\n');
	const lastLine = trimmed.slice(lastBreak + 1).trim();
	if (!isTerminalMarkerLine(lastLine, completionMarker, needsHumanMarkers)) {
		return content + entry;
	}
	const above = lastBreak === -1 ? '' : trimmed.slice(0, lastBreak);
	const markerLine = trimmed.slice(lastBreak + 1);
	return `${above.trimEnd()}${entry.replace(/\n*$/, '\n')}\n${markerLine}\n`;
}

export function buildContinuePrompt(loop: LoopConfig): string {
	const template = loop.continuePrompt ?? DEFAULT_CONTINUE_PROMPT;
	return substituteVariables(template, {journalPath: loopJournalPath(loop)});
}

/**
 * The corrective prompt for a Nudge (ADR 0014 §3): the agent stopped cleanly
 * without a Terminal Marker, so the Runner resumes the same Agent Session and
 * tells it both options — finish the remaining work, or declare a marker.
 */
export function buildNudgePrompt(
	loop: LoopConfig,
	opts?: {skeletonNotReplaced?: boolean},
): string {
	const completionMarker = loop.completionMarker ?? DEFAULT_COMPLETION_MARKER;
	const needsHumanMarker = loopNeedsHumanMarker(loop);
	const journalPath = loopJournalPath(loop);
	// The Turn-1 variant: nothing was ever written — the runner's skeleton is
	// still in place. The live failure shape this corrects is a question asked
	// in chat instead of declared on the journal.
	const bootstrapPreamble = opts?.skeletonNotReplaced
		? `You stopped without writing the journal at ${journalPath} — it still contains the runner's skeleton. ` +
			`If you were asking the human a question, do not ask it in chat: write it to the journal and declare ${needsHumanMarker}: <your question> --> as the final non-empty line. Otherwise replace the skeleton with the real plan and continue. `
		: `You stopped without declaring how this workflow ended. If work remains, continue it now. `;
	return (
		bootstrapPreamble +
		`If everything is done and verified, write ${completionMarker} as the final non-empty line of the journal at ${journalPath}. ` +
		`If you cannot proceed without a human, write ${needsHumanMarker}: <reason> --> there instead. ` +
		`Do not stop again without either finishing the work or declaring one of these markers.`
	);
}

/**
 * Rough token estimate for Journal content (ADR 0015 §3: "~4.0 chars/token,
 * o200k proxy"). An approximation used only to decide whether to nudge —
 * never exact, never used to block or to edit the Journal.
 */
export function estimateTokenCount(content: string): number {
	return Math.ceil(content.length / 4);
}

/**
 * Suffix appended to a continuing Turn's prompt when the Journal has crossed
 * {@link DEFAULT_JOURNAL_TOKEN_BOUND} (ADR 0015 §3). A nudge, not an
 * enforcement mechanism: it never blocks the Run and the Runner never edits
 * the Journal itself to shed it — only the agent does, in its own Turn.
 */
export function buildJournalSizeNudgeSuffix(
	journalPath: string | undefined,
): string {
	const where = journalPath ?? 'the journal';
	return (
		` Separately: ${where} has crossed the ~8,000-token shedding backstop (ADR 0015 §3). ` +
		`Before continuing, cut the completed phases of the still-open unit out of the journal and paste them verbatim into that unit's record under units/<slug>.md, leaving a pointer row behind — this is a nudge, not a requirement, so continue the work either way.`
	);
}

/** One row of the Journal's `## Units` table: a label plus a relative path to that unit's record. */
export type UnitTableRow = {
	label: string;
	recordPath: string;
};

const UNITS_HEADING_RE = /^##\s+Units\s*$/;

function splitTableRow(line: string): string[] {
	const trimmed = line.trim();
	const withoutEdgePipes = trimmed.replace(/^\|/, '').replace(/\|$/, '');
	return withoutEdgePipes.split('|').map(cell => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
	return cells.length > 0 && cells.every(cell => /^:?-+:?$/.test(cell));
}

/**
 * Parse the Journal's `## Units` table (ADR 0015 §7): a two-column GFM table
 * — `| Unit | Record |` — mapping a unit's label to a relative path to its
 * `units/<slug>.md` record. Tolerant by construction: the producer is an LLM
 * writing Markdown by hand, so this never throws. Returns `null` when there
 * is no real table to project (heading absent, or fewer than a header +
 * separator line follow it) — the caller's contract is "no projection", not
 * a guess. A malformed individual row is skipped rather than failing the
 * whole table.
 */
export function parseUnitTable(content: string): UnitTableRow[] | null {
	const lines = content.split('\n');
	const headingIndex = lines.findIndex(line =>
		UNITS_HEADING_RE.test(line.trim()),
	);
	if (headingIndex === -1) return null;

	let i = headingIndex + 1;
	while (i < lines.length && lines[i]!.trim() === '') i++;

	const tableLines: string[] = [];
	while (i < lines.length) {
		const trimmed = lines[i]!.trim();
		if (!trimmed.startsWith('|')) break;
		tableLines.push(trimmed);
		i++;
	}
	// Need at least a header row and a separator row to call this a table.
	if (tableLines.length < 2) return null;

	const rows: UnitTableRow[] = [];
	for (const line of tableLines.slice(1)) {
		const cells = splitTableRow(line);
		if (isSeparatorRow(cells)) continue;
		if (cells.length !== 2) continue;
		const [label, recordPath] = cells;
		if (!label || !recordPath) continue;
		rows.push({label, recordPath});
	}
	return rows;
}

/** The subset of a unit record's frontmatter this parser recognizes. */
export type UnitRecordFrontmatter = {
	status: 'open' | 'closed';
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

/**
 * Parse a unit record's leading YAML frontmatter (ADR 0015 §7: `status`,
 * `gates`). Only `status` is projected today — `gates` is reserved but
 * unused. Returns `null` on any miss (no frontmatter block, no `status`
 * key, or a value other than `open`/`closed`) rather than guessing; the
 * projection pathway this feeds only ever reaches the two `TodoStatus`
 * values (`pending`/`completed`) that the existing `task.created`/
 * `task.completed` handling can produce, so the vocabulary is deliberately
 * this narrow rather than inventing new states no downstream code expects.
 */
export function parseUnitRecordFrontmatter(
	content: string,
): UnitRecordFrontmatter | null {
	const match = FRONTMATTER_RE.exec(content);
	if (!match) return null;
	const block = match[1];
	const statusMatch = /^status:\s*(\S+)\s*$/m.exec(block);
	const raw = statusMatch?.[1]?.trim().toLowerCase();
	if (raw !== 'open' && raw !== 'closed') return null;
	return {status: raw};
}

/**
 * One Journal unit projected into a harness-neutral shape, ready to become a
 * task-tool item. Deliberately not `core/feed`'s `TodoItem` — this module
 * has no Feed awareness by design (mirrors `runMachine.ts`/`workflowRunner.ts`,
 * which are equally Feed-free), so the caller maps this into whatever
 * task-tool shape it needs.
 */
export type JournalTaskProjection = {
	taskId: string;
	content: string;
	status: 'pending' | 'completed';
};

/**
 * Orchestrate the Journal's `## Units` table plus each referenced unit
 * record's frontmatter into a task-tool projection. Never throws: a parse
 * miss anywhere degrades to `null` (no table at all) or to skipping just the
 * offending row (unreadable/malformed record) — see {@link parseUnitTable}
 * and {@link parseUnitRecordFrontmatter}. The caller must treat `null` as
 * "no projection", never as an empty task list to display.
 */
export function projectJournalTasks(
	journalAbsPath: string,
): JournalTaskProjection[] | null {
	const content = readJournal(journalAbsPath);
	if (!content) return null;

	const rows = parseUnitTable(content);
	if (!rows) return null;

	const baseDir = path.dirname(journalAbsPath);
	const tasks: JournalTaskProjection[] = [];
	for (const row of rows) {
		const recordAbsPath = path.resolve(baseDir, row.recordPath);
		// Containment: a Journal row may only point at a record inside its own
		// Dossier. The agent authors the Journal, but it does so from content it
		// read elsewhere, and a row like `../../../etc/passwd` would otherwise
		// be resolved and read. Escaping rows are skipped, not fatal.
		const relToBase = path.relative(baseDir, recordAbsPath);
		if (relToBase.startsWith('..') || path.isAbsolute(relToBase)) continue;
		let recordContent: string;
		try {
			recordContent = fs.readFileSync(recordAbsPath, 'utf-8');
		} catch {
			continue;
		}
		const frontmatter = parseUnitRecordFrontmatter(recordContent);
		if (!frontmatter) continue;
		const taskId = path.basename(row.recordPath, path.extname(row.recordPath));
		if (!taskId) continue;
		tasks.push({
			taskId,
			content: row.label,
			status: frontmatter.status === 'closed' ? 'completed' : 'pending',
		});
	}
	return tasks;
}
