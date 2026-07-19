import {Buffer} from 'node:buffer';
import {StringDecoder} from 'node:string_decoder';

export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

export class LineReaderOverflowError extends Error {
	constructor(limit: number) {
		super(`NDJSON line exceeded ${limit} bytes`);
		this.name = 'LineReaderOverflowError';
	}
}

export class LineReader {
	private buffer = '';
	// Streams UTF-8 across chunk boundaries: a multi-byte sequence split by a
	// stream `data` event is buffered here until complete, never truncated to
	// U+FFFD the way a per-chunk `Buffer.toString('utf-8')` would.
	private decoder = new StringDecoder('utf8');
	private readonly maxBytes: number;
	constructor(maxBytes: number = DEFAULT_MAX_LINE_BYTES) {
		this.maxBytes = maxBytes;
	}
	push(chunk: Buffer | string): string[] {
		const incoming =
			typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
		// Measured in bytes (the wire limit), not UTF-16 code units.
		if (
			Buffer.byteLength(this.buffer) + Buffer.byteLength(incoming) >
			this.maxBytes
		) {
			this.reset();
			throw new LineReaderOverflowError(this.maxBytes);
		}
		this.buffer += incoming;
		const lines: string[] = [];
		let idx = this.buffer.indexOf('\n');
		while (idx !== -1) {
			let line = this.buffer.slice(0, idx);
			if (line.endsWith('\r')) line = line.slice(0, -1);
			if (line.length > 0) lines.push(line);
			this.buffer = this.buffer.slice(idx + 1);
			idx = this.buffer.indexOf('\n');
		}
		return lines;
	}
	private reset(): void {
		this.buffer = '';
		this.decoder = new StringDecoder('utf8');
	}
}

export function encodeLine(value: unknown): string {
	return JSON.stringify(value) + '\n';
}
