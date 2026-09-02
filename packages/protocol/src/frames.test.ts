import {describe, expect, it} from 'vitest';
import {
	FRAME_NAME_MAP,
	FrameSchema,
	HelloFrameSchema,
	PROTOCOL_VERSION,
	normalizeFrame,
	toLegacyFrame,
	type CanonicalFrame,
	type LegacyFrame,
} from './index';

const decision = {
	type: 'json',
	source: 'user',
	intent: {kind: 'permission_allow'},
} as const;

const feedEnvelope = {
	instanceId: 'inst_1',
	athenaSessionId: 'athena-1',
	runId: 'athena-1:R1',
	origin: 'local',
	eventId: 'athena-1:feed-1',
	feedSeq: 1,
	emittedAt: 1_700_000_000_000,
	feedEvent: {
		event_id: 'feed-1',
		seq: 1,
		ts: 1_700_000_000_000,
		session_id: 'athena-1',
		run_id: 'athena-1:R1',
		kind: 'notification',
		level: 'info',
		actor_id: 'root',
		title: 'hello',
		data: {message: 'hello'},
	},
} as const;

/**
 * Every old-name frame paired with the new-name frame it must normalise to.
 * Frames whose name is unchanged pair with themselves.
 */
const pairs: Array<{legacy: LegacyFrame; canonical: CanonicalFrame}> = [
	{
		legacy: {
			type: 'job_assignment',
			runId: 'run_42',
			runnerId: 'runner_1',
			runSpec: {prompt: 'do the thing', projectDir: '/tmp/ws'},
		},
		canonical: {
			type: 'run.start',
			runId: 'run_42',
			runnerId: 'runner_1',
			runSpec: {prompt: 'do the thing', projectDir: '/tmp/ws'},
		},
	},
	{
		legacy: {
			type: 'dashboard_decision',
			athenaSessionId: 'athena-1',
			requestId: 'req-1',
			decision,
		},
		canonical: {
			type: 'answer',
			athenaSessionId: 'athena-1',
			requestId: 'req-1',
			decision,
		},
	},
	{
		legacy: {type: 'cancel', runId: 'run_42', runnerId: 'runner_1'},
		canonical: {type: 'stop', runId: 'run_42', runnerId: 'runner_1'},
	},
	{
		legacy: {
			type: 'run_event',
			runId: 'run_42',
			seq: 1,
			ts: 1234,
			kind: 'progress',
			payload: {message: 'assignment received'},
		},
		canonical: {
			type: 'event',
			stream: 'run',
			runId: 'run_42',
			seq: 1,
			ts: 1234,
			kind: 'progress',
			payload: {message: 'assignment received'},
		},
	},
	{
		legacy: {type: 'feed_event', deliverySeq: 7, envelope: feedEnvelope},
		canonical: {
			type: 'event',
			stream: 'feed',
			deliverySeq: 7,
			envelope: feedEnvelope,
		},
	},
	{legacy: {type: 'ping', ts: 42}, canonical: {type: 'ping', ts: 42}},
	{legacy: {type: 'pong', ts: 43}, canonical: {type: 'pong', ts: 43}},
	{
		legacy: {type: 'assignment_accepted', runId: 'run_42'},
		canonical: {type: 'assignment_accepted', runId: 'run_42'},
	},
	{
		legacy: {
			type: 'assignment_rejected',
			runId: 'run_42',
			reason: 'local_capacity',
			message: 'runtime daemon at concurrency cap',
		},
		canonical: {
			type: 'assignment_rejected',
			runId: 'run_42',
			reason: 'local_capacity',
			message: 'runtime daemon at concurrency cap',
		},
	},
	{
		legacy: {type: 'decision_ack', athenaSessionId: 'athena-1', requestId: 'r'},
		canonical: {
			type: 'decision_ack',
			athenaSessionId: 'athena-1',
			requestId: 'r',
		},
	},
	{
		legacy: {type: 'feed_ack', deliverySeq: 7, eventId: 'athena-1:feed-1'},
		canonical: {type: 'feed_ack', deliverySeq: 7, eventId: 'athena-1:feed-1'},
	},
	{
		legacy: {
			type: 'attachments.changed',
			attachments: [{runnerId: 'runner_1', name: 'Runner One'}],
		},
		canonical: {
			type: 'attachments.changed',
			attachments: [{runnerId: 'runner_1', name: 'Runner One'}],
		},
	},
	{
		legacy: {type: 'error', code: 'instance_mismatch', message: 'nope'},
		canonical: {type: 'error', code: 'instance_mismatch', message: 'nope'},
	},
];

