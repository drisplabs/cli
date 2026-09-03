import type {FeedEvent, PhaseData} from './types';

/**
 * Project a Workflow Run's change of step (the Runner's `PhaseChange`) into
 * the `phase` FeedEvent the local feed renders and the paired feed publisher
 * forwards to the hub. The Runner observes the step; this is the one place
 * that decides how it looks on the timeline.
 *
 * The caller supplies the feed-pipeline identity — the drisp Session, the
 * Feed Run, and a mapper-allocated `seq` — because a phase is not a
 * RuntimeEvent and never passes through the FeedMapper. `event_id` is keyed
 * on the Workflow Run and Turn, which is unique because a Turn names at most
 * one step change.
 */
export function buildPhaseFeedEvent(input: {
	phase: PhaseData;
	sessionId: string;
	runId: string;
	seq: number;
	ts: number;
}): FeedEvent {
	return {
		event_id: `${input.phase.runId}:phase:${input.phase.turn}`,
		seq: input.seq,
		ts: input.ts,
		session_id: input.sessionId,
		run_id: input.runId,
		kind: 'phase',
		level: 'info',
		actor_id: 'system',
		title: phaseTitle(input.phase),
		data: input.phase,
	};
}

/** `Step 2/5: Build`, or `Step: Build` when the block gave no index. */
export function phaseTitle(phase: PhaseData): string {
	return `Step${phasePosition(phase)}: ${phase.step}`;
}

/** ` 2/5`, ` 2`, or `` — the position suffix a phase can show. */
export function phasePosition(phase: PhaseData): string {
	if (phase.stepIndex === undefined) return '';
	return phase.stepTotal === undefined
		? ` ${phase.stepIndex}`
		: ` ${phase.stepIndex}/${phase.stepTotal}`;
}
