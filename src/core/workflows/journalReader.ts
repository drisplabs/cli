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
