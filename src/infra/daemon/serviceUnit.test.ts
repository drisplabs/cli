import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
	installServiceUnit,
	renderLaunchdPlist,
	renderSystemdUnit,
} from './serviceUnit';

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-unit-'));
});

afterEach(() => {
	try {
		fs.rmSync(tmpDir, {recursive: true, force: true});
	} catch {
		// best-effort
	}
});

describe('renderLaunchdPlist', () => {
	it('emits a well-formed plist with KeepAlive and RunAtLoad', () => {
		const xml = renderLaunchdPlist({
			label: 'ai.drisp.daemon',
			nodeBinary: '/usr/local/bin/node',
			daemonEntry: '/opt/drisp/dist/dashboard-daemon.js',
			workingDirectory: '/Users/test',
			stdoutPath: '/Users/test/.local/state/drisp/dashboard-daemon.log',
			stderrPath: '/Users/test/.local/state/drisp/dashboard-daemon.log',
		});
		expect(xml).toContain('<key>Label</key>');
		expect(xml).toContain('<string>ai.drisp.daemon</string>');
		expect(xml).toContain('<key>RunAtLoad</key>');
		expect(xml).toContain('<key>KeepAlive</key>');
		expect(xml).toContain('<string>/usr/local/bin/node</string>');
		expect(xml).toContain(
			'<string>/opt/drisp/dist/dashboard-daemon.js</string>',
		);
	});

	it('xml-escapes special characters in paths', () => {
		const xml = renderLaunchdPlist({
			label: 'ai.drisp.daemon',
			nodeBinary: '/usr/bin/node',
			daemonEntry: '/path/with <weird> chars/dashboard-daemon.js',
			workingDirectory: '/home',
			stdoutPath: '/log',
			stderrPath: '/log',
		});
		expect(xml).toContain('&lt;weird&gt;');
		expect(xml).not.toContain('<weird>');
	});
});

describe('renderSystemdUnit', () => {
	it('emits a unit with Restart=always and WantedBy=default.target', () => {
		const unit = renderSystemdUnit({
			description: 'Drisp daemon',
			nodeBinary: '/usr/bin/node',
			daemonEntry: '/opt/drisp/dist/dashboard-daemon.js',
		});
		expect(unit).toContain('Description=Drisp daemon');
		expect(unit).toContain(
			'ExecStart=/usr/bin/node /opt/drisp/dist/dashboard-daemon.js',
		);
		expect(unit).toContain('Restart=always');
		expect(unit).toContain('WantedBy=default.target');
	});
});

describe('installServiceUnit', () => {
	it('writes a launchd plist on darwin and reports the load command', () => {
		const target = path.join(tmpDir, 'ai.drisp.daemon.plist');
		const result = installServiceUnit({
			platform: 'darwin',
			daemonEntry: '/opt/drisp/dist/dashboard-daemon.js',
			nodeBinary: '/usr/bin/node',
			targetPath: target,
			env: {HOME: tmpDir},
		});
		expect(result).toMatchObject({
			ok: true,
			platform: 'darwin',
			path: target,
		});
		expect(result.loadCommand).toContain('launchctl load');
		expect(fs.existsSync(target)).toBe(true);
		expect(fs.readFileSync(target, 'utf-8')).toContain('<key>Label</key>');
	});

	it('writes a systemd unit on linux', () => {
		const target = path.join(tmpDir, 'drisp-daemon.service');
		const result = installServiceUnit({
			platform: 'linux',
			daemonEntry: '/opt/drisp/dist/dashboard-daemon.js',
			nodeBinary: '/usr/bin/node',
			targetPath: target,
			env: {HOME: tmpDir},
		});
		expect(result).toMatchObject({
			ok: true,
			platform: 'linux',
			path: target,
		});
		expect(result.loadCommand).toContain('systemctl --user daemon-reload');
		expect(fs.readFileSync(target, 'utf-8')).toContain('Restart=always');
	});

	it('reports unsupported on win32', () => {
		const result = installServiceUnit({
			platform: 'win32',
			daemonEntry: '/opt/dashboard-daemon.js',
			nodeBinary: 'node.exe',
			env: {HOME: tmpDir},
		});
		expect(result).toMatchObject({
			ok: false,
			platform: 'unsupported',
		});
	});

	it('is idempotent — does not rewrite a matching file', () => {
		const target = path.join(tmpDir, 'unit.plist');
		installServiceUnit({
			platform: 'darwin',
			daemonEntry: '/x.js',
			nodeBinary: '/node',
			targetPath: target,
			env: {HOME: tmpDir},
		});
		const mtimeBefore = fs.statSync(target).mtimeMs;
		installServiceUnit({
			platform: 'darwin',
			daemonEntry: '/x.js',
			nodeBinary: '/node',
			targetPath: target,
			env: {HOME: tmpDir},
		});
		const mtimeAfter = fs.statSync(target).mtimeMs;
		expect(mtimeAfter).toBe(mtimeBefore);
	});
});
