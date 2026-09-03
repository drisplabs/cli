import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
	WebSocketServer,
	type WebSocket as ServerWebSocket,
	type WebSocket as WS,
} from 'ws';
import {
	FrameSchema,
	HelloFrameSchema,
	PROTOCOL_VERSION,
	type CanonicalFrame,
	type InstalledWorkflow,
} from '@drisp/protocol';
import {
	createInstanceSocketClient,
	instanceSocketUrl,
} from './instanceSocketClient';

describe('instanceSocketUrl', () => {
	it('upgrades https to wss', () => {
		expect(instanceSocketUrl('https://example.com', 'inst_1')).toBe(
			'wss://example.com/api/instances/inst_1/socket',
		);
	});

	it('upgrades http to ws and preserves port', () => {
		expect(instanceSocketUrl('http://localhost:5173', 'inst_1')).toBe(
			'ws://localhost:5173/api/instances/inst_1/socket',
		);
	});

	it('drops trailing path, query, and hash from dashboard url', () => {
		expect(
			instanceSocketUrl('https://example.com/app?x=1#frag', 'inst_2'),
		).toBe('wss://example.com/api/instances/inst_2/socket');
	});

	it('encodes instance ids with special chars', () => {
		expect(instanceSocketUrl('https://example.com', 'inst/1')).toBe(
			'wss://example.com/api/instances/inst%2F1/socket',
		);
	});
});

