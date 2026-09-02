/**
 * Tracker reader — the read-only inspector for the Turn Protocol.
 *
 * Athena spawns fresh `claude -p` Turns in a loop. The agent owns the Tracker
 * file (creates/updates it); the Runner only reads it between Turns to learn the
 * Tracker's end state. This module is that inspector: pure functions that turn
 * Tracker text into a {@link TrackerState}, plus the Terminal Marker constants
 * and the Continue Prompt.
 *
 * It holds no loop state of its own. The Iteration counter lives on the Runner
 * (a single source of truth — see `workflowRunner.ts`), and the mapping from a
 * Tracker end-state to a Run Status lives in `terminalOutcome.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';
import type {LoopConfig} from './types';
import {substituteVariables} from './templateVars';

export const DEFAULT_COMPLETION_MARKER = '<!-- WORKFLOW_COMPLETE -->';
export const DEFAULT_BLOCKED_MARKER = '<!-- WORKFLOW_BLOCKED';
export const DEFAULT_TRACKER_PATH = '.athena/{sessionId}/tracker.md';
export const TRACKER_SKELETON_MARKER = '<!-- TRACKER_SKELETON -->';

/**
 * Backstop for shedding a long single unit's completed detail into the
 * Dossier (ADR 0015 §3) — "roughly 32,000 characters", not a target to
 * design toward. Distinct from {@link DEFAULT_MAX_TURN_TOKEN_COUNT} in
 * `types.ts`, which bounds a Turn's conversation window; this bounds the
 * Tracker file's own size.
 */
export const DEFAULT_TRACKER_TOKEN_BOUND = 8000;

const DEFAULT_CONTINUE_PROMPT =
	'Continue the task. Read the tracker at {trackerPath} for current progress. If the work is complete or blocked, the terminal marker must be the final non-empty line of the tracker; do not write any prose after it.';

/** The Terminal Markers that resolve a Workflow Run, as configured for a loop. */
export type TrackerMarkers = Pick<
	LoopConfig,
	'completionMarker' | 'blockedMarker'
>;

/**
 * What the Tracker's text says about the Workflow Run's progress — the part of
 * the terminal outcome that is a pure function of the Tracker file. The
 * Iteration count and its limit are owned by the Runner, not derived here.
 */
export type TrackerState = {
	/** The last non-empty line is the completion Terminal Marker. */
	completed: boolean;
	/** The last non-empty line is a blocked Terminal Marker. */
	blocked: boolean;
	/** Reason parsed from a blocked Terminal Marker, when present. */
	blockedReason?: string;
	/** A Terminal Marker appears, but not as the final non-empty line. */
	misplacedTerminalMarker?: string;
	/** The runner's Skeleton is still present — Orient never replaced it. */
	skeletonNotReplaced: boolean;
};

