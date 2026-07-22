import {traceGatewayFrame} from './trace';
import {type FramedConnection, type TransportKind} from './types';

/**
 * The thin, transport-specific half of a {@link FramedConnection}: a raw
 * bidirectional channel that knows only how to move a single serialized frame
 * across the wire. Each transport (UDS, WS server, WS client) supplies one of
 * these; everything above it — parse/reject, dispatch to handlers, tracing and
 * the send guard — lives once in {@link createFramedConnection}.
 */
export type RawChannel = {
	/** Wire kind surfaced on the resulting {@link FramedConnection}. */
	readonly kind: TransportKind;
	/** Label used for gateway trace lines (e.g. 'uds', 'ws', 'ws-client'). */
	readonly traceTag: string;
	/** Whether the channel can currently accept a write. */
	isOpen: () => boolean;
	/** Serialize and transmit one frame (channel owns any framing). */
	writeFrame: (frame: unknown) => void;
	/** Close/destroy the underlying transport. */
	close: () => void;
	/** Register a handler fired once per decoded frame text. */
	onMessage: (cb: (text: string) => void) => void;
	/** Register a handler fired when the channel closes. */
	onClose: (cb: () => void) => void;
	/** Register a handler fired on a transport error. */
	onError: (cb: (err: Error) => void) => void;
};

/**
 * Build a {@link FramedConnection} over a {@link RawChannel}. Owns the shared
 * parse-dispatch-trace-send machinery that was previously copied into every
 * transport: the three handler Sets and their identical unsubscribe blocks,
 * JSON parsing with reject-on-garbage, inbound/outbound tracing, and the
 * writable guard on send.
 */
export function createFramedConnection(
	peer: string,
	channel: RawChannel,
): FramedConnection {
	const frameHandlers = new Set<(frame: unknown) => void>();
	const closeHandlers = new Set<() => void>();
	const errorHandlers = new Set<(err: Error) => void>();

	channel.onMessage(text => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			channel.close();
			return;
		}
		traceGatewayFrame(channel.traceTag, peer, 'in', parsed);
		for (const handler of frameHandlers) handler(parsed);
	});

	channel.onError(err => {
		for (const handler of errorHandlers) handler(err);
	});

	channel.onClose(() => {
		for (const handler of closeHandlers) handler();
	});

	return {
		kind: channel.kind,
		peer,
		send: frame => {
			if (!channel.isOpen()) return;
			traceGatewayFrame(channel.traceTag, peer, 'out', frame);
			channel.writeFrame(frame);
		},
		close: () => channel.close(),
		onFrame: cb => {
			frameHandlers.add(cb);
			return () => frameHandlers.delete(cb);
		},
		onClose: cb => {
			closeHandlers.add(cb);
			return () => closeHandlers.delete(cb);
		},
		onError: cb => {
			errorHandlers.add(cb);
			return () => errorHandlers.delete(cb);
		},
	};
}
