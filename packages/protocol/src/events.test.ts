import {describe, expect, it} from 'vitest';
import {
	FrameSchema,
	JSON_SCHEMA_SOURCES,
	PHASE_FEED_EVENT_KIND,
	PhaseEventSchema,
	PhaseFeedEventSchema,
	normalizeFrame,
	toLegacyFrame,
	type CanonicalFrame,
} from './index';

const phase = {
	runId: 'run_42',
	turn: 3,
	step: 'Build',
	stepIndex: 2,
	stepTotal: 5,
} as const;

function phaseFeedEvent(overrides: Record<string, unknown> = {}) {
	return {
		event_id: 'run_42:phase:3',
		seq: 12,
		ts: 1_700_000_000_000,
		session_id: 'athena-1',
		run_id: 'athena-1:R1',
		kind: PHASE_FEED_EVENT_KIND,
		level: 'info',
		actor_id: 'system',
		title: 'Step 2/5: Build',
		data: phase,
		...overrides,
	};
}

describe('phase event', () => {
	it('is the FeedEvent kind "phase"', () => {
		expect(PHASE_FEED_EVENT_KIND).toBe('phase');
	});

	it('names the step, the Run, and the Turn that produced it', () => {
		expect(PhaseEventSchema.parse(phase)).toEqual(phase);
	});

	it('carries index and total only when known', () => {
		const bare = {runId: 'run_42', turn: 1, step: 'Orient'};
		expect(PhaseEventSchema.parse(bare)).toEqual(bare);
	});

	it.each([
		['a Turn below 1', {...phase, turn: 0}],
		['an empty step name', {...phase, step: ''}],
		['a non-integer index', {...phase, stepIndex: 1.5}],
		['a zero total', {...phase, stepTotal: 0}],
		['a missing Run id', {turn: 1, step: 'Build'}],
	])('rejects %s', (_label, value) => {
		expect(PhaseEventSchema.safeParse(value).success).toBe(false);
	});
});

describe('phase FeedEvent', () => {
	it('is a FeedEvent of kind "phase" whose data is the phase event', () => {
		const parsed = PhaseFeedEventSchema.parse(phaseFeedEvent());
		expect(parsed.kind).toBe('phase');
		expect(parsed.data).toEqual(phase);
	});

	it('rejects another kind and a data payload that is not a phase', () => {
		expect(
			PhaseFeedEventSchema.safeParse(phaseFeedEvent({kind: 'notification'}))
				.success,
		).toBe(false);
		expect(
			PhaseFeedEventSchema.safeParse(
				phaseFeedEvent({data: {runId: 'run_42', turn: 1}}),
			).success,
		).toBe(false);
	});

	it('rides the feed stream as an `event` frame under either name set', () => {
		const frame: CanonicalFrame = {
			type: 'event',
			stream: 'feed',
			deliverySeq: 7,
			envelope: {
				instanceId: 'inst_1',
				athenaSessionId: 'athena-1',
				runId: 'athena-1:R1',
				origin: 'local',
				eventId: 'athena-1:run_42:phase:3',
				feedSeq: 7,
				emittedAt: 1_700_000_000_000,
				feedEvent: phaseFeedEvent(),
			},
		};
		expect(FrameSchema.parse(frame)).toEqual(frame);
		const legacy = toLegacyFrame(frame);
		expect(legacy.type).toBe('feed_event');
		expect(normalizeFrame(legacy)).toEqual(frame);
		const carried = normalizeFrame(legacy);
		if (carried.type !== 'event' || carried.stream !== 'feed') {
			throw new Error('expected a feed-stream event frame');
		}
		expect(
			PhaseFeedEventSchema.safeParse(carried.envelope.feedEvent).success,
		).toBe(true);
	});

	it('is exported as JSON Schema beside the phase payload', () => {
		expect(Object.keys(JSON_SCHEMA_SOURCES)).toEqual(
			expect.arrayContaining(['phase-event', 'phase-feed-event']),
		);
	});
});
