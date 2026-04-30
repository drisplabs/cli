#!/usr/bin/env node
/**
 * Telegram channel subprocess entry point.
 *
 * Speaks Athena's NDJSON channel protocol on stdio. Long-polls Telegram
 * for messages, gates senders against the allowlist supplied in `init`,
 * and routes verdict-shaped replies to `permission.verdict` events.
 */

import process from 'node:process';
import {encodeLine, LineReader, parseMethodMessage} from '../protocol';
import type {
	ChannelEventMessage,
	ChannelMethodMessage,
	ChannelLogLevel,
	ChannelQuestion,
} from '../types';
import {TelegramBot, type TelegramMessage} from './bot';
import {TELEGRAM_CHANNEL_NAME} from './name';
import {
	buildPlainTextQuestionAnswer,
	parseQuestionAnswer,
	parseQuestionAnswerId,
	parseVerdict,
} from './verdict';

type RuntimeState = {
	bot: TelegramBot | null;
	allowedUserIds: Set<string>;
	defaultChatId: string | number | null;
	pendingMessages: Map<string, {chatId: number | string; messageId: number}>;
	pendingQuestionKeys: Map<string, string[]>;
	/** channel_request_ids whose `sendMessage` is in flight. */
	inFlightSends: Set<string>;
	/** Cancel reasons that arrived while a `sendMessage` was in flight. */
	cancelDuringSend: Map<string, string>;
};

const VERSION = '0.1.0';
const NAME = TELEGRAM_CHANNEL_NAME;

function send(event: ChannelEventMessage): void {
	process.stdout.write(encodeLine(event));
}

function log(level: ChannelLogLevel, message: string): void {
	send({event: 'log', params: {level, message}});
}

function sendError(message: string, fatal = false): void {
	send({event: 'error', params: {message, fatal}});
}

function buildPromptText(
	toolName: string,
	description: string,
	inputPreview: string,
	channelRequestId: string,
): string {
	const trimmedPreview = inputPreview.trim();
	const lines: string[] = [`${toolName} — ${description}`];
	if (trimmedPreview.length > 0) {
		lines.push('');
		lines.push(trimmedPreview);
	}
	lines.push('');
	lines.push(
		`Reply "yes ${channelRequestId}" or "no ${channelRequestId}" to respond.`,
	);
	return lines.join('\n');
}

function buildCancelText(reason: string): string {
	return `~ resolved (${reason}) ~`;
}

function buildQuestionText(
	title: string,
	questions: ChannelQuestion[],
	channelRequestId: string,
): string {
	const lines: string[] = [title.trim() || 'Question'];
	for (const [index, q] of questions.entries()) {
		lines.push('');
		lines.push(`${index + 1}. ${q.header}: ${q.question}`);
		if (q.options.length > 0) {
			for (const option of q.options) {
				const suffix = option.description ? ` — ${option.description}` : '';
				lines.push(`   - ${option.label}${suffix}`);
			}
		}
	}
	lines.push('');
	if (questions.length <= 1) {
		lines.push(
			`Reply with your answer, or "answer ${channelRequestId} your response".`,
		);
	} else {
		lines.push(
			`Reply 'answer ${channelRequestId} {"Question":"Answer"}' to respond.`,
		);
	}
	return lines.join('\n');
}

async function startBot(
	state: RuntimeState,
	options: Record<string, unknown>,
): Promise<void> {
	const token =
		typeof options['bot_token'] === 'string' ? options['bot_token'] : '';
	if (!token) {
		sendError('telegram channel: bot_token missing in sidecar config', true);
		process.exit(1);
	}
	const defaultChat = options['default_chat_id'];
	if (typeof defaultChat === 'string' || typeof defaultChat === 'number') {
		state.defaultChatId = defaultChat;
	} else {
		sendError(
			'telegram channel: default_chat_id missing or invalid in sidecar config',
			true,
		);
		process.exit(1);
	}

	state.bot = new TelegramBot({token}, log);
	send({event: 'ready', params: {name: NAME, version: VERSION}});

	for await (const update of state.bot.poll()) {
		const message = update.message;
		if (!message) continue;
		await handleIncomingMessage(state, message);
	}
}

async function handleIncomingMessage(
	state: RuntimeState,
	message: TelegramMessage,
): Promise<void> {
	const senderId = message.from?.id;
	if (senderId === undefined) return;
	if (!state.allowedUserIds.has(String(senderId))) {
		log('debug', `dropping message from non-allowlisted sender: ${senderId}`);
		return;
	}
	const text = message.text?.trim() ?? '';
	if (text.length === 0) return;

	const verdict = parseVerdict(text);
	if (verdict) {
		send({
			event: 'permission.verdict',
			params: {
				channel_request_id: verdict.channelRequestId,
				behavior: verdict.behavior,
			},
		});
		return;
	}

	const answerId = parseQuestionAnswerId(text);
	if (answerId) {
		const keys = state.pendingQuestionKeys.get(answerId);
		if (keys) {
			const answer = parseQuestionAnswer(text, keys);
			if (answer) {
				send({
					event: 'question.answer',
					params: {
						channel_request_id: answer.channelRequestId,
						answers: answer.answers,
					},
				});
				return;
			}
		}
	}

	if (state.pendingQuestionKeys.size === 1) {
		const [[pendingQuestionId, keys]] = state.pendingQuestionKeys;
		const answer = buildPlainTextQuestionAnswer(pendingQuestionId, text, keys);
		if (answer) {
			send({
				event: 'question.answer',
				params: {
					channel_request_id: answer.channelRequestId,
					answers: answer.answers,
				},
			});
			return;
		}
	}

	send({
		event: 'chat.message',
		params: {
			content: text,
			meta: {
				sender_id: String(senderId),
				chat_id: String(message.chat.id),
			},
		},
	});
}

