import {describe, it, expect, afterEach} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {createTranscriptReader} from './transcript';

function tmpFile(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
	return path.join(dir, 'transcript.jsonl');
}

const cleanups: string[] = [];

afterEach(() => {
	for (const f of cleanups) {
		try {
			fs.unlinkSync(f);
			fs.rmdirSync(path.dirname(f));
		} catch {
			// ignore
		}
	}
	cleanups.length = 0;
});

function writeLines(filePath: string, lines: unknown[]): void {
	fs.writeFileSync(
		filePath,
		lines.map(l => JSON.stringify(l)).join('\n') + '\n',
	);
	cleanups.push(filePath);
}

function appendLines(filePath: string, lines: unknown[]): void {
	fs.appendFileSync(
		filePath,
		lines.map(l => JSON.stringify(l)).join('\n') + '\n',
	);
}

describe('createTranscriptReader', () => {
	it('extracts assistant text from string content', () => {
		const f = tmpFile();
		writeLines(f, [
			{type: 'user', message: {role: 'user', content: 'hello'}},
			{type: 'assistant', message: {role: 'assistant', content: 'Hi there!'}},
		]);

		const reader = createTranscriptReader();
		const msgs = reader.readNewAssistantMessages(f);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]!.text).toBe('Hi there!');
	});

	it('extracts assistant text from content array', () => {
		const f = tmpFile();
		writeLines(f, [
			{
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [
						{type: 'thinking', thinking: 'hmm'},
						{type: 'text', text: 'Let me read that file.'},
						{type: 'tool_use', id: 't1', name: 'Read', input: {}},
					],
				},
			},
		]);

		const reader = createTranscriptReader();
		const msgs = reader.readNewAssistantMessages(f);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]!.text).toBe('Let me read that file.');
	});

	it('skips non-assistant entries', () => {
		const f = tmpFile();
		writeLines(f, [
			{type: 'user', message: {role: 'user', content: 'hello'}},
			{type: 'tool_result', message: {role: 'tool', content: 'ok'}},
		]);

		const reader = createTranscriptReader();
		const msgs = reader.readNewAssistantMessages(f);
		expect(msgs).toHaveLength(0);
	});

	it('reads incrementally using byte offsets', () => {
		const f = tmpFile();
		writeLines(f, [
			{
				type: 'assistant',
				message: {role: 'assistant', content: 'First message'},
			},
		]);

		const reader = createTranscriptReader();
		const first = reader.readNewAssistantMessages(f);
		expect(first).toHaveLength(1);
		expect(first[0]!.text).toBe('First message');

		// Append more lines
		appendLines(f, [
			{
				type: 'assistant',
				message: {role: 'assistant', content: 'Second message'},
			},
		]);

		const second = reader.readNewAssistantMessages(f);
		expect(second).toHaveLength(1);
		expect(second[0]!.text).toBe('Second message');
	});

	it('returns empty array when file does not exist', () => {
		const reader = createTranscriptReader();
		const msgs = reader.readNewAssistantMessages('/nonexistent/path.jsonl');
		expect(msgs).toHaveLength(0);
	});

	it('skips empty text content', () => {
		const f = tmpFile();
		writeLines(f, [
			{type: 'assistant', message: {role: 'assistant', content: '   '}},
			{
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [
						{type: 'text', text: '  '},
						{type: 'text', text: ''},
					],
				},
			},
		]);

		const reader = createTranscriptReader();
		const msgs = reader.readNewAssistantMessages(f);
		expect(msgs).toHaveLength(0);
	});

	it('joins multiple text blocks in a single entry', () => {
		const f = tmpFile();
		writeLines(f, [
			{
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [
						{type: 'text', text: 'Part one.'},
						{type: 'text', text: 'Part two.'},
					],
				},
			},
		]);

		const reader = createTranscriptReader();
		const msgs = reader.readNewAssistantMessages(f);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]!.text).toBe('Part one.\nPart two.');
	});

	it('preserves timestamp from entry', () => {
		const f = tmpFile();
		writeLines(f, [
			{
				type: 'assistant',
				timestamp: '2025-01-01T00:00:00Z',
				message: {role: 'assistant', content: 'hello'},
			},
		]);

		const reader = createTranscriptReader();
		const msgs = reader.readNewAssistantMessages(f);
		expect(msgs[0]!.timestamp).toBe('2025-01-01T00:00:00Z');
	});

	it('tracks byte offset correctly', () => {
		const f = tmpFile();
		writeLines(f, [
			{type: 'assistant', message: {role: 'assistant', content: 'msg1'}},
		]);

		const reader = createTranscriptReader();
		expect(reader.getOffset(f)).toBe(0);
		reader.readNewAssistantMessages(f);
		expect(reader.getOffset(f)).toBeGreaterThan(0);

		// Second read with no new data returns empty
		const msgs = reader.readNewAssistantMessages(f);
		expect(msgs).toHaveLength(0);
	});

	it('handles malformed JSON lines gracefully', () => {
		const f = tmpFile();
		fs.writeFileSync(
			f,
			'not json\n{"type":"assistant","message":{"role":"assistant","content":"valid"}}\n',
		);
		cleanups.push(f);

		const reader = createTranscriptReader();
		const msgs = reader.readNewAssistantMessages(f);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]!.text).toBe('valid');
	});

	it('does not lose a line that is still being flushed (partial-tail read)', () => {
		// Repro: a hook fires while Claude is mid-write. The file ends with a
		// partial line (no trailing newline). On the next read, the rest of that
		// line plus subsequent lines are appended. The partial line must survive
		// across both reads — not be split + dropped on the seam.
		const f = tmpFile();
		const fullLine = JSON.stringify({
			type: 'assistant',
			message: {role: 'assistant', content: 'first'},
		});
		const partialLine = JSON.stringify({
			type: 'assistant',
			message: {role: 'assistant', content: 'mid-flush message'},
		});
		// First write: one complete line + a partial of the next (no \n at end).
		const partialPrefixLen = Math.floor(partialLine.length / 2);
		fs.writeFileSync(
			f,
			`${fullLine}\n${partialLine.slice(0, partialPrefixLen)}`,
		);
		cleanups.push(f);

		const reader = createTranscriptReader();
		const first = reader.readNewAssistantMessages(f);
		expect(first.map(m => m.text)).toEqual(['first']);

		// Now finish the partial line and append a third complete line.
		fs.appendFileSync(
			f,
			`${partialLine.slice(partialPrefixLen)}\n${JSON.stringify({
				type: 'assistant',
				message: {role: 'assistant', content: 'third'},
			})}\n`,
		);

		const second = reader.readNewAssistantMessages(f);
		expect(second.map(m => m.text)).toEqual(['mid-flush message', 'third']);
	});

	it('returns empty when the entire read buffer has no complete line', () => {
		const f = tmpFile();
		fs.writeFileSync(f, '{"type":"assistant","message":{"role":"assistant"');
		cleanups.push(f);

		const reader = createTranscriptReader();
		expect(reader.readNewAssistantMessages(f)).toEqual([]);
		expect(reader.getOffset(f)).toBe(0);
	});
});
