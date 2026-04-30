import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readGlobalConfig, writeGlobalConfig} from '../../infra/plugins/config';

const USAGE = `Usage: athena-flow channel telegram configure --bot-token <token> --user-id <id> [--chat-id <id>]

Configures ~/.config/athena/channels/telegram.json and enables telegram in the global channels list.`;

export type TelegramChannelConfig = {
	bot_token: string;
	allowed_user_ids: number[];
	default_chat_id: number;
};

export type ChannelCommandInput = {
	subcommandArgs: string[];
	flags: {
		botToken?: string;
		userId?: string;
		chatId?: string;
	};
};

export type ChannelCommandDeps = {
	readGlobalConfig?: typeof readGlobalConfig;
	writeGlobalConfig?: typeof writeGlobalConfig;
	writeTelegramConfig?: (config: TelegramChannelConfig) => void;
	logError?: (message: string) => void;
	logOut?: (message: string) => void;
};

function parseTelegramId(flagName: string, value: string): number | string {
	if (!/^\d+$/.test(value)) {
		return `Error: --${flagName} must be a Telegram numeric id.`;
	}
	return Number(value);
}

export function writeTelegramChannelConfig(
	config: TelegramChannelConfig,
): void {
	const dir = path.join(os.homedir(), '.config', 'athena', 'channels');
	const configPath = path.join(dir, 'telegram.json');
	fs.mkdirSync(dir, {recursive: true, mode: 0o700});
	fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', {
		encoding: 'utf-8',
		mode: 0o600,
	});
	if (process.platform !== 'win32') {
		fs.chmodSync(dir, 0o700);
		fs.chmodSync(configPath, 0o600);
	}
}

export function runChannelCommand(
	input: ChannelCommandInput,
	deps: ChannelCommandDeps = {},
): number {
	const [channelName, action] = input.subcommandArgs;
	const logError = deps.logError ?? console.error;
	const logOut = deps.logOut ?? console.log;
	const readConfig = deps.readGlobalConfig ?? readGlobalConfig;
	const writeConfig = deps.writeGlobalConfig ?? writeGlobalConfig;
	const writeTelegramConfig =
		deps.writeTelegramConfig ?? writeTelegramChannelConfig;

	if (channelName !== 'telegram' || action !== 'configure') {
		logError(USAGE);
		return 1;
	}

	const botToken = input.flags.botToken;
	const userIdRaw = input.flags.userId;
	if (!botToken || !userIdRaw) {
		logError(USAGE);
		return 1;
	}

	const userId = parseTelegramId('user-id', userIdRaw);
	if (typeof userId === 'string') {
		logError(userId);
		return 1;
	}

	const chatIdRaw = input.flags.chatId ?? userIdRaw;
	const chatId = parseTelegramId('chat-id', chatIdRaw);
	if (typeof chatId === 'string') {
		logError(chatId);
		return 1;
	}

	writeTelegramConfig({
		bot_token: botToken,
		allowed_user_ids: [userId],
		default_chat_id: chatId,
	});

	const existingChannels = readConfig().channels ?? [];
	if (!existingChannels.includes('telegram')) {
		writeConfig({channels: [...existingChannels, 'telegram']});
	}

	logOut('Configured Telegram channel.');
	return 0;
}
