/**
 * Contract test: the instance-socket traffic this CLI speaks today parses
 * under `@drisp/protocol`, both as recorded (legacy names) and rewritten under
 * the new names, and both forms normalise to the same typed value.
 *
 * Two sources of traffic:
 *   1. `__fixtures__/instanceSocketTraffic.json` — a recording of every frame
 *      in both directions, bodies lifted from the existing socket tests.
 *   2. A live capture: the production `createInstanceSocketClient` sends each
 *      of its frames over a real `ws` socket and we replay what hit the wire.
 *      This is what pins "no runtime code path changes what it sends".
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {WebSocketServer, type WebSocket as ServerWebSocket} from 'ws';
import {
	CanonicalFrameSchema,
	FRAME_NAME_MAP,
	LegacyFrameSchema,
	normalizeFrame,
	toLegacyFrame,
	type LegacyFrame,
} from '@drisp/protocol';
import {createInstanceSocketClient} from './instanceSocketClient';
import traffic from './__fixtures__/instanceSocketTraffic.json';

type Recorded = {direction: string; frame: LegacyFrame};
const recorded = (traffic as {frames: Recorded[]}).frames;

/**
 * The same frame under its new name, built from the documented map alone so
 * the twin does not depend on the normaliser under test.
 */
function underNewName(legacy: LegacyFrame): Record<string, unknown> {
	const {type, ...body} = legacy;
	if (type === 'run_event') return {type: 'event', stream: 'run', ...body};
	if (type === 'feed_event') return {type: 'event', stream: 'feed', ...body};
	return {type: FRAME_NAME_MAP[type], ...body};
}

function jsonRoundTrip(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

describe('recorded instance-socket traffic', () => {
	it('covers every legacy frame name the protocol documents', () => {
		const seen = new Set(recorded.map(r => r.frame.type));
		expect([...seen].sort()).toEqual(Object.keys(FRAME_NAME_MAP).sort());
	});

	it.each(recorded)(
		'$direction $frame.type parses as recorded and normalises like its new-name twin',
		({frame}) => {
			expect(LegacyFrameSchema.safeParse(frame).success).toBe(true);

			const fromLegacy = normalizeFrame(frame);
			const fromNew = normalizeFrame(underNewName(frame));
			expect(fromNew).toEqual(fromLegacy);
			expect(CanonicalFrameSchema.safeParse(fromNew).success).toBe(true);

			// Round trip: canonical → wire JSON → canonical, and back to the
			// legacy form the CLI still emits.
			expect(normalizeFrame(jsonRoundTrip(fromNew))).toEqual(fromLegacy);
			expect(toLegacyFrame(fromNew)).toEqual(frame);
		},
	);

	it('keeps unknown runSpec fields so orthogonal readers still see them', () => {
		const assignment = recorded.find(
			r => r.frame.type === 'job_assignment' && 'runnerId' in r.frame,
		)!.frame;
		const canonical = normalizeFrame(assignment);
		expect(canonical.type).toBe('run.start');
		if (canonical.type !== 'run.start') throw new Error('unreachable');
		expect(canonical.runSpec).toMatchObject({
			artifacts: {upload: {bucket: 'runs'}},
		});
	});
});

describe('live capture of what createInstanceSocketClient emits', () => {
	let server: WebSocketServer;
	let port: number;
	let sockets: ServerWebSocket[] = [];
	const wire: unknown[] = [];

	beforeEach(async () => {
		wire.length = 0;
		sockets = [];
		server = new WebSocketServer({port: 0, host: '127.0.0.1'});
		await new Promise<void>(resolve =>
			server.once('listening', () => resolve()),
		);
		const addr = server.address();
		if (typeof addr !== 'object' || addr === null) throw new Error('no addr');
		port = addr.port;
		server.on('connection', ws => {
			sockets.push(ws);
			ws.on('message', data => wire.push(JSON.parse(String(data))));
		});
	});

	afterEach(async () => {
		for (const ws of sockets) ws.terminate();
		await new Promise<void>(resolve => server.close(() => resolve()));
	});

	it('every frame the client puts on the wire is a legacy frame that normalises and round-trips', async () => {
		const client = createInstanceSocketClient({
			dashboardUrl: `http://127.0.0.1:${port}`,
			instanceId: 'inst_1',
			accessToken: 'access-1',
			heartbeatIntervalMs: 10,
			now: () => 42,
		});
		await client.connect();
		client.sendAssignmentAccepted('run_42');
		client.sendAssignmentRejected({
			runId: 'run_43',
			reason: 'duplicate',
			message: 'duplicate active assignment run_43',
		});
		client.sendRunEvent({
			runId: 'run_42',
			seq: 1,
			ts: 1234,
			kind: 'progress',
			payload: {message: 'assignment received'},
		});
		client.sendFeedEvent({
			deliverySeq: 1,
			envelope: {
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
					data: {message: 'hello', notification_type: 'info'},
				},
			},
		});
		client.sendDecisionAck({athenaSessionId: 'athena-1', requestId: 'req-1'});

		await vi.waitFor(
			() => {
				const types = new Set(wire.map(f => (f as {type: string}).type));
				expect(types).toEqual(
					new Set([
						'ping',
						'assignment_accepted',
						'assignment_rejected',
						'run_event',
						'feed_event',
						'decision_ack',
					]),
				);
			},
			{timeout: 1_000},
		);
		client.close('done');

		for (const captured of wire) {
			const legacy = LegacyFrameSchema.parse(captured);
			const canonical = normalizeFrame(captured);
			expect(normalizeFrame(underNewName(legacy))).toEqual(canonical);
			expect(toLegacyFrame(canonical)).toEqual(captured);
		}
	});
});
