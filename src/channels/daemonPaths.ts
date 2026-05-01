import os from 'node:os';
import path from 'node:path';

function safeChannelName(name: string): string {
	const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_');
	if (cleaned.length === 0 || /^\.+$/.test(cleaned)) {
		throw new Error(`invalid channel name: ${JSON.stringify(name)}`);
	}
	return cleaned;
}

export function channelDaemonRunDir(homeDir = os.homedir()): string {
	return path.join(homeDir, '.athena', 'run');
}

export function channelDaemonSocketPath(
	channelName: string,
	homeDir = os.homedir(),
): string {
	return path.join(
		channelDaemonRunDir(homeDir),
		`channel-${safeChannelName(channelName)}.sock`,
	);
}

export function channelDaemonAuthPath(
	channelName: string,
	homeDir = os.homedir(),
): string {
	return path.join(
		channelDaemonRunDir(homeDir),
		`channel-${safeChannelName(channelName)}.token`,
	);
}
