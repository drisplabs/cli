import {Buffer} from 'node:buffer';
import {describe, expect, it} from 'vitest';
import {
	DEFAULT_MAX_LINE_BYTES,
	encodeLine,
	LineReader,
	LineReaderOverflowError,
} from './framing';

describe('LineReader', () => {
	it('emits one line per complete NDJSON frame', () => {
		const reader = new LineReader();
		expect(reader.push('{"a":1}\n')).toEqual(['{"a":1}']);
	});

	it('splits multiple frames delivered in a single chunk', () => {
		const reader = new LineReader();
		expect(reader.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
	});

	it('reassembles a frame delivered across chunk boundaries', () => {
		const reader = new LineReader();
		expect(reader.push('{"a":')).toEqual([]);
		expect(reader.push('1}\n')).toEqual(['{"a":1}']);
	});

	it('strips a trailing CR so CRLF-framed lines parse', () => {
		const reader = new LineReader();
		expect(reader.push('{"a":1}\r\n')).toEqual(['{"a":1}']);
	});

	it('skips blank lines', () => {
		const reader = new LineReader();
		expect(reader.push('\n{"a":1}\n\n')).toEqual(['{"a":1}']);
	});

	// Finding 1: a multi-byte UTF-8 sequence split across two `data` events must
	// not corrupt to U+FFFD. TCP/UDS fragment at arbitrary byte offsets.
	it('does not corrupt a multi-byte UTF-8 char split across chunks', () => {
		const reader = new LineReader();
		// U+1F600 😀 encodes to 4 bytes: f0 9f 98 80. Split it 2 + 2.
		const frame = Buffer.from('{"m":"😀"}\n', 'utf-8');
		const emojiStart = frame.indexOf(0xf0);
		const first = frame.subarray(0, emojiStart + 2);
		const second = frame.subarray(emojiStart + 2);

		expect(reader.push(first)).toEqual([]);
		const lines = reader.push(second);

		expect(lines).toEqual(['{"m":"😀"}']);
		expect(lines[0]).not.toContain('�');
		expect(JSON.parse(lines[0]!).m).toBe('😀');
	});

	it('handles a multi-byte char split across three chunks', () => {
		const reader = new LineReader();
		const frame = Buffer.from('{"m":"€"}\n', 'utf-8'); // U+20AC = e2 82 ac (3 bytes)
		const start = frame.indexOf(0xe2);
		expect(reader.push(frame.subarray(0, start + 1))).toEqual([]);
		expect(reader.push(frame.subarray(start + 1, start + 2))).toEqual([]);
		expect(reader.push(frame.subarray(start + 2))).toEqual(['{"m":"€"}']);
	});

	it('throws LineReaderOverflowError past the byte limit and resets', () => {
		const reader = new LineReader(8);
		expect(() => reader.push('123456789')).toThrow(LineReaderOverflowError);
		// After overflow the buffer is cleared: a fresh complete frame still parses.
		expect(reader.push('{"a":1}\n')).toEqual(['{"a":1}']);
	});

	it('counts the byte limit in bytes, not UTF-16 code units', () => {
		// 4 chars but 8 UTF-8 bytes worth (2 bytes each). maxBytes=4 must reject.
		const reader = new LineReader(4);
		expect(() => reader.push('©©©©')).toThrow(LineReaderOverflowError);
	});

	it('exposes a sane default byte limit', () => {
		expect(DEFAULT_MAX_LINE_BYTES).toBe(1024 * 1024);
	});
});

describe('encodeLine', () => {
	it('serializes a value and terminates it with a newline', () => {
		expect(encodeLine({a: 1})).toBe('{"a":1}\n');
	});

	it('round-trips through LineReader', () => {
		const reader = new LineReader();
		expect(reader.push(encodeLine({hello: 'wörld 😀'}))).toEqual([
			'{"hello":"wörld 😀"}',
		]);
	});
});
