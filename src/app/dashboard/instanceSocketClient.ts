import {WebSocket} from 'ws';
import {
	PROTOCOL_VERSION,
	hello,
	safeNormalizeFrame,
	toLegacyFrame,
	type AssignmentRejectedFrame,
	type CanonicalFrame,
	type DecisionAckFrame,
	type FeedStreamEventFrame,
	type HelloFrame,
	type NeedsHumanFrame,
	type RunStreamEventFrame,
} from '@drisp/protocol';

export type InstanceSocketLogger = (
	level: 'debug' | 'info' | 'warn' | 'error',
	message: string,
) => void;

/**
 * Which frame-name set this connection puts on the wire. Every frame is built
 * under its canonical name; `legacy` rewrites it through `toLegacyFrame()` at
 * the socket boundary for a hub that has not migrated. A connection starts
 * `legacy` and becomes `canonical` only once the hub's `hello` announces the
 * protocol version this runner speaks (protocol doc §17).
 */
export type InstanceSocketWireMode = 'legacy' | 'canonical';

export type InstanceSocketClientOptions = {
	dashboardUrl: string;
	instanceId: string;
	accessToken: string;
	heartbeatIntervalMs?: number;
	connectTimeoutMs?: number;
	log?: InstanceSocketLogger;
	/**
	 * Test seam. Production code uses the default factory which constructs a
	 * `ws` `WebSocket` with the access token sent as the first
	 * `Sec-WebSocket-Protocol` value. The dashboard's instance-socket
	 * extractor accepts the token via subprotocol or `?token=` query — we
	 * use subprotocol so browser clients (which cannot set arbitrary
	 * headers, including `Authorization`) follow the same contract.
	 */
	makeWebSocket?: (url: string, accessToken: string) => WebSocket;
	now?: () => number;
};