/** Read the Tracker file, failing open to empty content when it is unreadable. */
export function readTracker(trackerPath: string): string {
	try {
		return fs.readFileSync(trackerPath, 'utf-8');
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

function isBlockedLine(line: string, blockedMarker: string): boolean {
	return (
		line === `${blockedMarker} -->` || line.startsWith(`${blockedMarker}:`)
	);
}

function isTerminalMarkerLine(
	line: string,
	completionMarker: string,
	blockedMarker: string,
): boolean {
	return line === completionMarker || isBlockedLine(line, blockedMarker);
}

function getMisplacedTerminalMarker(
	lines: string[],
	completionMarker: string,
	blockedMarker: string,
): string | undefined {
	if (lines.length < 2) return undefined;
	const terminalLine = lines.at(-1);
	if (
		terminalLine &&
		isTerminalMarkerLine(terminalLine, completionMarker, blockedMarker)
	) {
		return undefined;
	}
	return lines
		.slice(0, -1)
		.find(line => isTerminalMarkerLine(line, completionMarker, blockedMarker));
}

function extractBlockedReason(
	line: string,
	blockedMarker: string,
): string | undefined {
	if (!line.startsWith(blockedMarker)) return undefined;
	const afterMarker = line.slice(blockedMarker.length);
	const match = afterMarker.match(/^:\s*(.+?)(?:\s*-->|$)/);
	return match?.[1]?.trim();
}

/**
 * Parse raw Tracker text into a {@link TrackerState}. Only the last non-empty
 * line is an authoritative Terminal Marker; a marker anywhere above it is
 * reported as misplaced rather than terminal.
 */
export function parseTrackerState(
	content: string,
	markers: TrackerMarkers = {},
): TrackerState {
	const completionMarker =
		markers.completionMarker ?? DEFAULT_COMPLETION_MARKER;
	const blockedMarker = markers.blockedMarker ?? DEFAULT_BLOCKED_MARKER;

	const lines = getNonEmptyLines(content);
	const terminalLine = lines.at(-1);
	const completed = terminalLine === completionMarker;
	const blocked =
		terminalLine !== undefined && isBlockedLine(terminalLine, blockedMarker);
	const blockedReason =
		blocked && terminalLine
			? extractBlockedReason(terminalLine, blockedMarker)
			: undefined;

	return {
		completed,
		blocked,
		blockedReason,
		misplacedTerminalMarker: getMisplacedTerminalMarker(
			lines,
			completionMarker,
			blockedMarker,
		),
		skeletonNotReplaced: content.includes(TRACKER_SKELETON_MARKER),
	};
}

/**
 * Rewrite every Terminal Marker line into an inert historical note.
 *
 * The Tracker is keyed on the Athena Session, so a second Workflow Run in the
 * same Session inherits the Tracker its predecessor left behind. Leaving that
 * predecessor's marker in place breaks the new Run two ways: while it is still
 * the final non-empty line the new Run resolves terminal at its first Turn, and
 * once the new Run writes below it, it is reported as a misplaced marker and
 * nudges the agent to "move" a marker that belongs to finished work.
 *
 * Only lines that are exactly a Terminal Marker are touched; marker-like text
 * inside notes or examples is left alone, matching {@link parseTrackerState}.
 */
export function demoteTerminalMarkers(
	content: string,
	markers: TrackerMarkers = {},
): string {
	const completionMarker =
		markers.completionMarker ?? DEFAULT_COMPLETION_MARKER;
	const blockedMarker = markers.blockedMarker ?? DEFAULT_BLOCKED_MARKER;

	return content
		.split('\n')
		.map(line => {
			const trimmed = line.trim();
			if (trimmed === completionMarker) return '> _Prior Run ended: complete._';
			if (isBlockedLine(trimmed, blockedMarker)) {
				const reason = extractBlockedReason(trimmed, blockedMarker);
				return reason
					? `> _Prior Run ended: needed attention — ${reason}._`
					: '> _Prior Run ended: needed attention._';
			}
			return line;
		})
		.join('\n');
}

export function buildContinuePrompt(loop: LoopConfig): string {
	const template = loop.continuePrompt ?? DEFAULT_CONTINUE_PROMPT;
	return substituteVariables(template, {
		trackerPath: loop.trackerPath ?? DEFAULT_TRACKER_PATH,
	});
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
	const blockedMarker = loop.blockedMarker ?? DEFAULT_BLOCKED_MARKER;
	const trackerPath = loop.trackerPath ?? DEFAULT_TRACKER_PATH;
	// The Turn-1 variant: nothing was ever written — the runner's skeleton is
	// still in place. The live failure shape this corrects is a question asked
	// in chat instead of declared on the tracker.
	const bootstrapPreamble = opts?.skeletonNotReplaced
		? `You stopped without writing the tracker at ${trackerPath} — it still contains the runner's skeleton. ` +
			`If you were asking the human a question, do not ask it in chat: write it to the tracker and declare ${blockedMarker}: <your question> --> as the final non-empty line. Otherwise replace the skeleton with the real plan and continue. `
		: `You stopped without declaring how this workflow ended. If work remains, continue it now. `;
	return (
		bootstrapPreamble +
		`If everything is done and verified, write ${completionMarker} as the final non-empty line of the tracker at ${trackerPath}. ` +
		`If you cannot proceed without a human, write ${blockedMarker}: <reason> --> there instead. ` +
		`Do not stop again without either finishing the work or declaring one of these markers.`
	);
}

/**
 * Rough token estimate for Tracker content (ADR 0015 §3: "~4.0 chars/token,
 * o200k proxy"). An approximation used only to decide whether to nudge —
 * never exact, never used to block or to edit the Tracker.
 */
export function estimateTokenCount(content: string): number {
	return Math.ceil(content.length / 4);
}

/**
 * Suffix appended to a continuing Turn's prompt when the Tracker has crossed
 * {@link DEFAULT_TRACKER_TOKEN_BOUND} (ADR 0015 §3). A nudge, not an
 * enforcement mechanism: it never blocks the Run and the Runner never edits
 * the Tracker itself to shed it — only the agent does, in its own Turn.
 */
export function buildTrackerSizeNudgeSuffix(
	trackerPath: string | undefined,
): string {
	const where = trackerPath ?? 'the tracker';
	return (
		` Separately: ${where} has crossed the ~8,000-token shedding backstop (ADR 0015 §3). ` +
		`Before continuing, cut the completed phases of the still-open unit out of the tracker and paste them verbatim into that unit's record under units/<slug>.md, leaving a pointer row behind — this is a nudge, not a requirement, so continue the work either way.`
	);
}

/** One row of the Tracker's `## Units` table: a label plus a relative path to that unit's record. */
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
 * Parse the Tracker's `## Units` table (ADR 0015 §7): a two-column GFM table
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
 * One Tracker unit projected into a harness-neutral shape, ready to become a
 * task-tool item. Deliberately not `core/feed`'s `TodoItem` — this module
 * has no Feed awareness by design (mirrors `runMachine.ts`/`workflowRunner.ts`,
 * which are equally Feed-free), so the caller maps this into whatever
 * task-tool shape it needs.
 */
export type TrackerTaskProjection = {
	taskId: string;
	content: string;
	status: 'pending' | 'completed';
};

/**
 * Orchestrate the Tracker's `## Units` table plus each referenced unit
 * record's frontmatter into a task-tool projection. Never throws: a parse
 * miss anywhere degrades to `null` (no table at all) or to skipping just the
 * offending row (unreadable/malformed record) — see {@link parseUnitTable}
 * and {@link parseUnitRecordFrontmatter}. The caller must treat `null` as
 * "no projection", never as an empty task list to display.
 */
export function projectTrackerTasks(
	trackerAbsPath: string,
): TrackerTaskProjection[] | null {
	const content = readTracker(trackerAbsPath);
	if (!content) return null;

	const rows = parseUnitTable(content);
	if (!rows) return null;

	const baseDir = path.dirname(trackerAbsPath);
	const tasks: TrackerTaskProjection[] = [];
	for (const row of rows) {
		const recordAbsPath = path.resolve(baseDir, row.recordPath);
		// Containment: a Tracker row may only point at a record inside its own
		// Dossier. The agent authors the Tracker, but it does so from content it
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