describe('PROTOCOL_VERSION and hello', () => {
	it('exposes the version the package speaks', () => {
		expect(PROTOCOL_VERSION).toBe(1);
	});

	it('a hello frame carries the protocol version', () => {
		const hello = HelloFrameSchema.parse({
			type: 'hello',
			protocolVersion: PROTOCOL_VERSION,
			role: 'runner',
			instanceId: 'inst_1',
			agent: {name: '@drisp/cli', version: '0.5.27'},
			capabilities: ['feed_event'],
		});
		expect(hello.protocolVersion).toBe(1);
		expect(normalizeFrame(hello)).toEqual(hello);
	});

	it('rejects a hello without a protocol version', () => {
		expect(HelloFrameSchema.safeParse({type: 'hello'}).success).toBe(false);
	});
});

describe('FRAME_NAME_MAP', () => {
	it('maps every old name to exactly one new name', () => {
		expect(FRAME_NAME_MAP).toEqual({
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
		});
	});
});

describe('normalizeFrame', () => {
	it.each(pairs)(
		'$legacy.type normalises to the same value as $canonical.type',
		({legacy, canonical}) => {
			expect(normalizeFrame(legacy)).toEqual(canonical);
			expect(normalizeFrame(canonical)).toEqual(canonical);
		},
	);

	it.each(pairs)(
		'$canonical.type round-trips through JSON and back to $legacy.type',
		({legacy, canonical}) => {
			const wire = JSON.parse(JSON.stringify(canonical)) as unknown;
			expect(normalizeFrame(wire)).toEqual(canonical);
			expect(toLegacyFrame(normalizeFrame(wire))).toEqual(legacy);
		},
	);

	it('rejects a frame under an unknown name', () => {
		expect(() => normalizeFrame({type: 'nope'})).toThrow();
		expect(FrameSchema.safeParse({type: 'nope'}).success).toBe(false);
	});

	it('rejects a known name with a malformed body', () => {
		expect(() => normalizeFrame({type: 'cancel'})).toThrow();
		expect(() => normalizeFrame({type: 'stop', runId: 42})).toThrow();
	});
});

describe('new-only frames', () => {
	it('steer carries a human turn text for a Run', () => {
		const steer = normalizeFrame({
			type: 'steer',
			runId: 'run_42',
			text: 'Focus on the failing test first.',
		});
		expect(steer).toEqual({
			type: 'steer',
			runId: 'run_42',
			text: 'Focus on the failing test first.',
		});
		expect(() => normalizeFrame({type: 'steer', runId: 'run_42'})).toThrow();
	});

	it('needs_human parks a Run with an Interruption', () => {
		const frame = normalizeFrame({
			type: 'needs_human',
			runId: 'run_42',
			athenaSessionId: 'athena-1',
			interruption: {
				kind: 'blocked',
				reason: 'need the staging credentials',
				message: 'WORKFLOW_BLOCKED: need the staging credentials',
			},
		});
		expect(frame.type).toBe('needs_human');
		expect(() =>
			normalizeFrame({
				type: 'needs_human',
				runId: 'run_42',
				interruption: {kind: 'made_up'},
			}),
		).toThrow();
	});

	it('new-only frames have no legacy form and are returned unchanged', () => {
		const steer = normalizeFrame({type: 'steer', runId: 'r', text: 't'});
		expect(toLegacyFrame(steer)).toEqual(steer);
	});
});
