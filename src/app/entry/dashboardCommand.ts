import crypto from 'node:crypto';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
	createInstanceSocketClient,
	type InstanceSocketClient,
	type InstanceSocketLogger,
} from '../dashboard/instanceSocketClient';
import {runGatewayCommand} from './gatewayCommand';
import {
	executeRemoteAssignment,
	type ExecuteRemoteAssignmentInput,
} from '../dashboard/remoteRunExecutor';
import type {StatusResponsePayload} from '../../shared/gateway-protocol';
import {
	refreshDashboardAccessToken,
	type DashboardAccessToken,
} from '../../infra/config/dashboardAuth';
import {
	type DashboardClientConfig,
	dashboardClientConfigPath,
	normalizeDashboardUrl,
	readDashboardClientConfig,
	removeDashboardClientConfig,
	writeDashboardClientConfig,
} from '../../infra/config/dashboardClient';

const USAGE = `Usage: athena dashboard <subcommand> [options]

Subcommands:
  pair <token> --url <dashboard-origin> [--name <machine-name>]
            Pair this machine with the dashboard. The pairing token is
            single-use and short-lived. Stores the long-lived refresh
            token in ~/.config/athena/dashboard.json (mode 0600).
  status    Show paired instance id and dashboard origin.
  doctor [--runner <runner-id>]
            Diagnose pairing, gateway, console sidecar, adapter, and runtime
            health without printing secrets.
  refresh   Mint a short-lived access token. Rotates the stored
            refresh token. Use --json to capture the access token.
  connect   Open the dashboard instance socket and run until interrupted.
            Refreshes an access token before connecting.
  console link <runner-id>
            Configure the local gateway console adapter for a dashboard
            runner and reload gateway channels when the gateway is reachable.
  unpair    Forget the local refresh token and instance id.

Options:
  --url <origin>      Dashboard origin (required for pair)
  --name <name>       Friendly machine name (optional, defaults to hostname)
  --json              Emit machine-readable JSON output
`;

declare const __ATHENA_VERSION__: string;
const require_ = createRequire(import.meta.url);

let cachedVersion: string | null = null;
function readPackageVersion(): string {
	if (cachedVersion !== null) return cachedVersion;
	try {
		const injected: unknown = __ATHENA_VERSION__;
		if (typeof injected === 'string' && injected.length > 0) {
			cachedVersion = injected;
			return cachedVersion;
		}
	} catch {
		// fall through to require-based read
	}
	try {
		const pkg = require_('../../../package.json') as {version?: string};
		cachedVersion = pkg.version ?? '0.0.0';
	} catch {
		cachedVersion = '0.0.0';
	}
	return cachedVersion;
}

export type DashboardCommandFlags = {
	url?: string;
	name?: string;
	json?: boolean;
};

export type DashboardCommandInput = {
	subcommand: string;
	subcommandArgs: string[];
	flags: DashboardCommandFlags;
};

export type DashboardCommandDeps = {
	fetch?: typeof fetch;
	now?: () => number;
	fingerprint?: () => string;
	hostInfo?: () => Record<string, unknown>;
	packageVersion?: string;
	readConfig?: () => DashboardClientConfig | null;
	writeConfig?: (config: DashboardClientConfig) => void;
	removeConfig?: () => void;
	writeConsoleChannelConfig?: (config: ConsoleChannelConfig) => void;
	readConsoleChannelConfig?: () => ConsoleChannelConfig | null;
	reloadGatewayChannels?: () => Promise<{
		ok: boolean;
		message: string;
	}>;
	getGatewayStatus?: () => Promise<{
		ok: boolean;
		status?: StatusResponsePayload;
		message?: string;
	}>;
	configPath?: () => string;
	logOut?: (message: string) => void;
	logError?: (message: string) => void;
	makeInstanceSocketClient?: (opts: {
		dashboardUrl: string;
		instanceId: string;
		accessToken: string;
		log: InstanceSocketLogger;
	}) => InstanceSocketClient;
	waitForShutdown?: () => Promise<string>;
	/**
	 * Override the shared refresh helper. Production uses the lock-and-rotate
	 * implementation in `dashboardAuth.ts`; tests inject a fake.
	 */
	performRefresh?: (
		label: 'refresh' | 'connect',
	) => Promise<DashboardAccessToken>;
	executeRemoteAssignment?: (
		input: ExecuteRemoteAssignmentInput,
	) => Promise<void>;
};

