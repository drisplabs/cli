import {describe, expect, it, vi} from 'vitest';
import {createStreamJsonToolParser} from './streamJsonToolParser';

describe('createStreamJsonToolParser', () => {
	it('extracts tool results from top-level stream-json records', () => {
		const onToolResult = vi.fn();
		const onToolUse = vi.fn();
		const parser = createStreamJsonToolParser(onToolResult, onToolUse);

		parser.feed(
			JSON.stringify({
				type: 'message',
				role: 'assistant',
				content: [{type: 'tool_use', id: 'tool-1', name: 'browser'}],
			}) + '\n',
		);
		parser.feed(
			JSON.stringify({
				type: 'tool_result',
				tool_use_id: 'tool-1',
				content: [{type: 'text', text: 'hello'}],
			}) + '\n',
		);

		expect(onToolResult).toHaveBeenCalledWith({
			tool_use_id: 'tool-1',
			tool_name: 'browser',
			content: 'hello',
		});
		expect(onToolUse).toHaveBeenCalledWith({
			tool_use_id: 'tool-1',
			tool_name: 'browser',
		});
	});

	it('unwraps stream_event envelopes emitted by include-partial-messages mode', () => {
		const onToolResult = vi.fn();
		const parser = createStreamJsonToolParser(onToolResult);

		parser.feed(
			JSON.stringify({
				type: 'stream_event',
				event: {
					type: 'message',
					role: 'assistant',
					content: [{type: 'tool_use', id: 'tool-2', name: 'search'}],
				},
			}) + '\n',
		);
		parser.feed(
			JSON.stringify({
				type: 'stream_event',
				event: {
					type: 'tool_result',
					tool_use_id: 'tool-2',
					content: [{type: 'text', text: 'partial output'}],
				},
			}) + '\n',
		);

		expect(onToolResult).toHaveBeenCalledWith({
			tool_use_id: 'tool-2',
			tool_name: 'search',
			content: 'partial output',
		});
	});

	it('emits assistant text deltas from content_block_delta frames, threading item_id from message_start', () => {
		const onMessageDelta = vi.fn();
		const parser = createStreamJsonToolParser(
			vi.fn(),
			undefined,
			onMessageDelta,
		);

		parser.feed(
			JSON.stringify({
				type: 'stream_event',
				event: {
					type: 'message_start',
					message: {id: 'msg-1', role: 'assistant'},
				},
			}) + '\n',
		);
		parser.feed(
			JSON.stringify({
				type: 'stream_event',
				event: {
					type: 'content_block_delta',
					index: 0,
					delta: {type: 'text_delta', text: 'Hello'},
				},
			}) + '\n',
		);
		parser.feed(
			JSON.stringify({
				type: 'stream_event',
				event: {
					type: 'content_block_delta',
					index: 0,
					delta: {type: 'text_delta', text: ' world'},
				},
			}) + '\n',
		);

		expect(onMessageDelta).toHaveBeenNthCalledWith(1, {
			item_id: 'msg-1',
			delta: 'Hello',
		});
		expect(onMessageDelta).toHaveBeenNthCalledWith(2, {
			item_id: 'msg-1',
			delta: ' world',
		});
	});

	it('ignores non-text content_block_delta frames (e.g. input_json_delta)', () => {
		const onMessageDelta = vi.fn();
		const parser = createStreamJsonToolParser(
			vi.fn(),
			undefined,
			onMessageDelta,
		);

		parser.feed(
			JSON.stringify({
				type: 'stream_event',
				event: {
					type: 'content_block_delta',
					index: 0,
					delta: {type: 'input_json_delta', partial_json: '{"a":'},
				},
			}) + '\n',
		);

		expect(onMessageDelta).not.toHaveBeenCalled();
	});

	it('emits message.complete with the full assistant text and item_id on the final message', () => {
		const onMessageComplete = vi.fn();
		const parser = createStreamJsonToolParser(
			vi.fn(),
			undefined,
			undefined,
			onMessageComplete,
		);

		parser.feed(
			JSON.stringify({
				type: 'assistant',
				message: {
					id: 'msg-1',
					role: 'assistant',
					content: [{type: 'text', text: 'Hello world'}],
				},
			}) + '\n',
		);

		expect(onMessageComplete).toHaveBeenCalledWith({
			item_id: 'msg-1',
			message: 'Hello world',
		});
	});

	it('does not emit message.complete for a tool-use-only assistant message', () => {
		const onMessageComplete = vi.fn();
		const parser = createStreamJsonToolParser(
			vi.fn(),
			undefined,
			undefined,
			onMessageComplete,
		);

		parser.feed(
			JSON.stringify({
				type: 'assistant',
				message: {
					id: 'msg-2',
					role: 'assistant',
					content: [{type: 'tool_use', id: 'tool-9', name: 'Bash', input: {}}],
				},
			}) + '\n',
		);

		expect(onMessageComplete).not.toHaveBeenCalled();
	});
});
