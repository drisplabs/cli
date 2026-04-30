import {describe, expect, it, vi} from 'vitest';
import {runChannelCommand} from './channelCommand';

describe('runChannelCommand', () => {
	it('configures telegram sidecar and enables the global channel', () => {
		const writeTelegramConfig = vi.fn();
		const readGlobalConfig = vi.fn().mockReturnValue({
			plugins: [],
			additionalDirectories: [],
			channels: ['slack'],
		});
		const writeGlobalConfig = vi.fn();
		const logOut = vi.fn();

		const code = runChannelCommand(
			{
				subcommandArgs: ['telegram', 'configure'],
				flags: {
					botToken: '123:secret',
					userId: '1264603016',
					chatId: '1264603016',
				},
			},
			{writeTelegramConfig, readGlobalConfig, writeGlobalConfig, logOut},
		);

		expect(code).toBe(0);
		expect(writeTelegramConfig).toHaveBeenCalledWith({
			bot_token: '123:secret',
			allowed_user_ids: [1264603016],
			default_chat_id: 1264603016,
		});
		expect(writeGlobalConfig).toHaveBeenCalledWith({
			channels: ['slack', 'telegram'],
		});
		expect(logOut).toHaveBeenCalledWith('Configured Telegram channel.');
	});

	it('uses user id as chat id when chat id is omitted', () => {
		const writeTelegramConfig = vi.fn();
		const readGlobalConfig = vi.fn().mockReturnValue({
			plugins: [],
			additionalDirectories: [],
		});
		const writeGlobalConfig = vi.fn();

		const code = runChannelCommand(
			{
				subcommandArgs: ['telegram', 'configure'],
				flags: {
					botToken: '123:secret',
					userId: '1264603016',
				},
			},
			{writeTelegramConfig, readGlobalConfig, writeGlobalConfig},
		);

		expect(code).toBe(0);
		expect(writeTelegramConfig).toHaveBeenCalledWith(
			expect.objectContaining({
				default_chat_id: 1264603016,
			}),
		);
	});

	it('prints usage when required flags are missing', () => {
		const logError = vi.fn();

		const code = runChannelCommand(
			{
				subcommandArgs: ['telegram', 'configure'],
				flags: {userId: '1264603016'},
			},
			{logError},
		);

		expect(code).toBe(1);
		expect(logError).toHaveBeenCalledWith(
			expect.stringContaining('Usage: athena-flow channel telegram configure'),
		);
	});

	it('rejects non-numeric telegram ids', () => {
		const logError = vi.fn();

		const code = runChannelCommand(
			{
				subcommandArgs: ['telegram', 'configure'],
				flags: {
					botToken: '123:secret',
					userId: 'not-a-number',
				},
			},
			{logError},
		);

		expect(code).toBe(1);
		expect(logError).toHaveBeenCalledWith(
			'Error: --user-id must be a Telegram numeric id.',
		);
	});
});
