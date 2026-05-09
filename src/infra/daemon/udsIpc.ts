import fs from 'node:fs';
import net from 'node:net';

/**
 * Length-prefixed JSON protocol over UDS. Each frame is `<len>\n<body>` where
 * `len` is the byte length of the UTF-8 body. The terminator on the body is
 * implied by the length, so partial reads from the socket are safe.
 */
export type UdsRequest =
	| {cmd: 'status'}
	| {cmd: 'stop'; reason?: string}
	| {cmd: 'restart'}
	| {cmd: 'reload'}
	| {cmd: 'runs'; active?: boolean; limit?: number};

export type UdsRunRecord = {
	runId: string;
	startedAt: number;
	endedAt?: number;
	status: 'running' | 'completed' | 'failed' | 'cancelled' | 'rejected';
	error?: string;
};

export type UdsResponse =
	| {
			ok: true;
			cmd: 'status';
			pid: number;
			startedAt: number;
			socketConnected: boolean;
			lastFrameAt?: number;
			activeRuns: number;
			completedRuns: number;
			instanceId?: string;
			dashboardUrl?: string;
			refreshState?: {
				recentFailures: number;
				cooldownUntilMs?: number;
			};
	  }
	| {ok: true; cmd: 'stop'}
	| {ok: true; cmd: 'restart'}
	| {ok: true; cmd: 'reload'}
	| {ok: true; cmd: 'runs'; runs: UdsRunRecord[]}
	| {ok: false; error: string};

export type UdsHandler = (
	req: UdsRequest,
) => Promise<UdsResponse> | UdsResponse;

export type UdsServerLogger = (
	level: 'debug' | 'info' | 'warn' | 'error',
	message: string,
) => void;

export type UdsServer = {
	close(): Promise<void>;
};

/**
 * Bind a UDS server at `socketPath`, mode 0600 (Unix file permission scope is
 * the caller's user). Caller-supplied handler receives parsed requests and
 * returns the response synchronously or asynchronously.
 *
 * If a stale socket file exists at the path (no listener), it is removed
 * before binding. If a live listener is detected (EADDRINUSE on listen),
 * we surface the error rather than racing.
 *
 * Pass `log` to surface protocol-level errors (bad framing, socket errors)
 * that would otherwise be silent.
 */
export async function startUdsServer(
	socketPath: string,
	handler: UdsHandler,
	log?: UdsServerLogger,
): Promise<UdsServer> {
	await unlinkStaleSocket(socketPath);

	const server = net.createServer(socket => {
		void handleConnection(socket, handler, log);
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(socketPath, () => {
			server.off('error', reject);
			resolve();
		});
	});

	if (process.platform !== 'win32') {
		try {
			fs.chmodSync(socketPath, 0o600);
		} catch {
			// best-effort
		}
	}

	return {
		async close(): Promise<void> {
			await new Promise<void>(resolve => {
				server.close(() => resolve());
			});
			try {
				fs.unlinkSync(socketPath);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
					// best-effort
				}
			}
		},
	};
}

async function handleConnection(
	socket: net.Socket,
	handler: UdsHandler,
	log?: UdsServerLogger,
): Promise<void> {
	let buffer = Buffer.alloc(0);
	socket.on('data', chunk => {
		const chunkBuf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
		buffer = Buffer.concat([buffer, chunkBuf]);
		void drain();
	});
	socket.on('error', err => {
		log?.('warn', `uds socket error: ${err.message}`);
		try {
			socket.destroy();
		} catch {
			// best-effort
		}
	});

	async function drain(): Promise<void> {
		for (;;) {
			const newlineIdx = buffer.indexOf(0x0a);
			if (newlineIdx < 0) return;
			const lenStr = buffer.subarray(0, newlineIdx).toString('utf-8');
			const len = Number.parseInt(lenStr, 10);
			if (!Number.isFinite(len) || len < 0 || len > 1_000_000) {
				log?.(
					'warn',
					`uds bad framing header: ${JSON.stringify(lenStr.slice(0, 32))}`,
				);
				socket.destroy();
				return;
			}
			if (buffer.length < newlineIdx + 1 + len) return;
			const body = buffer.subarray(newlineIdx + 1, newlineIdx + 1 + len);
			buffer = buffer.subarray(newlineIdx + 1 + len);
			let parsed: UdsRequest;
			try {
				parsed = JSON.parse(body.toString('utf-8')) as UdsRequest;
			} catch {
				log?.('warn', 'uds invalid request body');
				writeFrame(socket, {ok: false, error: 'invalid request body'});
				continue;
			}
			let response: UdsResponse;
			try {
				response = await handler(parsed);
			} catch (err) {
				response = {
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				};
			}
			writeFrame(socket, response);
		}
	}
}

function writeFrame(socket: net.Socket, response: UdsResponse): void {
	const body = JSON.stringify(response);
	const buf = Buffer.from(body, 'utf-8');
	socket.write(`${buf.length}\n`);
	socket.write(buf);
}

export type UdsClientOptions = {
	timeoutMs?: number;
};

export async function sendUdsRequest(
	socketPath: string,
	request: UdsRequest,
	options: UdsClientOptions = {},
): Promise<UdsResponse> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	return await new Promise<UdsResponse>((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let buffer = Buffer.alloc(0);
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			socket.destroy();
			reject(new Error(`uds request timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref?.();

		const finish = (action: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				socket.end();
			} catch {
				// best-effort
			}
			action();
		};

		socket.on('connect', () => {
			const body = JSON.stringify(request);
			const buf = Buffer.from(body, 'utf-8');
			socket.write(`${buf.length}\n`);
			socket.write(buf);
		});

		socket.on('data', chunk => {
			const chunkBuf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
			buffer = Buffer.concat([buffer, chunkBuf]);
			const newlineIdx = buffer.indexOf(0x0a);
			if (newlineIdx < 0) return;
			const len = Number.parseInt(
				buffer.subarray(0, newlineIdx).toString('utf-8'),
				10,
			);
			if (!Number.isFinite(len)) {
				finish(() => reject(new Error('uds reply malformed')));
				return;
			}
			if (buffer.length < newlineIdx + 1 + len) return;
			const body = buffer
				.subarray(newlineIdx + 1, newlineIdx + 1 + len)
				.toString('utf-8');
			let parsed: UdsResponse;
			try {
				parsed = JSON.parse(body) as UdsResponse;
			} catch (err) {
				finish(() =>
					reject(
						new Error(
							`uds reply parse failed: ${
								err instanceof Error ? err.message : String(err)
							}`,
						),
					),
				);
				return;
			}
			finish(() => resolve(parsed));
		});

		socket.on('error', err => {
			finish(() => reject(err));
		});
		socket.on('close', () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error('uds socket closed before reply'));
		});
	});
}

async function unlinkStaleSocket(socketPath: string): Promise<void> {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(socketPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw err;
	}
	if (!stat.isSocket()) {
		throw new Error(
			`uds path ${socketPath} exists and is not a socket; refusing to remove`,
		);
	}
	// Probe: try to connect; if it fails with ECONNREFUSED, the socket is stale.
	const alive = await new Promise<boolean>(resolve => {
		const probe = net.createConnection(socketPath);
		const done = (value: boolean): void => {
			try {
				probe.destroy();
			} catch {
				// best-effort
			}
			resolve(value);
		};
		probe.once('connect', () => done(true));
		probe.once('error', () => done(false));
	});
	if (alive) {
		throw new Error(
			`uds path ${socketPath} is in use by another process; aborting`,
		);
	}
	fs.unlinkSync(socketPath);
}