export type ConsoleChannelConfig = {
	broker_url: string;
	runner_id: string;
	dashboard_config: true;
};

type PairResponse = {
	instanceId: string;
	refreshToken: string;
	jti?: string;
	accessToken?: string;
	expiresInSec?: number;
	runners?: Array<{runnerId: string}>;
};

type DiagnosticPlane =
	| 'pairing'
	| 'instance-socket'
	| 'console-sidecar'
	| 'gateway'
	| 'console-adapter'
	| 'runtime';

type DiagnosticResult = {
	plane: DiagnosticPlane;
	ok: boolean;
	status: 'ok' | 'fail' | 'warn' | 'unknown';
	note: string;
};

function defaultFingerprint(): string {
	const seed = [
		os.hostname(),
		os.userInfo().username,
		os.platform(),
		os.arch(),
	].join('\0');
	return crypto.createHash('sha256').update(seed).digest('hex');
}

function defaultHostInfo(name?: string): Record<string, unknown> {
	return {
		hostname: os.hostname(),
		user: os.userInfo().username,
		platform: os.platform(),
		arch: os.arch(),
		name: name ?? os.hostname(),
	};
}

export function consoleBrokerUrl(
	dashboardUrl: string,
	runnerId: string,
): string {
	const url = new URL(dashboardUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.pathname = `/api/runners/${encodeURIComponent(runnerId)}/console/adapter`;
	url.search = '';
	url.hash = '';
	return url.toString();
}

export function writeConsoleChannelConfig(config: ConsoleChannelConfig): void {
	const dir = path.join(os.homedir(), '.config', 'athena', 'channels');
	const configPath = path.join(dir, 'console.json');
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

function readConsoleChannelConfig(): ConsoleChannelConfig | null {
	const configPath = path.join(
		os.homedir(),
		'.config',
		'athena',
		'channels',
		'console.json',
	);
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
		if (typeof parsed !== 'object' || parsed === null) return null;
		const obj = parsed as Record<string, unknown>;
		if (
			typeof obj['broker_url'] !== 'string' ||
			typeof obj['runner_id'] !== 'string' ||
			obj['dashboard_config'] !== true
		) {
			return null;
		}
		return {
			broker_url: obj['broker_url'],
			runner_id: obj['runner_id'],
			dashboard_config: true,
		};
	} catch {
		return null;
	}
}

async function defaultReloadGatewayChannels(): Promise<{
	ok: boolean;
	message: string;
}> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runGatewayCommand(
		{subcommand: 'reload-channels', subcommandArgs: []},
		{
			logOut: message => out.push(message),
			logError: message => err.push(message),
		},
	);
	return {
		ok: code === 0,
		message:
			(code === 0 ? out.join('\n') : err.join('\n')) ||
			(code === 0 ? 'gateway channels reloaded' : 'gateway not reachable'),
	};
}

