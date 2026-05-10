/**
 * Reconciles per-runner console sidecars under `~/.config/athena/channels/`
 * to match the desired set of attached runners.
 *
 * Writes a `console-<runnerId>.json` sidecar for every desired runner that
 * doesn't already match. Removes dashboard-managed sidecars (those carrying
 * `dashboard_config: true`) for runners no longer in the desired set.
 * Leaves user-managed sidecars (no `dashboard_config` flag) and non-console
 * sidecars untouched.
 */

import fs from 'node:fs';
import path from 'node:path';

export type ReconcileInput = {
	channelDir: string;
	dashboardUrl: string;
	desired: Array<{runnerId: string}>;
};

export type ReconcileResult = {
	written: string[];
	removed: string[];
};

export function reconcileConsoleSidecars(
	input: ReconcileInput,
): ReconcileResult {
	const result: ReconcileResult = {written: [], removed: []};
	fs.mkdirSync(input.channelDir, {recursive: true, mode: 0o700});

	const desiredIds = new Set(input.desired.map(d => d.runnerId));

	for (const {runnerId} of input.desired) {
		const target = path.join(input.channelDir, `console-${runnerId}.json`);
		const payload = buildPayload(input.dashboardUrl, runnerId);
		const serialized = JSON.stringify(payload, null, 2) + '\n';
		if (matchesExisting(target, serialized)) continue;
		writeAtomic(target, serialized);
		result.written.push(runnerId);
	}

	let entries: string[];
	try {
		entries = fs.readdirSync(input.channelDir);
	} catch {
		return result;
	}
	for (const entry of entries) {
		if (!entry.startsWith('console-') || !entry.endsWith('.json')) continue;
		const runnerId = entry.slice('console-'.length, -'.json'.length);
		if (desiredIds.has(runnerId)) continue;
		const full = path.join(input.channelDir, entry);
		if (!isDashboardManaged(full)) continue;
		try {
			fs.unlinkSync(full);
			result.removed.push(runnerId);
		} catch {
			// best-effort
		}
	}

	return result;
}

function buildPayload(
	dashboardUrl: string,
	runnerId: string,
): Record<string, unknown> {
	return {
		kind: 'console',
		instance_id: `console:${runnerId}`,
		broker_url: consoleBrokerUrl(dashboardUrl, runnerId),
		runner_id: runnerId,
		dashboard_config: true,
	};
}

function consoleBrokerUrl(dashboardUrl: string, runnerId: string): string {
	const url = new URL(dashboardUrl);
	if (url.protocol === 'https:') url.protocol = 'wss:';
	else if (url.protocol === 'http:') url.protocol = 'ws:';
	else throw new Error(`unsupported dashboard protocol: ${url.protocol}`);
	url.pathname = `/api/runners/${encodeURIComponent(runnerId)}/console/adapter`;
	url.search = '';
	url.hash = '';
	return url.toString();
}

function matchesExisting(target: string, serialized: string): boolean {
	try {
		return fs.readFileSync(target, 'utf-8') === serialized;
	} catch {
		return false;
	}
}

function isDashboardManaged(filePath: string): boolean {
	try {
		const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
			dashboard_config?: unknown;
		};
		return raw.dashboard_config === true;
	} catch {
		return false;
	}
}

function writeAtomic(target: string, contents: string): void {
	const tmp = `${target}.tmp`;
	try {
		fs.writeFileSync(tmp, contents, {mode: 0o600});
		fs.renameSync(tmp, target);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// best-effort
		}
		throw err;
	}
}
