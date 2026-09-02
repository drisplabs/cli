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
import type {LoopConfig} from './types';
import {substituteVariables} from './templateVars';

export const DEFAULT_COMPLETION_MARKER = '<!-- WORKFLOW_COMPLETE -->';
export const DEFAULT_BLOCKED_MARKER = '<!-- WORKFLOW_BLOCKED';
export const DEFAULT_TRACKER_PATH = '.athena/{sessionId}/tracker.md';
export const TRACKER_SKELETON_MARKER = '<!-- TRACKER_SKELETON -->';

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