async function defaultGetGatewayStatus(): Promise<{
	ok: boolean;
	status?: StatusResponsePayload;
	message?: string;
}> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runGatewayCommand(
		{subcommand: 'status', subcommandArgs: ['--json']},
		{
			logOut: message => out.push(message),
			logError: message => err.push(message),
		},
	);
	if (code !== 0) {
		return {
			ok: false,
			message: err.join('\n') || out.join('\n') || 'gateway not reachable',
		};
	}
	try {
		return {
			ok: true,
			status: JSON.parse(out.join('\n')) as StatusResponsePayload,
		};
	} catch (error) {
		return {
			ok: false,
			message: `gateway status returned invalid JSON: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}

function parseDoctorArgs(
	args: string[],
): {runnerId?: string} | {error: string} {
	let runnerId: string | undefined;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === '--runner') {
			const value = args[i + 1];
			if (!value || value.startsWith('--')) {
				return {error: 'dashboard doctor: --runner requires a runner id'};
			}
			runnerId = value;
			i += 1;
			continue;
		}
		return {error: `dashboard doctor: unexpected argument ${arg}`};
	}
	return runnerId === undefined ? {} : {runnerId};
}

function plane(
	planeName: DiagnosticPlane,
	ok: boolean,
	note: string,
	status: DiagnosticResult['status'] = ok ? 'ok' : 'fail',
): DiagnosticResult {
	return {plane: planeName, ok, status, note};
}

function formatDiagnostic(result: DiagnosticResult): string {
	return `${result.plane}: ${result.status} — ${result.note}`;
}

function runtimePlane(
	status: StatusResponsePayload | undefined,
): DiagnosticResult {
	if (!status) return plane('runtime', false, 'gateway status unavailable');
	if (status.runtimes.length === 0) {
		return plane('runtime', false, 'no runtime registered');
	}
	const active = status.runtimes.find(r => r.binding.state === 'active');
	if (!active) {
		return plane('runtime', false, 'runtime registered but not actively bound');
	}
	const binding = active.binding;
	if (binding.state !== 'active') {
		return plane('runtime', false, 'runtime registered but not actively bound');
	}
	return plane(
		'runtime',
		true,
		`registered ${active.runtimeId} pid=${active.pid} epoch=${binding.epoch}`,
	);
}

function listenerDescription(status: StatusResponsePayload): string {
	const listener = status.listener;
	if (listener.kind === 'uds') return `uds:${listener.socketPath}`;
	return listener.url;
}

function consoleAdapterPlane(
	status: StatusResponsePayload | undefined,
): DiagnosticResult {
	if (!status)
		return plane('console-adapter', false, 'gateway status unavailable');
	const channel = status.channels.find(c => c.id === 'console');
	if (!channel) {
		return plane('console-adapter', false, 'console channel is not registered');
	}
	const ok = channel.state === 'running';
	return plane(
		'console-adapter',
		ok,
		channel.note
			? `${channel.state}: ${channel.note}`
			: `console channel ${channel.state}`,
		ok ? 'ok' : 'fail',
	);
}

async function buildDiagnostics(opts: {
	config: DashboardClientConfig | null;
	runnerId?: string;
	consoleConfig: ConsoleChannelConfig | null;
	getGatewayStatus: () => Promise<{
		ok: boolean;
		status?: StatusResponsePayload;
		message?: string;
	}>;
}): Promise<DiagnosticResult[]> {
	const results: DiagnosticResult[] = [];
	if (!opts.config) {
		results.push(plane('pairing', false, 'not paired'));
		results.push(plane('instance-socket', false, 'pairing required'));
		results.push(plane('console-sidecar', false, 'pairing required'));
		results.push(plane('gateway', false, 'pairing required'));
		results.push(plane('console-adapter', false, 'pairing required'));
		results.push(plane('runtime', false, 'pairing required'));
		return results;
	}

	results.push(
		plane(
			'pairing',
			true,
			`paired to ${opts.config.dashboardUrl} as ${opts.config.instanceId}`,
		),
	);
	results.push(
		plane(
			'instance-socket',
			true,
			'pairing is present; run "athena dashboard connect" to keep this instance online',
			'warn',
		),
	);

	if (opts.runnerId) {
		if (!opts.consoleConfig) {
			results.push(
				plane(
					'console-sidecar',
					false,
					'console sidecar missing; run "athena dashboard console link <runner-id>"',
				),
			);
		} else if (opts.consoleConfig.runner_id !== opts.runnerId) {
			results.push(
				plane(
					'console-sidecar',
					false,
					`console sidecar linked to ${opts.consoleConfig.runner_id}, expected ${opts.runnerId}`,
				),
			);
		} else {
			results.push(
				plane(
					'console-sidecar',
					true,
					`console sidecar linked to ${opts.runnerId}`,
				),
			);
		}
	} else {
		results.push(
			opts.consoleConfig
				? plane(
						'console-sidecar',
						true,
						`console sidecar linked to ${opts.consoleConfig.runner_id}`,
					)
				: plane(
						'console-sidecar',
						false,
						'console sidecar missing; pass --runner and run console link',
						'warn',
					),
		);
	}

	const gateway = await opts.getGatewayStatus();
	if (!gateway.ok) {
		results.push(
			plane('gateway', false, gateway.message ?? 'gateway not reachable'),
		);
		results.push(plane('console-adapter', false, 'gateway status unavailable'));
		results.push(plane('runtime', false, 'gateway status unavailable'));
		return results;
	}
	results.push(
		plane(
			'gateway',
			true,
			gateway.status
				? `daemon pid=${gateway.status.daemonPid} listener=${listenerDescription(
						gateway.status,
					)}`
				: 'daemon status missing',
		),
	);
	results.push(consoleAdapterPlane(gateway.status));
	results.push(runtimePlane(gateway.status));
	return results;
}

export async function runDashboardCommand(
	input: DashboardCommandInput,
	deps: DashboardCommandDeps = {},
): Promise<number> {
	const logOut = deps.logOut ?? ((m: string) => process.stdout.write(m + '\n'));
	const logError =
		deps.logError ?? ((m: string) => process.stderr.write(m + '\n'));
	const fetchImpl = deps.fetch ?? fetch;
	const now = deps.now ?? (() => Date.now());
	const fingerprint = deps.fingerprint ?? defaultFingerprint;
	const readConfig = deps.readConfig ?? (() => readDashboardClientConfig());
	const writeConfig =
		deps.writeConfig ??
		((c: DashboardClientConfig) => writeDashboardClientConfig(c));
	const removeConfig =
		deps.removeConfig ?? (() => removeDashboardClientConfig());
	const writeConsoleConfig =
		deps.writeConsoleChannelConfig ?? writeConsoleChannelConfig;
	const readConsoleConfig =
		deps.readConsoleChannelConfig ?? readConsoleChannelConfig;
	const reloadGatewayChannels =
		deps.reloadGatewayChannels ?? defaultReloadGatewayChannels;
	const getGatewayStatus = deps.getGatewayStatus ?? defaultGetGatewayStatus;
	const configPath = deps.configPath ?? (() => dashboardClientConfigPath());
	const packageVersion = deps.packageVersion ?? readPackageVersion();

	const {subcommand, subcommandArgs, flags} = input;

	if (!subcommand || subcommand === 'help' || subcommand === '--help') {
		logOut(USAGE);
		return 0;
	}

	if (subcommand === 'pair') {
		const token = subcommandArgs[0];
		if (!token) {
			logError('dashboard pair: missing pairing token');
			logError(USAGE);
			return 2;
		}
		if (subcommandArgs.length > 1) {
			logError(`dashboard pair: unexpected argument ${subcommandArgs[1]}`);
			return 2;
		}
		if (!flags.url) {
			logError('dashboard pair: --url <dashboard-origin> is required');
			return 2;
		}
		let origin: string;
		try {
			origin = normalizeDashboardUrl(flags.url);
		} catch (err) {
			logError(
				`dashboard pair: ${err instanceof Error ? err.message : String(err)}`,
			);
			return 2;
		}

		const fp = fingerprint();
		const body = {
			token,
			fingerprint: fp,
			hostInfo: (deps.hostInfo ?? (() => defaultHostInfo(flags.name)))(),
			capabilities: {
				instanceSocket: true,
				consoleAdapter: true,
				version: packageVersion,
			},
		};

		let response: Response;
		try {
			response = await fetchImpl(`${origin}/api/instances/pair`, {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: JSON.stringify(body),
			});
		} catch (err) {
			logError(
				`dashboard pair: failed to reach ${origin}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return 1;
		}
		if (!response.ok) {
			const message = await safeReadError(response);
			logError(
				`dashboard pair: ${origin} returned ${response.status}${
					message ? ` — ${message}` : ''
				}`,
			);
			return 1;
		}

		let parsed: PairResponse;
		try {
			parsed = parsePairResponse(await response.json());
		} catch (err) {
			logError(
				`dashboard pair: invalid response from ${origin}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return 1;
		}

		const config: DashboardClientConfig = {
			dashboardUrl: origin,
			instanceId: parsed.instanceId,
			refreshToken: parsed.refreshToken,
			fingerprint: fp,
			pairedAt: now(),
		};
		writeConfig(config);
		const pairedRunner = parsed.runners?.[0];
		let reloadResult:
			| {
					ok: boolean;
					message: string;
			  }
			| undefined;
		if (pairedRunner) {
			const consoleConfig: ConsoleChannelConfig = {
				broker_url: consoleBrokerUrl(origin, pairedRunner.runnerId),
				runner_id: pairedRunner.runnerId,
				dashboard_config: true,
			};
			writeConsoleConfig(consoleConfig);
			if (!flags.json) {
				logOut(
					`dashboard: console linked runner ${pairedRunner.runnerId} to ${origin}`,
				);
			}
			reloadResult = await reloadGatewayChannels();
			if (reloadResult.ok) {
				if (!flags.json) {
					logOut(
						`dashboard: gateway channels reloaded (${reloadResult.message})`,
					);
				}
			} else {
				logError(`dashboard: gateway reload skipped: ${reloadResult.message}`);
				if (!flags.json) {
					logOut(
						'dashboard: start or reload the gateway before using the Console tab.',
					);
				}
			}
		}

		if (flags.json) {
			logOut(
				JSON.stringify({
					ok: true,
					instanceId: parsed.instanceId,
					dashboardUrl: origin,
					configPath: configPath(),
					...(parsed.runners ? {runners: parsed.runners} : {}),
					...(reloadResult
						? {
								gatewayReload: {
									ok: reloadResult.ok,
									message: reloadResult.message,
								},
							}
						: {}),
				}),
			);
		} else {
			logOut(`dashboard: paired to ${origin} as ${parsed.instanceId}`);
		}
		return 0;
	}

	if (subcommand === 'status') {
		if (subcommandArgs.length > 0) {
			logError(`dashboard status: unexpected argument ${subcommandArgs[0]}`);
			return 2;
		}
		const config = readConfig();
		if (!config) {
			if (flags.json) {
				logOut(JSON.stringify({ok: false, paired: false}));
			} else {
				logOut('dashboard: not paired');
			}
			return 1;
		}
		if (flags.json) {
			logOut(
				JSON.stringify({
					ok: true,
					paired: true,
					instanceId: config.instanceId,
					dashboardUrl: config.dashboardUrl,
					pairedAt: config.pairedAt,
					...(config.lastRefreshAt !== undefined
						? {lastRefreshAt: config.lastRefreshAt}
						: {}),
					configPath: configPath(),
				}),
			);
		} else {
			logOut(
				`dashboard: paired to ${config.dashboardUrl} as ${config.instanceId}`,
			);
		}
		return 0;
	}

	if (subcommand === 'doctor') {
		const parsed = parseDoctorArgs(subcommandArgs);
		if ('error' in parsed) {
			logError(parsed.error);
			return 2;
		}
		const planes = await buildDiagnostics({
			config: readConfig(),
			...(parsed.runnerId !== undefined ? {runnerId: parsed.runnerId} : {}),
			consoleConfig: readConsoleConfig(),
			getGatewayStatus,
		});
		const ok = planes.every(p => p.ok || p.status === 'warn');
		if (flags.json) {
			logOut(JSON.stringify({ok, planes}));
		} else {
			logOut('dashboard doctor:');
			for (const result of planes) {
				logOut(`  ${formatDiagnostic(result)}`);
			}
		}
		return ok ? 0 : 1;
	}

	if (subcommand === 'console') {
		const [action, runnerId, extra] = subcommandArgs;
		if (action !== 'link' || !runnerId || extra) {
			logError(
				'dashboard console: Usage: athena dashboard console link <runner-id>',
			);
			return 2;
		}
		const config = readConfig();
		if (!config) {
			logError(
				'dashboard console link: not paired. Run "athena dashboard pair" first.',
			);
			return 1;
		}
		const consoleConfig: ConsoleChannelConfig = {
			broker_url: consoleBrokerUrl(config.dashboardUrl, runnerId),
			runner_id: runnerId,
			dashboard_config: true,
		};
		writeConsoleConfig(consoleConfig);
		logOut(
			`dashboard: console linked runner ${runnerId} to ${config.dashboardUrl}`,
		);
		const reload = await reloadGatewayChannels();
		if (reload.ok) {
			logOut(`dashboard: gateway channels reloaded (${reload.message})`);
		} else {
			logError(`dashboard: gateway reload skipped: ${reload.message}`);
			logOut(
				'dashboard: start or reload the gateway before using the Console tab.',
			);
		}
		return 0;
	}

	const performRefreshImpl =
		deps.performRefresh ??
		(async (_label: 'refresh' | 'connect') =>
			refreshDashboardAccessToken({fetch: fetchImpl, now}));

	async function tryRefresh(
		label: 'refresh' | 'connect',
	): Promise<
		{ok: true; token: DashboardAccessToken} | {ok: false; code: number}
	> {
		try {
			const token = await performRefreshImpl(label);
			return {ok: true, token};
		} catch (err) {
			logError(
				`dashboard ${label}: ${err instanceof Error ? err.message : String(err)}`,
			);
			return {ok: false, code: 1};
		}
	}

	if (subcommand === 'refresh') {
		if (subcommandArgs.length > 0) {
			logError(`dashboard refresh: unexpected argument ${subcommandArgs[0]}`);
			return 2;
		}
		if (!readConfig()) {
			logError(
				'dashboard refresh: not paired. Run "athena dashboard pair" first.',
			);
			return 1;
		}
		const result = await tryRefresh('refresh');
		if (!result.ok) return result.code;
		const {token} = result;
		if (flags.json) {
			// Re-read so callers get the rotated refresh token alongside the
			// access token. The refresh helper rotates the on-disk value before
			// returning so this is consistent.
			const rotated = readConfig();
			logOut(
				JSON.stringify({
					ok: true,
					instanceId: token.instanceId,
					accessToken: token.accessToken,
					refreshToken: rotated?.refreshToken,
					expiresInSec: token.expiresInSec,
				}),
			);
		} else {
			logOut(
				`dashboard: refreshed access token for instance ${token.instanceId}`,
			);
		}
		return 0;
	}

	if (subcommand === 'connect') {
		if (subcommandArgs.length > 0) {
			logError(`dashboard connect: unexpected argument ${subcommandArgs[0]}`);
			return 2;
		}
		const config = readConfig();
		if (!config) {
			logError(
				'dashboard connect: not paired. Run "athena dashboard pair" first.',
			);
			return 1;
		}
		const result = await tryRefresh('connect');
		if (!result.ok) return result.code;
		const {token} = result;

		const makeSocket =
			deps.makeInstanceSocketClient ??
			(o =>
				createInstanceSocketClient({
					dashboardUrl: o.dashboardUrl,
					instanceId: o.instanceId,
					accessToken: o.accessToken,
					log: o.log,
				}));
		const client = makeSocket({
			dashboardUrl: config.dashboardUrl,
			instanceId: token.instanceId,
			accessToken: token.accessToken,
			log: (level, message) => {
				if (level === 'error' || level === 'warn') {
					logError(`dashboard: ${message}`);
				}
			},
		});

		const runAssignment =
			deps.executeRemoteAssignment ?? executeRemoteAssignment;
		let assignmentQueue = Promise.resolve();
		client.onFrame(frame => {
			if (frame.type !== 'job_assignment') return;
			assignmentQueue = assignmentQueue
				.then(() =>
					runAssignment({
						frame,
						client,
						projectDir: process.cwd(),
						log: (level, message) => {
							if (level === 'error' || level === 'warn') {
								logError(`dashboard: ${message}`);
							}
						},
					}),
				)
				.catch(err => {
					logError(
						`dashboard: remote assignment failed: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				});
		});

		try {
			await client.connect();
		} catch (err) {
			logError(
				`dashboard connect: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return 1;
		}

		logOut(`dashboard: connected instance ${token.instanceId}`);

		// Race the user-driven shutdown signal against an unsolicited socket
		// close. If the socket drops first (server hangup, network, expired
		// token) we exit non-zero so callers/process supervisors can react —
		// reconnect-with-refresh is a follow-up.
		const wait = deps.waitForShutdown ?? defaultWaitForShutdown;
		const closePromise = new Promise<{kind: 'closed'; reason: string}>(
			resolve => {
				client.onClose(reason => resolve({kind: 'closed', reason}));
			},
		);
		const shutdownPromise = wait().then(reason => ({
			kind: 'shutdown' as const,
			reason,
		}));
		const exitTrigger = await Promise.race([closePromise, shutdownPromise]);

		if (exitTrigger.kind === 'closed') {
			logError(`dashboard: socket closed unexpectedly (${exitTrigger.reason})`);
			client.close('socket closed');
			return 1;
		}
		client.close(exitTrigger.reason);
		logOut(`dashboard: disconnected (${exitTrigger.reason})`);
		return 0;
	}

	if (subcommand === 'unpair') {
		if (subcommandArgs.length > 0) {
			logError(`dashboard unpair: unexpected argument ${subcommandArgs[0]}`);
			return 2;
		}
		removeConfig();
		if (flags.json) {
			logOut(JSON.stringify({ok: true}));
		} else {
			logOut('dashboard: unpaired');
		}
		return 0;
	}

	logError(`Unknown dashboard subcommand: ${subcommand}`);
	logError(USAGE);
	return 2;
}

function defaultWaitForShutdown(): Promise<string> {
	return new Promise<string>(resolve => {
		const onSignal = (signal: NodeJS.Signals): void => {
			process.off('SIGINT', onSignal);
			process.off('SIGTERM', onSignal);
			resolve(signal);
		};
		process.once('SIGINT', onSignal);
		process.once('SIGTERM', onSignal);
	});
}

async function safeReadError(response: Response): Promise<string> {
	try {
		const text = await response.text();
		if (text.length === 0) return '';
		try {
			const parsed = JSON.parse(text) as unknown;
			if (
				typeof parsed === 'object' &&
				parsed !== null &&
				typeof (parsed as Record<string, unknown>)['error'] === 'string'
			) {
				return (parsed as Record<string, string>)['error']!;
			}
		} catch {
			// fall through to raw text
		}
		return text.length > 200 ? text.slice(0, 200) + '…' : text;
	} catch {
		return '';
	}
}

function parsePairResponse(raw: unknown): PairResponse {
	if (typeof raw !== 'object' || raw === null) {
		throw new Error('expected object');
	}
	const obj = raw as Record<string, unknown>;
	const instanceId = obj['instanceId'];
	const refreshToken = obj['refreshToken'];
	if (typeof instanceId !== 'string' || instanceId.length === 0) {
		throw new Error('missing instanceId');
	}
	if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
		throw new Error('missing refreshToken');
	}
	return {
		instanceId,
		refreshToken,
		...(Array.isArray(obj['runners'])
			? {
					runners: obj['runners']
						.map((entry: unknown) => {
							if (typeof entry !== 'object' || entry === null) return null;
							const runnerId = (entry as Record<string, unknown>)['runnerId'];
							return typeof runnerId === 'string' && runnerId.length > 0
								? {runnerId}
								: null;
						})
						.filter((entry): entry is {runnerId: string} => entry !== null),
				}
			: {}),
		...(typeof obj['jti'] === 'string' ? {jti: obj['jti'] as string} : {}),
		...(typeof obj['accessToken'] === 'string'
			? {accessToken: obj['accessToken'] as string}
			: {}),
		...(typeof obj['expiresInSec'] === 'number'
			? {expiresInSec: obj['expiresInSec'] as number}
			: {}),
	};
}
