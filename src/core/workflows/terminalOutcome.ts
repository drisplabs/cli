/**
 * Terminal outcome — the single owner of "what the Tracker's end state means".
 *
 * After each Turn the Runner asks this module one question: run another Turn, or
 * stop with a final Run Status? Every terminal branch below carries BOTH the Run
 * Status the Runner reports and the human sentence shown to the user, so the map
 * from Tracker end-state → Run Status lives in exactly one place.
 *
 * Previously that one concept was smeared across three vocabularies in three
 * files — `LoopState` (the Tracker reader) → `LoopStopReason` (sessionPlan) → `RunStatus`
 * + a hand-built message (workflowRunner) — with a lossy translation at each seam.
 * That is how `missing_tracker` slipped through the final hop's `else` branch and
 * surfaced its raw enum name to the user. Here the branches are exhaustive.
 */

import fs from 'node:fs';
import {parseTrackerState, readTracker} from './trackerReader';
import type {LoopConfig, RunStatus} from './types';

/**
 * The Runner's decision after a Turn: keep looping, or stop with a final
 * {@link RunStatus} and (for terminal states worth explaining) a human message.
 */
export type TurnOutcome =
	| {kind: 'continue'}
	| {kind: 'stop'; status: RunStatus; stopReason?: string};

const MISSING_TRACKER_MESSAGE =
	'the tracker file went missing during the run — the workflow can no longer verify progress';
const SKELETON_NOT_REPLACED_MESSAGE =
	'tracker skeleton was never replaced — Claude did not bootstrap the tracker';
const MISPLACED_TERMINAL_MARKER_MESSAGE =
	'terminal workflow marker is not the final non-empty line of the tracker; move all summary text above the marker';

/**
 * Resolve the terminal outcome of a looped Workflow Run after the Turn at
 * `iteration` (1-based) completes. Reads the Tracker directly and returns the
 * final Run Status the Runner assigns — the Runner does not re-derive it.
 */
export function resolveTurnOutcome(input: {
	trackerPath: string;
	loop: LoopConfig;
	iteration: number;
}): TurnOutcome {
	const {trackerPath, loop, iteration} = input;

	// The agent owns the Tracker; if it is *gone* we cannot verify progress and
	// fail. This existence probe is deliberately distinct from reading the
	// content: `readTracker` fails open to '' for a present-but-unreadable file,
	// which parses as "still running" and keeps looping. Only an absent Tracker
	// is terminal. (Preserves the prior Runner behaviour.)
	if (!fs.existsSync(trackerPath)) {
		return {
			kind: 'stop',
			status: 'failed',
			stopReason: MISSING_TRACKER_MESSAGE,
		};
	}

	const tracker = parseTrackerState(readTracker(trackerPath), loop);

	if (tracker.skeletonNotReplaced) {
		return {
			kind: 'stop',
			status: 'failed',
			stopReason: SKELETON_NOT_REPLACED_MESSAGE,
		};
	}
	if (tracker.misplacedTerminalMarker) {
		return {
			kind: 'stop',
			status: 'failed',
			stopReason: MISPLACED_TERMINAL_MARKER_MESSAGE,
		};
	}
	if (tracker.completed) {
		return {kind: 'stop', status: 'completed'};
	}
	if (tracker.blocked) {
		return {kind: 'stop', status: 'blocked', stopReason: tracker.blockedReason};
	}
	if (iteration >= loop.maxIterations) {
		return {kind: 'stop', status: 'exhausted'};
	}

	return {kind: 'continue'};
}
