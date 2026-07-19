import {type WebSocket} from 'ws';
import {createFramedConnection, type RawChannel} from './framedConnection';
import {type FramedConnection} from './types';

/**
 * Wrap a live {@link WebSocket} as a {@link FramedConnection}. Shared by the WS
 * server and WS client transports, which differ only in their trace label
 * (`'ws'` vs `'ws-client'`) and peer string.
 */
export function createWsConnection(
	ws: WebSocket,
	peer: string,
	traceTag: string,
): FramedConnection {
	return createFramedConnection(peer, wsRawChannel(ws, traceTag));
}

function wsRawChannel(ws: WebSocket, traceTag: string): RawChannel {
	return {
		kind: 'ws',
		traceTag,
		isOpen: () => ws.readyState === ws.OPEN,
		writeFrame: frame => ws.send(JSON.stringify(frame)),
		close: () => ws.close(),
		onMessage: cb => {
			ws.on('message', data => cb(data.toString()));
		},
		onClose: cb => {
			ws.on('close', cb);
		},
		onError: cb => {
			ws.on('error', cb);
		},
	};
}