async function handleMethod(
	state: RuntimeState,
	message: ChannelMethodMessage,
): Promise<void> {
	switch (message.method) {
		case 'init': {
			state.allowedUserIds = new Set(
				message.params.allowed_user_ids.map(id => String(id)),
			);
			void startBot(state, message.params.options);
			return;
		}
		case 'permission.request': {
			if (!state.bot || state.defaultChatId === null) return;
			const id = message.params.channel_request_id;
			const text = buildPromptText(
				message.params.tool_name,
				message.params.description,
				message.params.input_preview,
				id,
			);
			state.inFlightSends.add(id);
			const result = await state.bot.sendMessage(state.defaultChatId, text);
			state.inFlightSends.delete(id);
			if (!result) {
				// Send failed; drop any cancel that came in during the send —
				// there's no message to edit.
				state.cancelDuringSend.delete(id);
				return;
			}
			state.pendingMessages.set(id, {
				chatId: result.chat.id,
				messageId: result.message_id,
			});
			const queuedCancel = state.cancelDuringSend.get(id);
			if (queuedCancel !== undefined) {
				state.cancelDuringSend.delete(id);
				await state.bot.editMessageText(
					result.chat.id,
					result.message_id,
					buildCancelText(queuedCancel),
				);
				state.pendingMessages.delete(id);
			}
			return;
		}
		case 'permission.cancel': {
			if (!state.bot) return;
			const id = message.params.channel_request_id;
			const ref = state.pendingMessages.get(id);
			if (ref) {
				await state.bot.editMessageText(
					ref.chatId,
					ref.messageId,
					buildCancelText(message.params.reason),
				);
				state.pendingMessages.delete(id);
				return;
			}
			if (state.inFlightSends.has(id)) {
				// Cancel arrived before sendMessage resolved; remember the
				// reason and apply it once the message exists.
				state.cancelDuringSend.set(id, message.params.reason);
			}
			return;
		}
		case 'question.request': {
			if (!state.bot || state.defaultChatId === null) return;
			const id = message.params.channel_request_id;
			state.pendingQuestionKeys.set(
				id,
				message.params.questions.map(q => q.key),
			);
			const text = buildQuestionText(
				message.params.title,
				message.params.questions,
				id,
			);
			state.inFlightSends.add(id);
			const result = await state.bot.sendMessage(state.defaultChatId, text);
			state.inFlightSends.delete(id);
			if (!result) {
				state.cancelDuringSend.delete(id);
				state.pendingQuestionKeys.delete(id);
				return;
			}
			state.pendingMessages.set(id, {
				chatId: result.chat.id,
				messageId: result.message_id,
			});
			const queuedCancel = state.cancelDuringSend.get(id);
			if (queuedCancel !== undefined) {
				state.cancelDuringSend.delete(id);
				await state.bot.editMessageText(
					result.chat.id,
					result.message_id,
					buildCancelText(queuedCancel),
				);
				state.pendingMessages.delete(id);
				state.pendingQuestionKeys.delete(id);
			}
			return;
		}
		case 'question.cancel': {
			if (!state.bot) return;
			const id = message.params.channel_request_id;
			state.pendingQuestionKeys.delete(id);
			const ref = state.pendingMessages.get(id);
			if (ref) {
				await state.bot.editMessageText(
					ref.chatId,
					ref.messageId,
					buildCancelText(message.params.reason),
				);
				state.pendingMessages.delete(id);
				return;
			}
			if (state.inFlightSends.has(id)) {
				state.cancelDuringSend.set(id, message.params.reason);
			}
			return;
		}
		case 'notification': {
			if (!state.bot || state.defaultChatId === null) return;
			await state.bot.sendMessage(state.defaultChatId, message.params.content);
			return;
		}
		case 'shutdown': {
			state.bot?.stop();
			process.exit(0);
		}
	}
}

function main(): void {
	const state: RuntimeState = {
		bot: null,
		allowedUserIds: new Set(),
		defaultChatId: null,
		pendingMessages: new Map(),
		pendingQuestionKeys: new Map(),
		inFlightSends: new Set(),
		cancelDuringSend: new Map(),
	};

	const reader = new LineReader();
	process.stdin.setEncoding('utf-8');
	process.stdin.on('data', chunk => {
		for (const line of reader.push(chunk)) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				sendError(`invalid JSON line: ${line.slice(0, 100)}`);
				continue;
			}
			const result = parseMethodMessage(parsed);
			if (!result.ok) {
				sendError(`invalid method message: ${result.reason}`);
				continue;
			}
			void handleMethod(state, result.value).catch(err => {
				sendError(
					`method handler failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		}
	});

	process.stdin.on('end', () => {
		state.bot?.stop();
		process.exit(0);
	});

	process.on('SIGTERM', () => {
		state.bot?.stop();
		process.exit(0);
	});
}

main();
