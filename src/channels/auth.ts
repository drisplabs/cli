/**
 * Shared-secret authentication for the channel daemon UDS.
 *
 * The token is generated once per channel and persisted to a 0600 file under
 * `~/.athena/run/`. Both the daemon and any host that wants to attach load it
 * from disk; clients send the token as the first frame on the socket and the
 * daemon refuses any other traffic until that handshake succeeds.
 *
 * This is defence-in-depth on top of the 0600 socket: same-UID procs that can
 * already read the file gain nothing from the token, but it stops casual
 * cross-UID or sandboxed access if socket perms ever regress.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {channelDaemonAuthPath, channelDaemonRunDir} from './daemonPaths';

/**
 * Option keys that must never traverse the UDS in clear text. They are
 * stripped from `init.params.options` on the host side and re-injected by the
 * daemon (from its own env) before forwarding init to the channel subprocess.
 */
export const SECRET_OPTION_KEYS = new Set(['bot_token']);

export const CHANNEL_SECRETS_ENV = 'ATHENA_CHANNEL_SECRETS';

export type AuthFrame = {type: 'auth'; token: string};

export function isAuthFrame(value: unknown): value is AuthFrame {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return v['type'] === 'auth' && typeof v['token'] === 'string';
}

export function encodeAuthFrame(token: string): string {
	return JSON.stringify({type: 'auth', token}) + '\n';
}

/**
 * Constant-time string compare. Avoids timing oracles on the token.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return crypto.timingSafeEqual(ab, bb);
}

/**
 * Atomically obtain the per-channel auth token. The first caller creates it
 * (O_CREAT|O_EXCL) with mode 0600; concurrent callers fall through to read the
 * existing file. Returns the hex-encoded token.
 */
export function loadOrCreateChannelAuthToken(
	channelName: string,
	homeDir?: string,
): string {
	const file = channelDaemonAuthPath(channelName, homeDir);
	fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
	try {
		const fd = fs.openSync(
			file,
			fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
			0o600,
		);
		try {
			const token = crypto.randomBytes(32).toString('hex');
			fs.writeSync(fd, token);
			return token;
		} finally {
			fs.closeSync(fd);
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
	}
	return fs.readFileSync(file, 'utf8').trim();
}

export function readChannelAuthToken(
	channelName: string,
	homeDir?: string,
): string {
	const file = channelDaemonAuthPath(channelName, homeDir);
	return fs.readFileSync(file, 'utf8').trim();
}

/**
 * Split an options bag into (public options sent over UDS, secret options to
 * be passed to the daemon out-of-band via env).
 */
export function partitionSecretOptions(
	options: Record<string, unknown> | undefined,
): {
	publicOptions: Record<string, unknown>;
	secretOptions: Record<string, unknown>;
} {
	const publicOptions: Record<string, unknown> = {};
	const secretOptions: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(options ?? {})) {
		if (SECRET_OPTION_KEYS.has(key)) secretOptions[key] = value;
		else publicOptions[key] = value;
	}
	return {publicOptions, secretOptions};
}

export function ensureChannelRunDir(homeDir?: string): string {
	const dir = channelDaemonRunDir(homeDir);
	fs.mkdirSync(dir, {recursive: true, mode: 0o700});
	return dir;
}
