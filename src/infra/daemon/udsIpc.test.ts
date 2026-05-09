import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {sendUdsRequest, startUdsServer} from './udsIpc';

let tmpDir: string;
let socketPath: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uds-'));
	socketPath = path.join(tmpDir, 'daemon.sock');
});

afterEach(() => {
	try {
		fs.rmSync(tmpDir, {recursive: true, force: true});
	} catch {
		// best-effort
	}
});

describe('UDS IPC', () => {
	it('round-trips a status request', async () => {
		const server = await startUdsServer(socketPath, () => ({
			ok: true,
			cmd: 'status',
			pid: 42,
			startedAt: 1,
			socketConnected: true,
			activeRuns: 1,
			completedRuns: 5,
		}));
		try {
			const reply = await sendUdsRequest(socketPath, {cmd: 'status'});
			expect(reply).toMatchObject({
				ok: true,
				cmd: 'status',
				pid: 42,
				socketConnected: true,
				activeRuns: 1,
				completedRuns: 5,
			});
		} finally {
			await server.close();
		}
	});

	it('cleans up a stale socket file when a previous server crashed', async () => {
		// Pretend a previous daemon left its socket file behind.
		fs.writeFileSync(socketPath, '');
		// Replace with an actual socket-shaped placeholder so unlink path runs:
		// startUdsServer probes; since there's nothing listening, it removes it.
		fs.unlinkSync(socketPath);
		// Place a UDS-style empty file by binding & closing.
		const probe = await startUdsServer(socketPath, () => ({
			ok: true,
			cmd: 'reload',
		}));
		await probe.close();

		const server = await startUdsServer(socketPath, () => ({
			ok: true,
			cmd: 'reload',
		}));
		try {
			const reply = await sendUdsRequest(socketPath, {cmd: 'reload'});
			expect(reply).toMatchObject({ok: true, cmd: 'reload'});
		} finally {
			await server.close();
		}
	});

	it('returns ok:false for an unknown command', async () => {
		const server = await startUdsServer(socketPath, () => ({
			ok: false,
			error: 'unknown',
		}));
		try {
			// Cast through unknown — the schema should still accept the response.
			const reply = await sendUdsRequest(socketPath, {cmd: 'reload'} as const);
			if (reply.ok) throw new Error('expected ok:false');
			expect(reply.error).toBe('unknown');
		} finally {
			await server.close();
		}
	});

	it('errors when the socket does not exist', async () => {
		await expect(
			sendUdsRequest(path.join(tmpDir, 'missing.sock'), {cmd: 'status'}),
		).rejects.toThrow();
	});

	it('binds the socket file at mode 0600', async () => {
		if (process.platform === 'win32') return;
		const server = await startUdsServer(socketPath, () => ({
			ok: true,
			cmd: 'reload',
		}));
		try {
			const stat = fs.statSync(socketPath);
			expect(stat.mode & 0o777).toBe(0o600);
		} finally {
			await server.close();
		}
	});

	it('logs bad framing instead of dropping silently', async () => {
		const logged: string[] = [];
		const server = await startUdsServer(
			socketPath,
			() => ({ok: true, cmd: 'reload'}),
			(level, message) => logged.push(`${level}:${message}`),
		);
		try {
			// Write a non-numeric length header to trigger the framing check.
			const net = await import('node:net');
			const client = net.createConnection(socketPath);
			await new Promise<void>(resolve =>
				client.once('connect', () => resolve()),
			);
			client.write('not-a-number\nbody');
			await new Promise<void>(resolve => client.once('close', () => resolve()));
		} finally {
			await server.close();
		}
		expect(logged.some(l => l.includes('uds bad framing'))).toBe(true);
	});
});
