/**
 * Parses Claude Code's stream-json stdout for tool result and assistant
 * message events.
 *
 * Claude Code outputs NDJSON when run with `--output-format stream-json`.
 * This parser extracts tool_result entries (emitted as tool.delta) and, when
 * `--include-partial-messages` is on, incremental assistant text deltas plus
 * the terminal assistant message (emitted as message.delta / message.complete)
 * so assistant text streams into the feed via AgentMessageStream. This is the
 * single source of truth for assistant text — no MessageDisplay hook.
 *
 * Token usage is parsed elsewhere (tokenAccumulator). The separate
 * assistantMessageAccumulator produces the non-feed TurnExecutionResult
 * snapshot and does not enter the feed.
 */

export type StreamToolResult = {
	tool_use_id: string | undefined;
	tool_name: string | undefined;
	content: string;
};

export type StreamMessageDelta = {
	item_id: string | undefined;
	delta: string;
};

export type StreamMessageComplete = {
	item_id: string | undefined;
	message: string;
};

type StreamToolResultCallback = (result: StreamToolResult) => void;
type StreamToolUseCallback = (toolUse: {
	tool_use_id: string;
	tool_name: string;
}) => void;
type StreamMessageDeltaCallback = (delta: StreamMessageDelta) => void;
type StreamMessageCompleteCallback = (message: StreamMessageComplete) => void;

type StreamJsonMessage = {
	type?: string;
	role?: string;
	tool_use_id?: string;
	content?: unknown;
	subtype?: string;
	name?: string;
	// Nested message envelope (type: "assistant" wraps message)
	message?: {
		role?: string;
		content?: unknown[];
		[key: string]: unknown;
	};
	event?: StreamJsonMessage;
	[key: string]: unknown;
};

/**
 * Extract text from a tool_result content field.
 * Content can be a string or an array of content blocks.
 */
function extractResultText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === 'object' && block !== null) {
			const rec = block as Record<string, unknown>;
			if (rec['type'] === 'text' && typeof rec['text'] === 'string') {
				parts.push(rec['text']);
			}
		}
	}
	return parts.join('\n');
}

/**
 * Concatenate `text` blocks from an assistant message's content array.
 * Joined with '' so the reconstructed text matches the incremental
 * text_delta stream (which the accumulator concatenates without separators).
 */
function extractAssistantText(content: unknown): string {
	if (!Array.isArray(content)) return '';
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === 'object' && block !== null) {
			const rec = block as Record<string, unknown>;
			if (rec['type'] === 'text' && typeof rec['text'] === 'string') {
				parts.push(rec['text']);
			}
		}
	}
	return parts.join('');
}

/**
 * Track active tool uses so we can resolve tool_name for tool_result events.
 * stream-json outputs assistant messages with tool_use content blocks before
 * the corresponding tool_result events.
 */
export function createStreamJsonToolParser(
	onToolResult: StreamToolResultCallback,
	onToolUse?: StreamToolUseCallback,
	onMessageDelta?: StreamMessageDeltaCallback,
	onMessageComplete?: StreamMessageCompleteCallback,
) {
	let buffer = '';
	const toolNameById = new Map<string, string>();
	// The Anthropic message id of the in-flight assistant message, captured
	// from message_start. Keys the incremental text deltas to the same item_id
	// the terminal assistant message carries, so AgentMessageStream flushes the
	// pending delta bucket exactly once (no doubled final message).
	let currentMessageId: string | undefined;

	function processLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;

		let parsed: StreamJsonMessage;
		try {
			parsed = JSON.parse(trimmed) as StreamJsonMessage;
		} catch {
			return;
		}

		const record =
			parsed.type === 'stream_event' && parsed.event ? parsed.event : parsed;

		// Capture the assistant message id so text deltas thread the same item_id.
		if (record.type === 'message_start') {
			const id = record.message?.['id'];
			if (typeof id === 'string') currentMessageId = id;
		}

		// Incremental assistant text: content_block_delta / text_delta frames
		// (only present under --include-partial-messages).
		if (record.type === 'content_block_delta') {
			const delta = record['delta'];
			if (typeof delta === 'object' && delta !== null) {
				const d = delta as Record<string, unknown>;
				if (d['type'] === 'text_delta' && typeof d['text'] === 'string') {
					onMessageDelta?.({item_id: currentMessageId, delta: d['text']});
				}
			}
		}

		// Track tool_use blocks from assistant messages to resolve tool names
		// Format: {type: "assistant", message: {content: [{type: "tool_use", id, name, ...}]}}
		// or: {type: "message", role: "assistant", content: [{type: "tool_use", id, name, ...}]}
		const contentBlocks =
			(record.type === 'assistant'
				? record.message?.content
				: record.type === 'message' && record.role === 'assistant'
					? (record.content as unknown[] | undefined)
					: undefined) ?? [];

		for (const block of contentBlocks) {
			if (typeof block !== 'object' || block === null) continue;
			const rec = block as Record<string, unknown>;
			if (
				rec['type'] === 'tool_use' &&
				typeof rec['id'] === 'string' &&
				typeof rec['name'] === 'string'
			) {
				toolNameById.set(rec['id'], rec['name']);
				onToolUse?.({tool_use_id: rec['id'], tool_name: rec['name']});
			}
		}

		// Terminal assistant message: emit the full assistant text as
		// message.complete. Flushes the pending delta bucket keyed by item_id.
		// Skipped for tool-use-only messages (no text blocks).
		if (
			record.type === 'assistant' ||
			(record.type === 'message' && record.role === 'assistant')
		) {
			const messageText = extractAssistantText(contentBlocks);
			if (messageText) {
				const idValue =
					record.type === 'assistant' ? record.message?.['id'] : record['id'];
				const itemId = typeof idValue === 'string' ? idValue : currentMessageId;
				onMessageComplete?.({item_id: itemId, message: messageText});
			}
		}

		// Emit tool_result events
		if (record.type === 'tool_result') {
			const toolUseId =
				typeof record.tool_use_id === 'string' ? record.tool_use_id : undefined;
			const text = extractResultText(record.content);
			if (text) {
				onToolResult({
					tool_use_id: toolUseId,
					tool_name: toolUseId ? toolNameById.get(toolUseId) : undefined,
					content: text,
				});
			}
		}
	}

	return {
		feed(chunk: string): void {
			buffer += chunk;
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				processLine(line);
			}
		},
		flush(): void {
			if (buffer.trim()) {
				processLine(buffer);
				buffer = '';
			}
		},
	};
}