describe('createInstanceSocketClient', () => {
	let server: WebSocketServer;
	let port: number;
	let serverSockets: ServerWebSocket[] = [];

	beforeEach(async () => {
		server = new WebSocketServer({port: 0, host: '127.0.0.1'});
		await new Promise<void>(resolve =>
			server.once('listening', () => resolve()),
		);
		const addr = server.address();
		if (typeof addr !== 'object' || addr === null) throw new Error('no addr');
		port = addr.port;
		serverSockets = [];
		server.on('connection', ws => {
			serverSockets.push(ws);
		});
	});

	afterEach(async () => {
		for (const ws of serverSockets) ws.terminate();
		await new Promise<void>(resolve => server.close(() => resolve()));
	});

	it('connects and sends ping frames on the heartbeat interval', async () => {
		const received: unknown[] = [];
		server.once('connection', ws => {
			ws.on('message', data => {
				received.push(JSON.parse(String(data)));
			});
		});

		const client = createInstanceSocketClient({
			dashboardUrl: `http://127.0.0.1:${port}`,
			instanceId: 'inst_1',
			accessToken: 'access-1',
			heartbeatIntervalMs: 10,
			now: () => 42,
		});
		await client.connect();

		await vi.waitFor(
			() => {
				expect(received.length).toBeGreaterThanOrEqual(3);
			},
			{timeout: 1_000},
		);

		client.close('done');
		// The first frame is the hello; the heartbeat pings follow it.
		expect(received[0]).toEqual(expect.objectContaining({type: 'hello'}));
		expect(received[1]).toEqual({type: 'ping', ts: 42});
		expect(received[2]).toEqual({type: 'ping', ts: 42});
	});

	it('sends the access token via Sec-WebSocket-Protocol (browser-compatible auth)', async () => {
		let proto: string | string[] | undefined;
		let auth: string | string[] | undefined;
		// Echo the requested subprotocol so the handshake completes (the dashboard
		// instance-socket extractor enforces this contract too).
		server.options.handleProtocols = (
			protocols: Set<string>,
		): string | false => {
			const first = [...protocols][0];
			return first ?? false;
		};
		server.once('connection', (_ws, req) => {
			proto = req.headers['sec-websocket-protocol'];
			auth = req.headers['authorization'];
		});

		const client = createInstanceSocketClient({
			dashboardUrl: `http://127.0.0.1:${port}`,
			instanceId: 'inst_1',
			accessToken: 'super-access-token',
			heartbeatIntervalMs: 60_000,
		});
		await client.connect();
		await vi.waitFor(() => expect(proto).toBeDefined(), {timeout: 1_000});
		expect(proto).toBe('super-access-token');
		expect(auth).toBeUndefined();
		client.close('done');
	});

	it('rejects connect when neither open nor error fires within connectTimeoutMs', async () => {
		const {EventEmitter} = await import('node:events');
		// Fake WebSocket that never emits open or error and tolerates terminate().
		const fakeWs = new EventEmitter() as EventEmitter & {
			terminate: () => void;
			readyState: number;
			OPEN: number;
		};
		fakeWs.terminate = () => {};
		fakeWs.readyState = 0;
		fakeWs.OPEN = 1;

		const client = createInstanceSocketClient({
			dashboardUrl: 'http://127.0.0.1:1',
			instanceId: 'inst_1',
			accessToken: 'access-1',
			heartbeatIntervalMs: 60_000,
			connectTimeoutMs: 80,
			makeWebSocket: () => fakeWs as unknown as WS,
		});
		await expect(client.connect()).rejects.toThrow(/timed out after 80ms/);
	});

	it('delivers a legacy job_assignment as a canonical run.start without auto-acking it', async () => {
		const received: unknown[] = [];
		server.once('connection', ws => {
			ws.on('message', data => {
				received.push(JSON.parse(String(data)));
			});
			setTimeout(() => {
				ws.send(
					JSON.stringify({
						type: 'job_assignment',
						runId: 'run_42',
						runSpec: {goal: 'noop'},
					}),
				);
			}, 5);
		});

		const seenFrames: unknown[] = [];
		const client = createInstanceSocketClient({
			dashboardUrl: `http://127.0.0.1:${port}`,
			instanceId: 'inst_1',
			accessToken: 'access-1',
			heartbeatIntervalMs: 60_000,
		});
		client.onFrame(frame => seenFrames.push(frame));
		await client.connect();

		await vi.waitFor(() => {
			expect(seenFrames).toContainEqual(
				expect.objectContaining({type: 'run.start', runId: 'run_42'}),
			);
		});
		expect(
			received.some(
				r =>
					typeof r === 'object' &&
					r !== null &&
					(r as {type?: string}).type === 'assignment_accepted',
			),
		).toBe(false);
		expect(seenFrames).toContainEqual(
			expect.objectContaining({type: 'run.start', runId: 'run_42'}),
		);
		expect(seenFrames).not.toContainEqual(
			expect.objectContaining({type: 'job_assignment'}),
		);
		client.close('done');
	});

	it('emits close handler when the server terminates the socket', async () => {
		server.once('connection', ws => {
			setTimeout(() => ws.close(1011, 'server gone'), 5);
		});

		const closes: string[] = [];
		const client = createInstanceSocketClient({
			dashboardUrl: `http://127.0.0.1:${port}`,
			instanceId: 'inst_1',
			accessToken: 'access-1',
			heartbeatIntervalMs: 60_000,
		});
		client.onClose(reason => closes.push(reason));
		await client.connect();

		await vi.waitFor(
			() => {
				expect(closes.length).toBeGreaterThan(0);
			},
			{timeout: 1_000},
		);
		expect(closes[0]).toContain('server gone');
	});

	it('sendRunEvent writes a legacy run_event frame to the wire when the hub has not announced a protocol version', async () => {
		const received: unknown[] = [];
		server.once('connection', ws => {
			ws.on('message', data => {
				received.push(JSON.parse(String(data)));
			});
		});

		const client = createInstanceSocketClient({
			dashboardUrl: `http://127.0.0.1:${port}`,
			instanceId: 'inst_1',
			accessToken: 'access-1',
			heartbeatIntervalMs: 60_000,
		});
		await client.connect();
		client.sendRunEvent({
			runId: 'run_42',
			seq: 1,
			ts: 1234,
			kind: 'progress',
			payload: {message: 'hi'},
		});
		await vi.waitFor(
			() => {
				expect(
					received.some(
						r =>
							typeof r === 'object' &&
							r !== null &&
							(r as {type?: string}).type === 'run_event',
					),
				).toBe(true);
			},
			{timeout: 1_000},
		);
		const frame = received.find(
			r =>
				typeof r === 'object' &&
				r !== null &&
				(r as {type?: string}).type === 'run_event',
		);
		expect(frame).toEqual({
			type: 'run_event',
			runId: 'run_42',
			seq: 1,
			ts: 1234,
			kind: 'progress',
			payload: {message: 'hi'},
		});
		client.close('done');
	});

	it('sendAssignmentRejected writes an assignment_rejected frame to the wire', async () => {
		const received: unknown[] = [];
		server.once('connection', ws => {
			ws.on('message', data => {
				received.push(JSON.parse(String(data)));
			});
		});

		const client = createInstanceSocketClient({
			dashboardUrl: `http://127.0.0.1:${port}`,
			instanceId: 'inst_1',
			accessToken: 'access-1',
			heartbeatIntervalMs: 60_000,
		});
		await client.connect();
		client.sendAssignmentRejected({
			runId: 'run_42',
			reason: 'local_capacity',
			message: 'runtime daemon at concurrency cap',
		});

		await vi.waitFor(
			() => {
				expect(received).toContainEqual({
					type: 'assignment_rejected',
					runId: 'run_42',
					reason: 'local_capacity',
					message: 'runtime daemon at concurrency cap',
				});
			},
			{timeout: 1_000},
		);
		client.close('done');
	});

	it('sendDecisionAck writes a decision_ack frame to the wire', async () => {
		const received: unknown[] = [];
		server.once('connection', ws => {
			ws.on('message', data => {
				received.push(JSON.parse(String(data)));
			});
		});
		const client = createInstanceSocketClient({
			dashboardUrl: `http://127.0.0.1:${port}`,
			instanceId: 'inst_1',
			accessToken: 'access-1',
			heartbeatIntervalMs: 60_000,
		});
		await client.connect();

		client.sendDecisionAck({
			athenaSessionId: 'athena-1',
			requestId: 'req-1',
		});

		await vi.waitFor(
			() => {
				expect(
					received.some(
						r =>
							typeof r === 'object' &&
							r !== null &&
							(r as {type?: string}).type === 'decision_ack',
					),
				).toBe(true);
			},
			{timeout: 1_000},
		);
		expect(
			received.find(
				r =>
					typeof r === 'object' &&
					r !== null &&
					(r as {type?: string}).type === 'decision_ack',
			),
		).toEqual({
			type: 'decision_ack',
			athenaSessionId: 'athena-1',
			requestId: 'req-1',
		});
		client.close('done');
	});

	it('rejects connect when ws emits error before open', async () => {
		const client = createInstanceSocketClient({
			dashboardUrl: 'http://127.0.0.1:1', // unused port
			instanceId: 'inst_1',
			accessToken: 'access-1',
			heartbeatIntervalMs: 60_000,
		});
		await expect(client.connect()).rejects.toThrow(
			/instance socket connect failed/,
		);
	});
});

