import {WebSocket} from 'ws';
import {readFileSync} from 'node:fs';
import {
	TransportUnreachableError,
	type ClientTransport,
	type FramedConnection,
} from './types';
import {createWsConnection} from './wsChannel';

export type WsClientTransportOptions = {
	url: string;
	timeoutMs?: number;
	/** Custom CA bundle path for self-signed gateway certs. */
	tlsCaPath?: string;
};

export function createWsClientTransport(
	opts: WsClientTransportOptions,
): ClientTransport {
	return {
		kind: 'ws',
		connect: () => connectWs(opts),
	};
}

/**
 * Build a `WsClientTransportOptions`-shaped object that omits `tlsCaPath`
 * when undefined, so spreading the result doesn't write the optional key.
 */
export function wsClientOptionsForEndpoint(input: {
	url: string;
	timeoutMs?: number;
	tlsCaPath?: string;
}): WsClientTransportOptions {
	return {
		url: input.url,
		...(input.timeoutMs !== undefined ? {timeoutMs: input.timeoutMs} : {}),
		...(input.tlsCaPath !== undefined ? {tlsCaPath: input.tlsCaPath} : {}),
	};
}

async function connectWs(
	opts: WsClientTransportOptions,
): Promise<FramedConnection> {
	const timeoutMs = opts.timeoutMs ?? 5_000;
	const wsOpts = opts.tlsCaPath ? {ca: readFileSync(opts.tlsCaPath)} : {};
	const ws = new WebSocket(opts.url, wsOpts);

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			ws.close();
			reject(
				new TransportUnreachableError(`connect timed out after ${timeoutMs}ms`),
			);
		}, timeoutMs);
		ws.once('open', () => {
			clearTimeout(timer);
			resolve();
		});
		ws.once('error', err => {
			clearTimeout(timer);
			reject(
				new TransportUnreachableError(
					`gateway not reachable at ${opts.url}: ${err.message}`,
				),
			);
		});
	});

	return createWsConnection(ws, opts.url, 'ws-client');
}
