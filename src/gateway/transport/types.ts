export type TransportKind = 'uds' | 'ws';

export class TransportUnreachableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TransportUnreachableError';
	}
}

export type FramedConnection = {
	readonly kind: TransportKind;
	readonly peer: string;
	send: (frame: unknown) => void;
	close: () => void;
	onFrame: (cb: (frame: unknown) => void) => () => void;
	onClose: (cb: () => void) => () => void;
	onError: (cb: (err: Error) => void) => () => void;
};

/**
 * Transport-owned snapshot of where a started listener is reachable. The daemon
 * maps this up to the protocol `ListenerStatusEntry`, adding policy fields
 * (insecure/loopback) that the transport does not own. Keep this shape small and
 * in transport vocabulary (`ws`, not the protocol's `tcp`) — the protocol type
 * must not leak down into the transport layer.
 */
export type ListenerDescription =
	| {kind: 'uds'; socketPath: string}
	| {kind: 'ws'; host: string; port: number; url: string; tls: boolean};

export type ServerTransport = {
	readonly kind: TransportKind;
	listen: (onConnection: (connection: FramedConnection) => void) => Promise<{
		close: () => Promise<void>;
	}>;
	/**
	 * Describe where this listener is reachable. Valid only after `listen()`
	 * resolves; may throw before then (a WS listener has no resolved port yet).
	 */
	describe: () => ListenerDescription;
};

export type ClientTransport = {
	readonly kind: TransportKind;
	connect: () => Promise<FramedConnection>;
};
