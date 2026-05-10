/**
 * Length-prefixed JSON frame codec for UDS IPC.
 * Frame format: `<byteLen>\n<utf8Body>` where byteLen is the byte length of the body.
 * Shared by the UDS server (handleConnection) and client (sendUdsRequest).
 */

import net from 'node:net';

export const DEFAULT_MAX_FRAME_BYTES = 1_000_000;

export type FrameReadResult =
	| {ok: true; body: Buffer; rest: Buffer}
	| {ok: false; error: string; rest: Buffer};

/**
 * Try to read one frame from `buffer`. Returns `null` when there are not yet
 * enough bytes for a complete frame.  Returns `{ok: false}` when the length
 * header is malformed or exceeds `maxBodyBytes`.
 */
export function tryReadFrame(
	buffer: Buffer,
	maxBodyBytes = DEFAULT_MAX_FRAME_BYTES,
): FrameReadResult | null {
	const newlineIdx = buffer.indexOf(0x0a);
	if (newlineIdx < 0) return null;

	const lenStr = buffer.subarray(0, newlineIdx).toString('utf-8');
	const len = Number.parseInt(lenStr, 10);
	if (!Number.isFinite(len) || len < 0 || len > maxBodyBytes) {
		return {
			ok: false,
			error: `uds bad framing header: ${JSON.stringify(lenStr.slice(0, 32))}`,
			rest: buffer.subarray(newlineIdx + 1),
		};
	}

	if (buffer.length < newlineIdx + 1 + len) return null;

	const body = buffer.subarray(newlineIdx + 1, newlineIdx + 1 + len);
	const rest = buffer.subarray(newlineIdx + 1 + len);
	return {ok: true, body, rest};
}

/** Write a single length-prefixed JSON frame to a socket. */
export function writeFrame(socket: net.Socket, value: unknown): void {
	const body = JSON.stringify(value);
	const buf = Buffer.from(body, 'utf-8');
	socket.write(`${buf.length}\n`);
	socket.write(buf);
}
