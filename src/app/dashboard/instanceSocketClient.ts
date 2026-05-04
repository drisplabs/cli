import {WebSocket} from 'ws';

export type InstanceSocketFrame =
	| {type: 'ping'; ts: number}
	| {type: 'pong'; ts: number}
	| {type: 'job_assignment'; runId: string; runSpec?: unknown}
	| {type: 'assignment_accepted'; runId: string}
	| {type: 'cancel'; runId: string}
	| {type: 'error'; code: string; message?: string};

export type InstanceSocketLogger = (
	level: 'debug' | 'info' | 'warn' | 'error',
	message: string,
) => void;

export type InstanceSocketClientOptions = {
	dashboardUrl: string;
	instanceId: string;
	accessToken: string;
	heartbeatIntervalMs?: number;
	log?: InstanceSocketLogger;
	makeWebSocket?: (url: string, headers: Record<string, string>) => WebSocket;
	now?: () => number;
};

export type InstanceSocketClient = {
	connect(): Promise<void>;
	close(reason?: string): void;
	onFrame(handler: (frame: InstanceSocketFrame) => void): void;
	onClose(handler: (reason: string) => void): void;
};

const DEFAULT_HEARTBEAT_MS = 30_000;

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
	const log = opts.log ?? (() => {});
	const now = opts.now ?? (() => Date.now());
	const makeWebSocket =
		opts.makeWebSocket ??
		((url: string, headers: Record<string, string>): WebSocket =>
			new WebSocket(url, {headers}));

	const frameHandlers = new Set<(frame: InstanceSocketFrame) => void>();
	const closeHandlers = new Set<(reason: string) => void>();
	let ws: WebSocket | null = null;
	let heartbeat: NodeJS.Timeout | null = null;

	function send(frame: InstanceSocketFrame): void {
		if (!ws || ws.readyState !== ws.OPEN) return;
		try {
			ws.send(JSON.stringify(frame));
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

	function handleFrame(parsed: InstanceSocketFrame): void {
		if (parsed.type === 'job_assignment') {
			send({type: 'assignment_accepted', runId: parsed.runId});
			log('info', `instance socket: assignment accepted runId=${parsed.runId}`);
		}
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

	async function connect(): Promise<void> {
		if (ws) throw new Error('instance socket already connected');
		const url = instanceSocketUrl(opts.dashboardUrl, opts.instanceId);
		const next = makeWebSocket(url, {
			Authorization: `Bearer ${opts.accessToken}`,
		});
		ws = next;

		await new Promise<void>((resolve, reject) => {
			const onOpen = (): void => {
				next.off('error', onError);
				resolve();
			};
			const onError = (err: Error): void => {
				next.off('open', onOpen);
				reject(new Error(`instance socket connect failed: ${err.message}`));
			};
			next.once('open', onOpen);
			next.once('error', onError);
		});

		startHeartbeat();

		next.on('message', data => {
			let parsed: InstanceSocketFrame;
			try {
				parsed = JSON.parse(String(data)) as InstanceSocketFrame;
			} catch (err) {
				log(
					'warn',
					`instance socket frame parse failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
				return;
			}
			handleFrame(parsed);
		});

		next.on('close', (_code, reasonBuf) => {
			if (next !== ws) return;
			ws = null;
			const reason = reasonBuf.toString() || 'closed';
			emitClose(reason);
		});

		next.on('error', err => {
			log('warn', `instance socket error: ${err.message}`);
		});
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

	function onFrame(handler: (frame: InstanceSocketFrame) => void): void {
		frameHandlers.add(handler);
	}

	function onClose(handler: (reason: string) => void): void {
		closeHandlers.add(handler);
	}

	return {connect, close, onFrame, onClose};
}