export type InstanceSocketClient = {
	connect(): Promise<void>;
	close(reason?: string): void;
	/** Every inbound frame, already normalised to its canonical name. */
	onFrame(handler: (frame: CanonicalFrame) => void): void;
	onClose(handler: (reason: string) => void): void;
	/** The frame-name set currently on the wire for this connection. */
	wireMode(): InstanceSocketWireMode;
	sendAssignmentAccepted(runId: string): void;
	sendAssignmentRejected(input: Omit<AssignmentRejectedFrame, 'type'>): void;
	sendRunEvent(event: Omit<RunStreamEventFrame, 'type' | 'stream'>): void;
	sendFeedEvent(event: Omit<FeedStreamEventFrame, 'type' | 'stream'>): void;
	sendNeedsHuman(input: Omit<NeedsHumanFrame, 'type'>): void;
	sendDecisionAck(input: Omit<DecisionAckFrame, 'type'>): void;
};

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export function instanceSocketUrl(
	dashboardUrl: string,
	instanceId: string,
): string {
	const url = new URL(dashboardUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.pathname = `/api/instances/${encodeURIComponent(instanceId)}/socket`;
	url.search = '';
	url.hash = '';
	return url.toString();
}

export function createInstanceSocketClient(
	opts: InstanceSocketClientOptions,
): InstanceSocketClient {
	const heartbeatMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
	const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	const log = opts.log ?? (() => {});
	const now = opts.now ?? (() => Date.now());
	const makeWebSocket =
		opts.makeWebSocket ??
		((url: string, accessToken: string): WebSocket =>
			new WebSocket(url, [accessToken]));

	const frameHandlers = new Set<(frame: CanonicalFrame) => void>();
	const closeHandlers = new Set<(reason: string) => void>();
	let ws: WebSocket | null = null;
	let heartbeat: NodeJS.Timeout | null = null;
	let droppedSinceClose = 0;
	let wireMode: InstanceSocketWireMode = 'legacy';

	function send(frame: CanonicalFrame): void {
		if (!ws || ws.readyState !== ws.OPEN) {
			droppedSinceClose += 1;
			if (droppedSinceClose === 1) {
				log(
					'warn',
					`instance socket dropped frame (socket not open): type=${frame.type}`,
				);
			}
			return;
		}
		droppedSinceClose = 0;
		const onWire = wireMode === 'legacy' ? toLegacyFrame(frame) : frame;
		try {
			ws.send(JSON.stringify(onWire));
		} catch (err) {
			log(
				'warn',
				`instance socket send failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	function startHeartbeat(): void {
		stopHeartbeat();
		const interval = setInterval(() => {
			send({type: 'ping', ts: now()});
		}, heartbeatMs);
		interval.unref();
		heartbeat = interval;
	}

	function stopHeartbeat(): void {
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
	}

	function emitClose(reason: string): void {
		stopHeartbeat();
		for (const handler of [...closeHandlers]) {
			try {
				handler(reason);
			} catch {
				// listeners must not break shutdown
			}
		}
	}

	function handleFrame(parsed: CanonicalFrame): void {
		for (const handler of [...frameHandlers]) {
			try {
				handler(parsed);
			} catch (err) {
				log(
					'warn',
					`instance socket frame handler threw: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		}
	}

	/**
	 * The hub's `hello` decides the wire mode for the rest of this connection.
	 * A version we speak switches emission to the canonical names; a version
	 * we do not speak is answered with an `error` and the socket is closed
	 * (the reconnect loop owns what happens next). Returns whether the frame
	 * should still reach the frame handlers.
	 */
	function handleHello(frame: HelloFrame): boolean {
		if (frame.protocolVersion === PROTOCOL_VERSION) {
			wireMode = 'canonical';
			log(
				'info',
				`instance socket: hub speaks protocol v${frame.protocolVersion}; emitting canonical frame names`,
			);
			return true;
		}
		const message = `hub announced protocol v${frame.protocolVersion}; this runner speaks v${PROTOCOL_VERSION}`;
		log('error', `instance socket: ${message}`);
		send({type: 'error', code: 'unsupported_protocol_version', message});
		// A client-initiated close does not fire the `ws` close listener for
		// this socket (it is no longer `ws`), so tell the owner directly: the
		// daemon must know the control channel is gone.
		close('unsupported protocol version');
		emitClose('unsupported protocol version');
		return false;
	}

	function receive(data: unknown): void {
		let json: unknown;
		try {
			json = JSON.parse(String(data));
		} catch (err) {
			const message = `instance socket frame is not JSON: ${
				err instanceof Error ? err.message : String(err)
			}`;
			log('warn', message);
			send({type: 'error', code: 'malformed_frame', message});
			return;
		}
		const parsed = safeNormalizeFrame(json);
		if (!parsed.success) {
			const type =
				typeof json === 'object' && json !== null && 'type' in json
					? String((json as {type: unknown}).type)
					: 'unknown';
			const message = `instance socket frame rejected (type=${type}): ${parsed.error.message}`;
			log('warn', message);
			send({type: 'error', code: 'malformed_frame', message});
			return;
		}
		const frame = parsed.frame;
		if (frame.type === 'hello' && !handleHello(frame)) return;
		handleFrame(frame);
	}

	async function connect(): Promise<void> {
		if (ws) throw new Error('instance socket already connected');
		const url = instanceSocketUrl(opts.dashboardUrl, opts.instanceId);
		const next = makeWebSocket(url, opts.accessToken);

		// Listen before the upgrade completes: a hub that greets us with its
		// `hello` right after the upgrade can deliver it in the same read as
		// the handshake, i.e. synchronously after `open` and before any
		// continuation of the promise below would have attached a listener.
		next.on('message', receive);
		next.on('close', (_code, reasonBuf) => {
			if (next !== ws) return;
			ws = null;
			const reason = reasonBuf.toString() || 'closed';
			emitClose(reason);
		});
		next.on('error', err => {
			log('warn', `instance socket error: ${err.message}`);
		});

		try {
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const cleanup = (): void => {
					next.off('open', onOpen);
					next.off('error', onError);
					clearTimeout(timer);
				};
				const onOpen = (): void => {
					if (settled) return;
					settled = true;
					cleanup();
					// Adopt the socket synchronously on `open` so a frame that
					// arrives in the same tick is received (and answerable).
					ws = next;
					// A fresh connection starts on the legacy names until the
					// hub's hello says otherwise.
					wireMode = 'legacy';
					resolve();
				};
				const onError = (err: Error): void => {
					if (settled) return;
					settled = true;
					cleanup();
					reject(new Error(`instance socket connect failed: ${err.message}`));
				};
				const timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					cleanup();
					reject(
						new Error(
							`instance socket connect failed: timed out after ${connectTimeoutMs}ms`,
						),
					);
				}, connectTimeoutMs);
				next.once('open', onOpen);
				next.once('error', onError);
			});
		} catch (err) {
			// The permanent 'error' listener above also swallows any late
			// 'error' events emitted by terminate() so they don't surface as
			// unhandled — `ws` re-emits an error when the underlying socket is
			// torn down before the upgrade completes.
			try {
				next.terminate();
			} catch {
				// best-effort
			}
			throw err;
		}

		// First frame on the wire: who we are and which protocol we speak.
		send(hello({role: 'runner', instanceId: opts.instanceId}));
		startHeartbeat();
	}

	function close(reason?: string): void {
		stopHeartbeat();
		if (ws) {
			try {
				ws.close(1000, reason ?? 'client closed');
			} catch {
				ws.terminate();
			}
		}
		ws = null;
	}

	function onFrame(handler: (frame: CanonicalFrame) => void): void {
		frameHandlers.add(handler);
	}

	function onClose(handler: (reason: string) => void): void {
		closeHandlers.add(handler);
	}

	function sendAssignmentAccepted(runId: string): void {
		send({type: 'assignment_accepted', runId});
		log('info', `instance socket: assignment accepted runId=${runId}`);
	}

	function sendAssignmentRejected(
		input: Omit<AssignmentRejectedFrame, 'type'>,
	): void {
		send({type: 'assignment_rejected', ...input});
		log(
			'info',
			`instance socket: assignment rejected runId=${input.runId} reason=${input.reason}`,
		);
	}

	function sendRunEvent(
		event: Omit<RunStreamEventFrame, 'type' | 'stream'>,
	): void {
		send({type: 'event', stream: 'run', ...event});
	}

	function sendFeedEvent(
		event: Omit<FeedStreamEventFrame, 'type' | 'stream'>,
	): void {
		send({type: 'event', stream: 'feed', ...event});
	}

	function sendNeedsHuman(input: Omit<NeedsHumanFrame, 'type'>): void {
		send({type: 'needs_human', ...input});
		log(
			'info',
			`instance socket: needs_human runId=${input.runId} kind=${input.interruption.kind}`,
		);
	}

	function sendDecisionAck(input: Omit<DecisionAckFrame, 'type'>): void {
		send({type: 'decision_ack', ...input});
	}

	return {
		connect,
		close,
		onFrame,
		onClose,
		wireMode: () => wireMode,
		sendAssignmentAccepted,
		sendAssignmentRejected,
		sendRunEvent,
		sendFeedEvent,
		sendNeedsHuman,
		sendDecisionAck,
	};
}
