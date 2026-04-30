/**
 * Minimal Telegram Bot API client for the Athena channel.
 *
 * Long-polls `getUpdates` to receive messages and exposes `sendMessage`
 * + `editMessageText` for outgoing prompts. Only the surface needed by
 * the channel is implemented; no third-party Telegram SDK.
 */

export type TelegramUser = {
	id: number;
	is_bot?: boolean;
	first_name?: string;
	last_name?: string;
	username?: string;
};

export type TelegramChat = {
	id: number;
	type: 'private' | 'group' | 'supergroup' | 'channel';
};

export type TelegramMessage = {
	message_id: number;
	from?: TelegramUser;
	chat: TelegramChat;
	date: number;
	text?: string;
};

export type TelegramUpdate = {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
};

export type SendMessageResult = {
	message_id: number;
	chat: {id: number};
};

export type BotOptions = {
	token: string;
	apiBase?: string;
	pollTimeoutSec?: number;
};

export type BotLogger = (
	level: 'debug' | 'info' | 'warn' | 'error',
	message: string,
) => void;

export class TelegramBot {
	private readonly token: string;
	private readonly apiBase: string;
	private readonly pollTimeoutSec: number;
	private offset = 0;
	private stopped = false;
	private readonly log: BotLogger;
	private consecutiveAuthFailures = 0;

	constructor(opts: BotOptions, log: BotLogger) {
		this.token = opts.token;
		this.apiBase = opts.apiBase ?? 'https://api.telegram.org';
		this.pollTimeoutSec = opts.pollTimeoutSec ?? 25;
		this.log = log;
	}

	/** Strip the bot token from any string before logging or surfacing. */
	private redact(text: string): string {
		if (!this.token) return text;
		return text.split(this.token).join('<redacted>');
	}

	stop(): void {
		this.stopped = true;
	}

	async *poll(): AsyncIterable<TelegramUpdate> {
		while (!this.stopped) {
			try {
				const updates = await this.getUpdates();
				this.consecutiveAuthFailures = 0;
				for (const update of updates) {
					// `stopped` may have flipped during the await above (consumer
					// called `stop()`), so re-check explicitly. Cast through
					// `unknown` to keep TS from narrowing the field after the
					// loop guard.
					if ((this as unknown as {stopped: boolean}).stopped) return;
					if (update.update_id >= this.offset) {
						this.offset = update.update_id + 1;
					}
					yield update;
				}
			} catch (err) {
				const raw = err instanceof Error ? err.message : String(err);
				const message = this.redact(raw);
				const status = (err as {status?: number} | undefined)?.status;
				if (status === 401 || status === 409) {
					this.consecutiveAuthFailures++;
					this.log(
						'error',
						`getUpdates failed (HTTP ${status}, attempt ${this.consecutiveAuthFailures}): ${message}`,
					);
					if (this.consecutiveAuthFailures >= 3) {
						// Hot-spinning on a bad token / dual consumer is worse
						// than failing fast; signal the host and stop.
						this.stopped = true;
						throw new Error(
							`telegram channel: persistent HTTP ${status} from getUpdates after 3 attempts`,
						);
					}
				} else {
					this.log('warn', `getUpdates failed: ${message}`);
				}
				await sleep(1500);
			}
		}
	}

	async sendMessage(
		chatId: number | string,
		text: string,
	): Promise<SendMessageResult | null> {
		try {
			const result = await this.call<SendMessageResult>('sendMessage', {
				chat_id: chatId,
				text,
			});
			return result;
		} catch (err) {
			this.log(
				'warn',
				`sendMessage failed: ${this.redact(
					err instanceof Error ? err.message : String(err),
				)}`,
			);
			return null;
		}
	}

	async editMessageText(
		chatId: number | string,
		messageId: number,
		text: string,
	): Promise<void> {
		try {
			await this.call('editMessageText', {
				chat_id: chatId,
				message_id: messageId,
				text,
			});
		} catch (err) {
			this.log(
				'debug',
				`editMessageText failed: ${this.redact(
					err instanceof Error ? err.message : String(err),
				)}`,
			);
		}
	}

	private async getUpdates(): Promise<TelegramUpdate[]> {
		const result = await this.call<TelegramUpdate[]>('getUpdates', {
			offset: this.offset,
			timeout: this.pollTimeoutSec,
			allowed_updates: ['message'],
		});
		return result;
	}

	private async call<T>(method: string, params: unknown): Promise<T> {
		const url = `${this.apiBase}/bot${this.token}/${method}`;
		const res = await fetch(url, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify(params),
		});
		if (!res.ok) {
			const err = new Error(`HTTP ${res.status}`) as Error & {status?: number};
			err.status = res.status;
			throw err;
		}
		const json = (await res.json()) as {
			ok: boolean;
			result?: T;
			description?: string;
		};
		if (!json.ok) {
			throw new Error(json.description ?? 'telegram api returned ok=false');
		}
		return json.result as T;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