describe('createInstanceSocketClient: protocol handshake and wire mode', () => {
	let server: WebSocketServer;
	let port: number;
	let serverSockets: ServerWebSocket[] = [];

	beforeEach(async () => {
		server = new WebSocketServer({port: 0, host: '127.0.0.1'});
		await new Promise<void>(resolve =>
			server.once('listening', () => resolve()),
		);
		const addr = server.address();
		if (typeof addr !== 'object' || addr === null) throw new Error('no addr');
		port = addr.port;
		serverSockets = [];
		server.on('connection', ws => {
			serverSockets.push(ws);
		});
	});

	afterEach(async () => {
		for (const ws of serverSockets) ws.terminate();
		await new Promise<void>(resolve => server.close(() => resolve()));
	});

	type Hub = {
		wire: Array<Record<string, unknown>>;
		send(frame: unknown): void;
		sendRaw(text: string): void;
		socket(): ServerWebSocket;
	};

	function hub(): Hub {
		const wire: Array<Record<string, unknown>> = [];
		let socket: ServerWebSocket | null = null;
		server.once('connection', ws => {
			socket = ws;
			ws.on('message', data => {
				wire.push(JSON.parse(String(data)) as Record<string, unknown>);
			});
		});
		return {
			wire,
			send: frame => socket?.send(JSON.stringify(frame)),
			sendRaw: text => socket?.send(text),
			socket: () => {
				if (!socket) throw new Error('hub socket not connected');
				return socket;
			},
		};
	}

	function makeClient(
		overrides: {
			heartbeatIntervalMs?: number;
			installedWorkflows?: () => InstalledWorkflow[];
		} = {},
	) {
		return createInstanceSocketClient({
			dashboardUrl: `http://127.0.0.1:${port}`,
			instanceId: 'inst_1',
			accessToken: 'access-1',
			heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 60_000,
			now: () => 42,
			...(overrides.installedWorkflows
				? {installedWorkflows: overrides.installedWorkflows}
				: {}),
		});
	}

	const runEvent = {
		runId: 'run_42',
		seq: 1,
		ts: 1234,
		kind: 'progress',
		payload: {message: 'hi'},
	};

	const feedEvent = {
		deliverySeq: 3,
		envelope: {
			instanceId: 'inst_1',
			athenaSessionId: 'athena-1',
			runId: 'athena-1:R1',
			origin: 'local' as const,
			eventId: 'athena-1:feed-1',
			feedSeq: 3,
			emittedAt: 1_700_000_000_000,
			feedEvent: {
				event_id: 'feed-1',
				seq: 1,
				ts: 1_700_000_000_000,
				session_id: 'athena-1',
				run_id: 'athena-1:R1',
				kind: 'notification' as const,
				level: 'info' as const,
				actor_id: 'root',
				title: 'hello',
				data: {message: 'hello', notification_type: 'info'},
			},
		},
	};

	it('sends a versioned hello as the first frame on connect', async () => {
		const h = hub();
		const client = makeClient({heartbeatIntervalMs: 10});
		await client.connect();

		await vi.waitFor(() => expect(h.wire.length).toBeGreaterThanOrEqual(2));
		client.close('done');

		expect(h.wire[0]).toEqual({
			type: 'hello',
			protocolVersion: PROTOCOL_VERSION,
			role: 'runner',
			instanceId: 'inst_1',
		});
		expect(h.wire[1]).toEqual({type: 'ping', ts: 42});
	});

	it('the hello carries the installed workflows read at connect time', async () => {
		const h = hub();
		let inventory = [
			{name: 'default', version: '0.6.0', source: {kind: 'builtin' as const}},
			{
				name: 'review',
				version: '1.2.0',
				source: {
					kind: 'marketplace-remote' as const,
					ref: 'review@acme/workflows',
				},
			},
		];
		const client = makeClient({
			heartbeatIntervalMs: 60_000,
			installedWorkflows: () => inventory,
		});
		await client.connect();
		await vi.waitFor(() => expect(h.wire.length).toBeGreaterThanOrEqual(1));
		expect(h.wire[0]).toEqual({
			type: 'hello',
			protocolVersion: PROTOCOL_VERSION,
			role: 'runner',
			instanceId: 'inst_1',
			workflows: inventory,
		});
		expect(HelloFrameSchema.safeParse(h.wire[0]).success).toBe(true);
		client.close('done');

		// A reconnect re-reads the inventory rather than replaying the first.
		inventory = inventory.slice(0, 1);
		const h2 = hub();
		const again = makeClient({
			heartbeatIntervalMs: 60_000,
			installedWorkflows: () => inventory,
		});
		await again.connect();
		await vi.waitFor(() => expect(h2.wire.length).toBeGreaterThanOrEqual(1));
		expect(h2.wire[0]).toEqual(
			expect.objectContaining({type: 'hello', workflows: inventory}),
		);
		again.close('done');
	});

	it.each(['legacy', 'canonical'] as const)(
		'workflows.changed is a full-list replace that goes out unchanged in %s mode',
		async mode => {
			const h = hub();
			const client = makeClient({heartbeatIntervalMs: 60_000});
			await client.connect();
			if (mode === 'canonical') {
				h.send({type: 'hello', protocolVersion: PROTOCOL_VERSION, role: 'hub'});
				await vi.waitFor(() => expect(client.wireMode()).toBe('canonical'));
			}
			client.sendWorkflowsChanged([
				{name: 'default', source: {kind: 'builtin'}},
			]);
			await vi.waitFor(() =>
				expect(h.wire.some(f => f['type'] === 'workflows.changed')).toBe(true),
			);
			const frame = h.wire.find(f => f['type'] === 'workflows.changed');
			expect(frame).toEqual({
				type: 'workflows.changed',
				workflows: [{name: 'default', source: {kind: 'builtin'}}],
			});
			expect(FrameSchema.safeParse(frame).success).toBe(true);
			client.close('done');
		},
	);

	it('emits legacy names by default (no hub hello) and reports wireMode legacy', async () => {
		const h = hub();
		const client = makeClient();
		await client.connect();
		expect(client.wireMode()).toBe('legacy');

		client.sendRunEvent(runEvent);
		client.sendFeedEvent(feedEvent);
		client.sendNeedsHuman({
			runId: 'run_42',
			athenaSessionId: 'athena-1',
			interruption: {
				kind: 'blocked',
				message: 'agent declared NEEDS_HUMAN',
			},
		});

		await vi.waitFor(() => expect(h.wire.length).toBeGreaterThanOrEqual(4));
		client.close('done');

		expect(h.wire.slice(1)).toEqual([
			{type: 'run_event', ...runEvent},
			{type: 'feed_event', ...feedEvent},
			{
				type: 'needs_human',
				runId: 'run_42',
				athenaSessionId: 'athena-1',
				interruption: {
					kind: 'blocked',
					message: 'agent declared NEEDS_HUMAN',
				},
			},
		]);
	});

	it('switches to canonical names once the hub announces the protocol version it speaks', async () => {
		const h = hub();
		const client = makeClient();
		const frames: CanonicalFrame[] = [];
		client.onFrame(frame => frames.push(frame));
		await client.connect();

		h.send({type: 'hello', protocolVersion: PROTOCOL_VERSION, role: 'hub'});
		await vi.waitFor(() => expect(client.wireMode()).toBe('canonical'));
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: 'hello',
				protocolVersion: PROTOCOL_VERSION,
			}),
		);

		client.sendRunEvent(runEvent);
		client.sendFeedEvent(feedEvent);
		client.sendAssignmentAccepted('run_42');
		client.sendDecisionAck({athenaSessionId: 'athena-1', requestId: 'req-1'});

		await vi.waitFor(() => expect(h.wire.length).toBeGreaterThanOrEqual(5));
		client.close('done');

		expect(h.wire.slice(1)).toEqual([
			{type: 'event', stream: 'run', ...runEvent},
			{type: 'event', stream: 'feed', ...feedEvent},
			{type: 'assignment_accepted', runId: 'run_42'},
			{type: 'decision_ack', athenaSessionId: 'athena-1', requestId: 'req-1'},
		]);
	});

	it('normalises every inbound frame to its canonical name before handlers see it', async () => {
		const h = hub();
		const client = makeClient();
		const frames: CanonicalFrame[] = [];
		client.onFrame(frame => frames.push(frame));
		await client.connect();

		const decision = {
			type: 'json',
			source: 'user',
			intent: {kind: 'permission_allow'},
		};
		h.send({type: 'job_assignment', runId: 'run_old', runSpec: {prompt: 'a'}});
		h.send({type: 'run.start', runId: 'run_new', runSpec: {prompt: 'b'}});
		h.send({
			type: 'dashboard_decision',
			athenaSessionId: 'athena-1',
			requestId: 'req-old',
			decision,
		});
		h.send({
			type: 'answer',
			athenaSessionId: 'athena-1',
			requestId: 'req-new',
			decision,
		});
		h.send({type: 'cancel', runId: 'run_old'});
		h.send({type: 'stop', runId: 'run_new'});
		h.send({type: 'steer', runId: 'run_new', text: 'try the other branch'});
		h.send({type: 'pong', ts: 1});

		await vi.waitFor(() => expect(frames.length).toBe(8));
		client.close('done');

		expect(frames.map(f => f.type)).toEqual([
			'run.start',
			'run.start',
			'answer',
			'answer',
			'stop',
			'stop',
			'steer',
			'pong',
		]);
		expect(frames[0]).toEqual({
			type: 'run.start',
			runId: 'run_old',
			runSpec: {prompt: 'a'},
		});
		expect(frames[2]).toEqual({
			type: 'answer',
			athenaSessionId: 'athena-1',
			requestId: 'req-old',
			decision,
		});
		expect(frames[4]).toEqual({type: 'stop', runId: 'run_old'});
		expect(frames[6]).toEqual({
			type: 'steer',
			runId: 'run_new',
			text: 'try the other branch',
		});
	});

	it('answers a malformed frame with a typed error frame instead of crashing or dispatching it', async () => {
		const h = hub();
		const client = makeClient();
		const frames: CanonicalFrame[] = [];
		client.onFrame(frame => frames.push(frame));
		await client.connect();

		h.sendRaw('{not json');
		h.send({type: 'bogus', runId: 'x'});
		h.send({type: 'run.start'}); // missing runId
		h.send({type: 'pong', ts: 7});

		await vi.waitFor(() => expect(frames).toEqual([{type: 'pong', ts: 7}]));
		await vi.waitFor(() =>
			expect(h.wire.filter(f => f['type'] === 'error')).toHaveLength(3),
		);
		client.close('done');

		for (const err of h.wire.filter(f => f['type'] === 'error')) {
			expect(err).toEqual({
				type: 'error',
				code: 'malformed_frame',
				message: expect.any(String),
			});
		}
	});

	it('rejects a hub hello with a protocol version it does not speak: error frame, then close', async () => {
		const h = hub();
		const client = makeClient();
		const closes: string[] = [];
		client.onClose(reason => closes.push(reason));
		await client.connect();

		h.send({type: 'hello', protocolVersion: PROTOCOL_VERSION + 1, role: 'hub'});

		await vi.waitFor(() =>
			expect(h.wire).toContainEqual({
				type: 'error',
				code: 'unsupported_protocol_version',
				message: expect.stringContaining(String(PROTOCOL_VERSION)),
			}),
		);
		await vi.waitFor(() => expect(closes.length).toBeGreaterThan(0));
		expect(client.wireMode()).toBe('legacy');
	});
});
