/**
 * Terminal outcome — the single owner of "what the Journal's end state means".
 *
 * After each Turn the Runner asks this module one question: run another Turn, or
 * stop with a final Run Status? Every terminal branch below carries BOTH the Run
 * Status the Runner reports and the human sentence shown to the user, so the map
 * from Journal end-state → Run Status lives in exactly one place.
 *
 * Previously that one concept was smeared across three vocabularies in three
 * files — `LoopState` (the Journal reader) → `LoopStopReason` (sessionPlan) → `RunStatus`
 * + a hand-built message (workflowRunner) — with a lossy translation at each seam.
 * That is how `missing_tracker` slipped through the final hop's `else` branch and
 * surfaced its raw enum name to the user. Here the branches are exhaustive.
 */

import fs from 'node:fs';
import {
	buildMarkerDeprecation,
	parseJournalState,
	readJournal,
} from './journalReader';
import type {LoopConfig, RunStatus} from './types';

/**
 * The Runner's decision after a Turn: keep looping, stop with a final
 * {@link RunStatus}, or suspend the Run in the non-terminal
 * `awaiting_attention` until a human replies (ADR 0014). Suspend messages must
 * name what tripped — several bounds funnel into the one suspended state, and
 * an unnamed give-up state is unreadable in practice.
 *
 * `deprecation` rides along when the Turn declared itself with a deprecated
 * marker spelling: the outcome is identical, and the reducer turns the note
 * into a `warn` action so the interpreter can log it (#185).
 */
export type TurnOutcome =
	| {kind: 'continue'}
	| {kind: 'stop'; status: RunStatus; stopReason?: string}
	| {
			kind: 'suspend';
			status: RunStatus;
			stopReason: string;
			deprecation?: string;
	  };

/**
 * The sentence an `awaiting_attention` Run carries when `maxIterations`
 * tripped (ADR 0014 §7). One author for the two rows that reach the ceiling:
 * the clean-stop path below, and the successful-fork row of the run-loop
 * reducer (ADR 0018 §4) — `interruptionFromSuspension` reads it back into a
 * `cap_exhausted` / `iterations` Interruption, so the wording is a contract.
 */
export function buildIterationCeilingReason(maxIterations: number): string {
	return `iteration ceiling reached: ${maxIterations} iteration${
		maxIterations === 1 ? '' : 's'
	} (maxIterations) used without a terminal marker`;
}

const MISSING_JOURNAL_MESSAGE =
	'the journal file went missing during the run — the workflow can no longer verify progress';
const MISPLACED_TERMINAL_MARKER_MESSAGE =
	'terminal workflow marker is not the final non-empty line of the journal; move all summary text above the marker';

/**
 * Resolve the terminal outcome of a looped Workflow Run after the Turn at
 * `iteration` (1-based) completes. Reads the Journal directly and returns the
 * final Run Status the Runner assigns — the Runner does not re-derive it.
 */
export function resolveTurnOutcome(input: {
	journalPath: string;
	loop: LoopConfig;
	iteration: number;
}): TurnOutcome {
	const {journalPath, loop, iteration} = input;

	// The agent owns the Journal; if it is *gone* we cannot verify progress and
	// fail. This existence probe is deliberately distinct from reading the
	// content: `readJournal` fails open to '' for a present-but-unreadable file,
	// which parses as "still running" and keeps looping. Only an absent Journal
	// is terminal. (Preserves the prior Runner behaviour.)
	if (!fs.existsSync(journalPath)) {
		return {
			kind: 'stop',
			status: 'failed',
			stopReason: MISSING_JOURNAL_MESSAGE,
		};
	}

	const journal = parseJournalState(readJournal(journalPath), loop);

	// An untouched skeleton after a clean Turn is an undeclared premature stop
	// (ADR 0014 §3), not a terminal bootstrap failure: the common live shape is
	// the agent answering a trivial ask in chat before any tool work. Falling
	// through to `continue` routes it into the Nudge path, whose cap — the
	// journal content isn't advancing — bounds a genuinely broken bootstrap and
	// escalates it to `awaiting_attention` instead of a dead `failed`.
	if (journal.misplacedTerminalMarker) {
		return {
			kind: 'stop',
			status: 'failed',
			stopReason: MISPLACED_TERMINAL_MARKER_MESSAGE,
		};
	}
	if (journal.completed) {
		return {kind: 'stop', status: 'completed'};
	}
	// Declared attention (ADR 0014): NEEDS_HUMAN is the agent's explicit
	// "I need a human" — a question or an external blocker. It suspends the Run
	// in the non-terminal `awaiting_attention` rather than ending it in the
	// terminal `blocked` (still valid on historical rows, no longer emitted).
	// Checked before the ceiling: a declared reason beats a generic bound. The
	// legacy WORKFLOW_BLOCKED spelling reaches this same branch (#185).
	if (journal.needsHuman) {
		return {
			kind: 'suspend',
			status: 'awaiting_attention',
			stopReason: journal.needsHumanReason
				? `agent declared NEEDS_HUMAN: ${journal.needsHumanReason}`
				: 'agent declared NEEDS_HUMAN',
			...(journal.deprecatedMarker
				? {deprecation: buildMarkerDeprecation(journal.deprecatedMarker)}
				: {}),
		};
	}
	// Runaway ceiling (ADR 0014 §7): hitting maxIterations suspends instead of
	// terminating in `exhausted` (still valid on historical rows, no longer
	// emitted). The message names which bound tripped — the Nudge and Retry
	// caps funnel into the same state, and an unnamed give-up is unreadable.
	if (iteration >= loop.maxIterations) {
		return {
			kind: 'suspend',
			status: 'awaiting_attention',
			stopReason: buildIterationCeilingReason(loop.maxIterations),
		};
	}
	return {kind: 'continue'};
}
