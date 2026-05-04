import {describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	dashboardClientConfigPath,
	normalizeDashboardUrl,
	readDashboardClientConfig,
	removeDashboardClientConfig,
	writeDashboardClientConfig,
} from './dashboardClient';

describe('dashboard client config', () => {
	it('normalizes dashboard origins without preserving paths', () => {
		expect(normalizeDashboardUrl('https://example.com/app/instances')).toBe(
			'https://example.com',
		);
		expect(normalizeDashboardUrl('http://localhost:5173/')).toBe(
			'http://localhost:5173',
		);
	});

	it('rejects non-http dashboard urls', () => {
		expect(() => normalizeDashboardUrl('ws://localhost:5173')).toThrow(
			/http:\/\/ or https:\/\//,
		);
	});

	it('rejects malformed dashboard urls', () => {
		expect(() => normalizeDashboardUrl('not a url')).toThrow(/valid URL/);
	});

	it('returns null when dashboard.json is missing', () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-dash-'));
		expect(readDashboardClientConfig({HOME: home})).toBeNull();
	});

	it('round-trips config under ~/.config/athena/dashboard.json with 0600', () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-dash-'));
		const env = {HOME: home};
		const config = {
			dashboardUrl: 'http://localhost:5173',
			instanceId: 'inst_1',
			refreshToken: 'refresh_1',
			fingerprint: 'fp_1',
			pairedAt: 123,
		};

		writeDashboardClientConfig(config, env);

		expect(readDashboardClientConfig(env)).toEqual(config);
		expect(dashboardClientConfigPath(env)).toBe(
			path.join(home, '.config', 'athena', 'dashboard.json'),
		);
		if (process.platform !== 'win32') {
			const mode = fs.statSync(dashboardClientConfigPath(env)).mode & 0o777;
			expect(mode).toBe(0o600);
		}
	});

	it('persists optional lastRefreshAt', () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-dash-'));
		const env = {HOME: home};
		writeDashboardClientConfig(
			{
				dashboardUrl: 'https://example.com',
				instanceId: 'inst_2',
				refreshToken: 'refresh_2',
				fingerprint: 'fp_2',
				pairedAt: 1,
				lastRefreshAt: 2,
			},
			env,
		);
		expect(readDashboardClientConfig(env)?.lastRefreshAt).toBe(2);
	});

	it('rejects invalid stored config', () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-dash-'));
		const configPath = dashboardClientConfigPath({HOME: home});
		fs.mkdirSync(path.dirname(configPath), {recursive: true});
		fs.writeFileSync(configPath, JSON.stringify({dashboardUrl: 'x'}));

		expect(() => readDashboardClientConfig({HOME: home})).toThrow(
			/dashboard client config/,
		);
	});

	it('removes config and is idempotent', () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-dash-'));
		const env = {HOME: home};
		writeDashboardClientConfig(
			{
				dashboardUrl: 'https://example.com',
				instanceId: 'inst_3',
				refreshToken: 'refresh_3',
				fingerprint: 'fp_3',
				pairedAt: 0,
			},
			env,
		);
		removeDashboardClientConfig(env);
		removeDashboardClientConfig(env);
		expect(readDashboardClientConfig(env)).toBeNull();
	});
});
