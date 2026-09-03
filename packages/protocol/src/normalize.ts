/**
 * The legacy ↔ canonical frame-name mapping, and the two functions that apply
 * it. Each legacy name maps to exactly one canonical name; a frame under
 * either name normalises to the same typed value.
 */
import {
	FrameSchema,
	type CanonicalFrame,
	type CanonicalFrameType,
	type Frame,
	type LegacyFrame,
	type LegacyFrameType,
} from './frames';

/**
 * Legacy frame name → canonical frame name. Names that did not change map to
 * themselves. Two legacy names (`run_event`, `feed_event`) fold into `event`,
 * told apart by its `stream` discriminator.
 */
export const FRAME_NAME_MAP = {
	job_assignment: 'run.start',
	dashboard_decision: 'answer',
	cancel: 'stop',
	run_event: 'event',
	feed_event: 'event',
	ping: 'ping',
	pong: 'pong',
	assignment_accepted: 'assignment_accepted',
	assignment_rejected: 'assignment_rejected',
	decision_ack: 'decision_ack',
	feed_ack: 'feed_ack',
	'attachments.changed': 'attachments.changed',
	error: 'error',
} as const satisfies Record<LegacyFrameType, CanonicalFrameType>;

export type FrameNameMap = typeof FRAME_NAME_MAP;

/** Canonical frames that exist only under the new name set. */
export type NewOnlyFrame = Extract<
	CanonicalFrame,
	{type: 'hello' | 'steer' | 'needs_human' | 'workflows.changed'}
>;

/** What `toLegacyFrame` yields: a legacy frame, or a new-only frame unchanged. */
export type EmittableLegacyFrame = LegacyFrame | NewOnlyFrame;

/**
 * Parse an unknown value as a frame under either name set and return it under
 * its canonical name. Throws a `ZodError` when the value is not a frame.
 */
export function normalizeFrame(input: unknown): CanonicalFrame {
	return canonicalize(FrameSchema.parse(input));
}

/** `normalizeFrame` without the throw. */
export function safeNormalizeFrame(
	input: unknown,
): {success: true; frame: CanonicalFrame} | {success: false; error: Error} {
	const parsed = FrameSchema.safeParse(input);
	if (!parsed.success) return {success: false, error: parsed.error};
	return {success: true, frame: canonicalize(parsed.data)};
}

function canonicalize(frame: Frame): CanonicalFrame {
	switch (frame.type) {
		case 'job_assignment': {
			const {type: _type, ...body} = frame;
			return {type: 'run.start', ...body};
		}
		case 'dashboard_decision': {
			const {type: _type, ...body} = frame;
			return {type: 'answer', ...body};
		}
		case 'cancel': {
			const {type: _type, ...body} = frame;
			return {type: 'stop', ...body};
		}
		case 'run_event': {
			const {type: _type, ...body} = frame;
			return {type: 'event', stream: 'run', ...body};
		}
		case 'feed_event': {
			const {type: _type, ...body} = frame;
			return {type: 'event', stream: 'feed', ...body};
		}
		default:
			return frame;
	}
}

/**
 * The inverse of `normalizeFrame` for frames that have a legacy name: what a
 * runner still speaking the old names must put on the wire. Frames that exist
 * only under the new names (`hello`, `steer`, `needs_human`,
 * `workflows.changed`) come back unchanged.
 */
export function toLegacyFrame(frame: CanonicalFrame): EmittableLegacyFrame {
	switch (frame.type) {
		case 'run.start': {
			const {type: _type, ...body} = frame;
			return {type: 'job_assignment', ...body};
		}
		case 'answer': {
			const {type: _type, ...body} = frame;
			return {type: 'dashboard_decision', ...body};
		}
		case 'stop': {
			const {type: _type, ...body} = frame;
			return {type: 'cancel', ...body};
		}
		case 'event': {
			if (frame.stream === 'run') {
				const {type: _type, stream: _stream, ...body} = frame;
				return {type: 'run_event', ...body};
			}
			const {type: _type, stream: _stream, ...body} = frame;
			return {type: 'feed_event', ...body};
		}
		default:
			return frame;
	}
}
