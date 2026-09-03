import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
	type InstanceSocketClient,
	type InstanceSocketLogger,
} from '../dashboard/instanceSocketClient';
import {executeRemoteAssignment} from '../dashboard/remoteRunExecutor';
import {RunnerStartupError, startRunnerProcess} from '../runner/runnerProcess';
import {
	readRunnerStatusFile,
	type RunnerStatus,
} from '../runner/runnerStatusFile';
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
import {
	type AttachmentMirror,
	readAttachmentMirror,
	removeAttachmentMirror,
	writeAttachmentMirror,
} from '../../infra/config/attachmentMirror';
import type {AttachmentReconcilerFetchInput} from '../dashboard/attachmentReconciler';
import {
	runnerStatePaths,
	type RunnerStatePaths,
} from '../../infra/daemon/stateDir';
import {
	alreadyRunningMessage,
	readPidLock,
	type PidLockReadResult,
} from '../../infra/daemon/pidLock';
import {
	installServiceUnit,
	type ServiceInstallResult,
} from '../../infra/daemon/serviceUnit';

const USAGE = `Usage: drisp runner [subcommand] [options]

The runner is the one long-lived process that pairs this machine with the
hub, receives its Runs over the instance socket, and executes them. Its
state lives in ~/.local/state/drisp/ (runner.pid, runner.db, runner.log,
runner.status.json).

Subcommands:
  (none)    Run the runner in the foreground. Exits non-zero with
            "already running (pid N)" when another runner holds the pid file.
  --detach  Start the runner in the background and verify it reaches the
            hub's socket.
  stop      Stop the background runner (SIGTERM to the pid in runner.pid).
  restart   Stop, then start detached.
  status    Show pairing, the runner process (from runner.pid and
            runner.status.json), socket health, and token freshness.
            Non-zero on any unhealthy axis. --runner <id> also checks the
            hub-side runner binding.
  logs [--tail N] [--follow]
            Tail the runner log at ~/.local/state/drisp/runner.log.
  runs [--active] [--limit N]
            List runs the runner has handled (last 100, from the status file).
  install   Generate a launchd plist (macOS) or systemd user unit (linux)
            so the runner starts automatically on login.
  pair <token> --url <dashboard-origin> [--name <machine-name>]
            Pair this machine with the hub and start the runner.
  unpair    Stop the runner, revoke the refresh token, and remove the
            local config.
  refresh   Mint a short-lived access token (rotates the refresh token).
  doctor    Verify pairing health. With --runner <id>, also confirms the
            hub-side runner is bound to this instance.
  list      Print the local attachment mirror (the hub-side runners bound
            to this instance at the last pair/refresh).

Options:
  --detach            Run in the background (no subcommand)
  --url <origin>      Dashboard origin (required for pair)
  --runner <id>       Hub-side runner id (optional for "doctor" / "status")
  --name <name>       Friendly machine name (optional, defaults to hostname)
  --tail N            Number of trailing log lines (default 20)
  --follow            Stream new log lines until interrupted
  --active            Show only active runs
  --limit N           Cap the number of runs returned
  --json              Emit machine-readable JSON output

"drisp dashboard <subcommand>" is a deprecated alias of this command and is
removed in 0.7.0.
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

export type RunnerCommandFlags = {
	/** Start in the background (no subcommand). */
	detach?: boolean;
	url?: string;
	name?: string;
	runner?: string;
	json?: boolean;
	tail?: number;
	follow?: boolean;
	active?: boolean;
	limit?: number;
};

export type RunnerCommandInput = {
	subcommand: string;
	subcommandArgs: string[];
	flags: RunnerCommandFlags;
};

export type RunnerCommandDeps = {
	fetch?: typeof fetch;
	now?: () => number;
	fingerprint?: () => string;
	hostInfo?: () => Record<string, unknown>;
	packageVersion?: string;
	readConfig?: () => DashboardClientConfig | null;
	writeConfig?: (config: DashboardClientConfig) => void;
	removeConfig?: () => void;
	configPath?: () => string;
	readMirror?: () => AttachmentMirror | null;
	writeMirror?: (mirror: AttachmentMirror) => void;
	removeMirror?: () => void;
	fetchAttachments?: (
		input: AttachmentReconcilerFetchInput,
	) => Promise<AttachmentMirror['attachments']>;
	logOut?: (message: string) => void;
	logError?: (message: string) => void;
	makeInstanceSocketClient?: (opts: {
		dashboardUrl: string;
		instanceId: string;
		accessToken: string;
		log: InstanceSocketLogger;
	}) => InstanceSocketClient;
	executeRemoteAssignment?: typeof executeRemoteAssignment;
	waitForShutdown?: () => Promise<string>;
	startDetachedRunner?: (opts: {
		log: (msg: string) => void;
	}) => Promise<RunnerStartResult>;
	stopRunner?: (opts: {timeoutMs?: number}) => Promise<RunnerStopResult>;
	/** Read the pid file and the status file. Production: the state dir. */
	readRunnerStatus?: () => RunnerStatusReport;
	statePaths?: () => RunnerStatePaths;
	tailRunnerLog?: (opts: {tail: number; follow: boolean}) => Promise<number>;
	installServiceUnit?: () => ServiceInstallResult;
	/**
	 * Override the shared refresh helper. Production uses the lock-and-rotate
	 * implementation in `dashboardAuth.ts`; tests inject a fake.
	 */
	performRefresh?: (
		label: 'refresh' | 'connect',
	) => Promise<DashboardAccessToken>;
};

export type RunnerStartResult = {
	ok: boolean;
	/** The runner that was up before the start was cycled (pair). */
	restarted?: boolean;
	connected?: boolean;
	pid?: number;
	message?: string;
};

export type RunnerStopResult = {
	ok: boolean;
	wasRunning: boolean;
	message?: string;
};

/**
 * What `drisp runner status` knows without a control socket: the pid file
 * says whether a runner is alive; the status file (rewritten by the runner
 * on change) carries its snapshot. A status file whose pid is not the live
 * pid is stale and ignored.
 */
export type RunnerStatusReport =
	| {running: false; error?: string}
	| {running: true; status: RunnerStatus};

type PairedRunner = {
	runnerId: string;
	name?: string;
	executionTarget?: string;
	remoteInstanceId?: string;
};

type CapabilityAck = {
	runtimeDaemon?: boolean;
	instanceSocket?: boolean;
};

type PairResponse = {
	instanceId: string;
	refreshToken: string;
	jti?: string;
	accessToken?: string;
	expiresInSec?: number;
	runners?: PairedRunner[];
	requiredCliVersion?: string;
	capabilityAck?: CapabilityAck;
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

export async function runRunnerCommand(
	input: RunnerCommandInput,
	deps: RunnerCommandDeps = {},
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
	const configPath = deps.configPath ?? (() => dashboardClientConfigPath());
	const readMirror = deps.readMirror ?? (() => readAttachmentMirror());
	const writeMirror =
		deps.writeMirror ?? ((m: AttachmentMirror) => writeAttachmentMirror(m));
	const removeMirror = deps.removeMirror ?? (() => removeAttachmentMirror());
	const packageVersion = deps.packageVersion ?? readPackageVersion();

	const {subcommand, subcommandArgs, flags} = input;

	if (subcommand === 'help' || subcommand === '--help') {
		logOut(USAGE);
		return 0;
	}

	if (subcommand === 'pair') {
		const token = subcommandArgs[0];
		if (!token) {
			logError('runner pair: missing pairing token');
			logError(USAGE);
			return 2;
		}
		if (subcommandArgs.length > 1) {
			logError(`runner pair: unexpected argument ${subcommandArgs[1]}`);
			return 2;
		}
		if (!flags.url) {
			logError('runner pair: --url <dashboard-origin> is required');
			return 2;
		}
		let origin: string;
		try {
			origin = normalizeDashboardUrl(flags.url);
		} catch (err) {
			logError(
				`runner pair: ${err instanceof Error ? err.message : String(err)}`,
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
				runtimeDaemon: true,
				cliVersion: packageVersion,
				// Legacy field — older dashboards read `version`. Drop in a
				// follow-up release once the dashboard accepts only `cliVersion`.
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
				`runner pair: failed to reach ${origin}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return 1;
		}
		if (!response.ok) {
			const message = await safeReadError(response);
			logError(
				`runner pair: ${origin} returned ${response.status}${
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
				`runner pair: invalid response from ${origin}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return 1;
		}

		// Refuse to install the daemon if the dashboard signals our CLI is too
		// old. The pairing succeeded server-side already, so the user can still
		// re-run pair after upgrading and the persisted config is the source of
		// truth — we just don't spawn a daemon that the dashboard would refuse
		// to handshake with.
		if (
			parsed.requiredCliVersion &&
			compareSemver(packageVersion, parsed.requiredCliVersion) < 0
		) {
			logError(
				`runner pair: cli version ${packageVersion} is older than the dashboard's required >=${parsed.requiredCliVersion}.`,
			);
			logError(
				'runner pair: upgrade with `npm i -g @drisp/cli` then re-run pair.',
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

		// Mirror the dashboard's runner-attachment list locally. The dashboard
		// remains the source of truth — we just stop discarding the data the
		// pair response already carries, so subsequent commands can read
		// "which runners are attached?" without a round-trip.
		try {
			writeMirror({
				instanceId: parsed.instanceId,
				fetchedAt: now(),
				attachments: (parsed.runners ?? []).map(r => ({
					runnerId: r.runnerId,
					...(r.name !== undefined ? {name: r.name} : {}),
					...(r.executionTarget !== undefined
						? {executionTarget: r.executionTarget}
						: {}),
					...(r.remoteInstanceId !== undefined
						? {remoteInstanceId: r.remoteInstanceId}
						: {}),
				})),
			});
		} catch (err) {
			logError(
				`runner pair: failed to write attachment mirror: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}

		// A runner already up holds the pre-pair refresh token; cycle it so it
		// reconnects with the rotated one.
		const priorStop = await (deps.stopRunner ?? defaultStopRunner)({});
		const started = await (
			deps.startDetachedRunner ?? defaultStartDetachedRunner
		)({
			log: msg => logOut(msg),
		});
		const daemonStart: RunnerStartResult = {
			...started,
			...(priorStop.wasRunning ? {restarted: true} : {}),
		};

		if (flags.json) {
			logOut(
				JSON.stringify({
					ok: true,
					instanceId: parsed.instanceId,
					dashboardUrl: origin,
					configPath: configPath(),
					runner: daemonStart,
					...(parsed.runners ? {runners: parsed.runners} : {}),
					...(parsed.capabilityAck
						? {capabilityAck: parsed.capabilityAck}
						: {}),
					...(parsed.requiredCliVersion
						? {requiredCliVersion: parsed.requiredCliVersion}
						: {}),
				}),
			);
		} else {
			logOut(`runner: paired to ${origin} as ${parsed.instanceId}`);
			if (parsed.runners && parsed.runners.length > 0) {
				for (const runner of parsed.runners) {
					logOut(
						`runner: bound runner ${runner.name ?? runner.runnerId} (${runner.runnerId})`,
					);
				}
			} else {
				logOut('runner: no runner bound to this pairing token.');
				logOut(
					'runner: bind a runner from runner settings, then this machine will receive its runs.',
				);
			}
			if (parsed.capabilityAck === undefined) {
				logOut(
					'runner: dashboard did not echo capabilityAck (older server). Continuing.',
				);
			}
			if (daemonStart.ok) {
				const status = daemonStart.connected
					? `runner connected (verified socket open${
							daemonStart.restarted ? ', restarted with the new token' : ''
						})`
					: 'runner started but did not reach the socket within 10s';
				logOut(`runner: ${status}`);
				if (!daemonStart.connected) {
					logOut(
						'runner pair: pairing succeeded; tail logs with `drisp runner logs --follow`.',
					);
				}
			} else {
				logError(
					`runner: runner did not start${
						daemonStart.message ? ` — ${daemonStart.message}` : ''
					}`,
				);
				logOut(
					'runner pair: pairing succeeded; start the runner with `drisp runner --detach`.',
				);
			}
			logOut('runner: ready. Click Run in the dashboard.');
		}
		// Pairing on disk is the source of truth. A runner spawn failure is a
		// warning, not a pair failure — the user can retry `--detach` later.
		return 0;
	}

	if (subcommand === 'status') {
		if (subcommandArgs.length > 0) {
			logError(`runner status: unexpected argument ${subcommandArgs[0]}`);
			return 2;
		}
		const config = readConfig();
		if (!config) {
			if (flags.json) {
				logOut(JSON.stringify({ok: false, paired: false}));
			} else {
				logOut('runner: not paired');
			}
			return 1;
		}
		const readStatus = deps.readRunnerStatus ?? defaultReadRunnerStatus;
		let report: RunnerStatusReport;
		try {
			report = readStatus();
		} catch (err) {
			report = {
				running: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}

		// Optional runner check: if --runner is supplied, do the same dashboard
		// GET that doctor does. Saves the user from running two commands when
		// they want a full health check.
		type RunnerHealth = {
			id: string;
			matches: boolean;
			error?: string;
			executionTarget?: string;
			remoteInstanceId?: string;
		};
		let runnerHealth: RunnerHealth | undefined;
		if (flags.runner) {
			const refreshResult = await tryRefresh('refresh');
			if (refreshResult.ok) {
				runnerHealth = await fetchRunnerHealth(
					fetchImpl,
					config.dashboardUrl,
					flags.runner,
					refreshResult.token,
				);
			} else {
				runnerHealth = {
					id: flags.runner,
					matches: false,
					error: 'could not refresh access token',
				};
			}
		}

		const socketHealthy = report.running && report.status.socketConnected;
		const runnerOk = !runnerHealth || runnerHealth.matches;
		const ok = report.running && socketHealthy && runnerOk;

		if (flags.json) {
			logOut(
				JSON.stringify({
					ok,
					paired: true,
					instanceId: config.instanceId,
					dashboardUrl: config.dashboardUrl,
					pairedAt: config.pairedAt,
					...(config.lastRefreshAt !== undefined
						? {lastRefreshAt: config.lastRefreshAt}
						: {}),
					configPath: configPath(),
					runner: report.running
						? {
								running: true,
								pid: report.status.pid,
								startedAt: report.status.startedAt,
								updatedAt: report.status.updatedAt,
								socketConnected: report.status.socketConnected,
								...(report.status.wireMode !== undefined
									? {wireMode: report.status.wireMode}
									: {}),
								...(report.status.lastFrameAt !== undefined
									? {lastFrameAt: report.status.lastFrameAt}
									: {}),
								activeRuns: report.status.activeRuns,
								completedRuns: report.status.completedRuns,
								...(report.status.refreshState
									? {refreshState: report.status.refreshState}
									: {}),
							}
						: {
								running: false,
								...(report.error ? {error: report.error} : {}),
							},
					...(runnerHealth ? {binding: runnerHealth} : {}),
				}),
			);
		} else {
			logOut(
				`runner: paired to ${config.dashboardUrl} as ${config.instanceId}`,
			);
			if (runnerHealth) {
				if (runnerHealth.matches) {
					logOut(
						`binding:   ${runnerHealth.id} bound to this instance (executionTarget=remote)`,
					);
				} else {
					logError(
						`binding:   ${runnerHealth.id} ${runnerHealth.error ?? 'not bound'}`,
					);
				}
			}
			if (report.running) {
				const r = report.status;
				const uptimeSec = Math.max(
					0,
					Math.floor((now() - r.startedAt) / 1_000),
				);
				logOut(
					`runner:    running (pid ${r.pid}, uptime ${formatDuration(uptimeSec)}, ${r.completedRuns} runs completed, ${r.activeRuns} active)`,
				);
				logOut(
					`socket:    ${r.socketConnected ? 'connected' : 'disconnected'}${
						r.wireMode ? ` (${r.wireMode} frame names)` : ''
					}${
						r.lastFrameAt !== undefined
							? ` (last frame ${formatDuration(
									Math.max(0, Math.floor((now() - r.lastFrameAt) / 1_000)),
								)} ago)`
							: ''
					}`,
				);
				if (r.refreshState) {
					if (
						r.refreshState.cooldownUntilMs !== undefined &&
						r.refreshState.cooldownUntilMs > now()
					) {
						const remainingSec = Math.ceil(
							(r.refreshState.cooldownUntilMs - now()) / 1_000,
						);
						logError(
							`refresh:   circuit-broken — sleeping for ${formatDuration(
								remainingSec,
							)} before retry. Re-pair if this persists.`,
						);
					} else {
						logOut(
							`refresh:   ${r.refreshState.recentFailures} recent failure(s); next reconnect will retry`,
						);
					}
				}
			} else {
				logOut(
					`runner:    NOT running${
						report.error ? ` (${report.error})` : ''
					}. Start it with \`drisp runner --detach\`.`,
				);
			}
			if (config.lastRefreshAt !== undefined) {
				logOut(
					`token:     last refreshed ${formatDuration(
						Math.max(0, Math.floor((now() - config.lastRefreshAt) / 1_000)),
					)} ago`,
				);
			}
		}
		return ok ? 0 : 1;
	}

	if (subcommand === 'logs') {
		if (subcommandArgs.length > 0) {
			logError(`runner logs: unexpected argument ${subcommandArgs[0]}`);
			return 2;
		}
		const tail = flags.tail ?? 20;
		const follow = flags.follow ?? false;
		try {
			const tailFn = deps.tailRunnerLog ?? defaultTailRunnerLog;
			return await tailFn({tail, follow});
		} catch (err) {
			logError(
				`runner logs: ${err instanceof Error ? err.message : String(err)}`,
			);
			return 1;
		}
	}

	if (subcommand === 'runs') {
		if (subcommandArgs.length > 0) {
			logError(`runner runs: unexpected argument ${subcommandArgs[0]}`);
			return 2;
		}
		const readStatus = deps.readRunnerStatus ?? defaultReadRunnerStatus;
		let report: RunnerStatusReport;
		try {
			report = readStatus();
		} catch (err) {
			logError(
				`runner runs: ${err instanceof Error ? err.message : String(err)}`,
			);
			return 1;
		}
		if (!report.running) {
			logError(`runner runs: ${report.error ?? 'runner not running'}`);
			return 1;
		}
		let runs = report.status.runs;
		if (typeof flags.limit === 'number' && flags.limit > 0) {
			runs = runs.slice(-flags.limit);
		}
		if (flags.active) {
			runs = runs.filter(run => run.status === 'running');
		}
		if (flags.json) {
			logOut(JSON.stringify({ok: true, runs}));
			return 0;
		}
		if (runs.length === 0) {
			logOut('runner: no runs recorded');
			return 0;
		}
		logOut(['runId', 'started', 'duration', 'status'].join('\t'));
		for (const run of runs) {
			const duration = run.endedAt
				? formatDuration(
						Math.max(0, Math.floor((run.endedAt - run.startedAt) / 1_000)),
					)
				: '—';
			logOut(
				[
					run.runId,
					formatDuration(
						Math.max(0, Math.floor((now() - run.startedAt) / 1_000)),
					) + ' ago',
					duration,
					run.status,
				].join('\t'),
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
			logError(`runner refresh: unexpected argument ${subcommandArgs[0]}`);
			return 2;
		}
		if (!readConfig()) {
			logError('runner refresh: not paired. Run "drisp runner pair" first.');
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
			logOut(`runner: refreshed access token for instance ${token.instanceId}`);
		}
		return 0;
	}

	if (subcommand === '') {
		if (subcommandArgs.length > 0) {
			logError(`runner: unexpected argument ${subcommandArgs[0]}`);
			return 2;
		}
		if (!readConfig()) {
			logError('runner: not paired. Run "drisp runner pair" first.');
			return 1;
		}
		if (flags.detach) {
			const result = await (
				deps.startDetachedRunner ?? defaultStartDetachedRunner
			)({log: msg => logOut(msg)});
			if (flags.json) {
				logOut(JSON.stringify(result));
			} else if (result.ok) {
				logOut(
					result.connected
						? 'runner: started and connected'
						: 'runner: started; socket not yet verified (tail logs)',
				);
			} else {
				logError(`runner: ${result.message ?? 'unknown failure'}`);
			}
			return result.ok ? 0 : 1;
		}
		// Foreground: the same process the detached entry runs, with log lines
		// mirrored to the terminal. It holds the pid file too, so a second
		// `drisp runner` fails here with "already running (pid N)".
		let runner;
		try {
			runner = await startRunnerProcess({
				readConfig,
				refreshAccessToken: async () => performRefreshImpl('connect'),
				...(deps.makeInstanceSocketClient
					? {makeInstanceSocketClient: deps.makeInstanceSocketClient}
					: {}),
				...(deps.executeRemoteAssignment
					? {executeRemoteAssignment: deps.executeRemoteAssignment}
					: {}),
				...(deps.fetchAttachments
					? {fetchAttachments: deps.fetchAttachments}
					: {}),
				...(deps.statePaths ? {statePaths: deps.statePaths()} : {}),
				writeMirror,
				retryInitialConnect: false,
				cliVersion: readPackageVersion(),
				log: (level, message) => {
					if (level === 'error' || level === 'warn') {
						logError(`runner: ${message}`);
					} else {
						logOut(`runner: ${message}`);
					}
				},
			});
		} catch (err) {
			logError(`runner: ${err instanceof Error ? err.message : String(err)}`);
			return err instanceof RunnerStartupError ? err.exitCode : 1;
		}
		logOut(`runner: foreground runtime connected (pid ${runner.pid})`);
		const wait = deps.waitForShutdown ?? defaultWaitForShutdown;
		const reason = await wait();
		await runner.stop(reason);
		logOut(`runner: stopped (${reason})`);
		return 0;
	}

	if (subcommand === 'stop') {
		if (subcommandArgs.length > 0) {
			logError(`runner stop: unexpected argument ${subcommandArgs[0]}`);
			return 2;
		}
		const result = await (deps.stopRunner ?? defaultStopRunner)({});
		if (flags.json) {
			logOut(JSON.stringify(result));
		} else if (!result.wasRunning) {
			logOut('runner: not running');
		} else if (result.ok) {
			logOut('runner: stopped');
		} else {
			logError(`runner stop: ${result.message ?? 'unknown failure'}`);
		}
		return result.ok ? 0 : 1;
	}

	if (subcommand === 'restart') {
		if (subcommandArgs.length > 0) {
			logError(`runner restart: unexpected argument ${subcommandArgs[0]}`);
			return 2;
		}
		const stopResult = await (deps.stopRunner ?? defaultStopRunner)({});
		if (stopResult.wasRunning && !stopResult.ok) {
			logError(
				`runner restart: stop failed: ${stopResult.message ?? 'unknown'}`,
			);
			return 1;
		}
		const startResult = await (
			deps.startDetachedRunner ?? defaultStartDetachedRunner
		)({log: msg => logOut(msg)});
		if (flags.json) {
			logOut(JSON.stringify({restart: true, ...startResult}));
		} else if (startResult.ok) {
			logOut(
				startResult.connected
					? 'runner: restarted and connected'
					: 'runner: restarted; socket not yet verified',
			);
		} else {
			logError(`runner restart: ${startResult.message ?? 'unknown'}`);
		}
		return startResult.ok ? 0 : 1;
	}

	if (subcommand === 'install') {
		if (subcommandArgs.length > 0) {
			logError(`runner install: unexpected argument ${subcommandArgs[0]}`);
			return 2;
		}
		const installer = deps.installServiceUnit ?? defaultInstallServiceUnit;
		const result = installer();
		if (flags.json) {
			logOut(JSON.stringify(result));
		} else if (result.ok) {
			logOut(`runner: wrote service unit at ${result.path}`);
			logOut(`runner: load with: ${result.loadCommand}`);
			logOut(`runner: start with: ${result.startCommand}`);
		} else {
			logError(`runner install: ${result.message ?? 'unsupported platform'}`);
		}
		return result.ok ? 0 : 1;
	}

	if (subcommand === 'doctor') {
		if (subcommandArgs.length > 0) {
			logError(`runner doctor: unexpected argument ${subcommandArgs[0]}`);
			return 2;
		}
		const config = readConfig();
		if (!config) {
			if (flags.json) {
				logOut(JSON.stringify({ok: false, paired: false}));
			} else {
				logOut('runner: not paired');
				logOut('runner doctor: run "drisp runner pair" before using doctor.');
			}
			return 1;
		}

		// Only rotate the refresh token when we actually need an access token
		// (runner check). Otherwise doctor would burn a token on every health
		// check the user runs.
		let token: DashboardAccessToken | null = null;
		if (flags.runner) {
			const refreshResult = await tryRefresh('refresh');
			if (!refreshResult.ok) return refreshResult.code;
			token = refreshResult.token;
		}
		const refreshed = readConfig();

		type RunnerReport = {
			id: string;
			executionTarget?: string;
			remoteInstanceId?: string;
			matches: boolean;
			error?: string;
		};
		let runnerReport: RunnerReport | undefined;
		let runnerOk = !flags.runner;

		if (flags.runner && token) {
			const runnerId = flags.runner;
			const accessToken = token.accessToken;
			const expectedInstanceId = token.instanceId;
			const url = new URL(
				`/api/runners/${encodeURIComponent(runnerId)}`,
				config.dashboardUrl,
			).toString();
			let response: Response;
			try {
				response = await fetchImpl(url, {
					method: 'GET',
					headers: {
						authorization: `Bearer ${accessToken}`,
						accept: 'application/json',
					},
				});
			} catch (err) {
				runnerOk = false;
				runnerReport = {
					id: runnerId,
					matches: false,
					error: `request failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				};
				return reportDoctor(false);
			}
			if (response.status === 404) {
				runnerOk = false;
				runnerReport = {
					id: runnerId,
					matches: false,
					error: 'runner not found',
				};
			} else if (response.status === 405 || response.status === 501) {
				runnerOk = false;
				runnerReport = {
					id: runnerId,
					matches: false,
					error:
						'runner check unavailable: dashboard endpoint missing (GET /api/runners/<id>)',
				};
			} else if (!response.ok) {
				runnerOk = false;
				const message = await safeReadError(response);
				runnerReport = {
					id: runnerId,
					matches: false,
					error: `dashboard returned ${response.status}${
						message ? ` — ${message}` : ''
					}`,
				};
			} else {
				let body: unknown;
				try {
					body = await response.json();
				} catch (err) {
					runnerOk = false;
					runnerReport = {
						id: runnerId,
						matches: false,
						error: `invalid response body: ${
							err instanceof Error ? err.message : String(err)
						}`,
					};
					return reportDoctor(false);
				}
				const obj = (
					typeof body === 'object' && body !== null
						? (body as Record<string, unknown>)
						: {}
				) as Record<string, unknown>;
				const executionTarget =
					typeof obj['executionTarget'] === 'string'
						? (obj['executionTarget'] as string)
						: undefined;
				const remoteInstanceId =
					typeof obj['remoteInstanceId'] === 'string'
						? (obj['remoteInstanceId'] as string)
						: undefined;
				const matchesTarget = executionTarget === 'remote';
				const matchesInstance = remoteInstanceId === expectedInstanceId;
				const matches = matchesTarget && matchesInstance;
				runnerOk = matches;
				const reasons: string[] = [];
				if (!matchesTarget) {
					reasons.push(
						`executionTarget is "${
							executionTarget ?? 'unset'
						}" (expected "remote")`,
					);
				}
				if (!matchesInstance) {
					reasons.push(
						`remoteInstanceId is "${
							remoteInstanceId ?? 'unset'
						}" (expected "${expectedInstanceId}")`,
					);
				}
				runnerReport = {
					id: runnerId,
					executionTarget,
					remoteInstanceId,
					matches,
					error: reasons.length > 0 ? reasons.join('; ') : undefined,
				};
			}
		}

		return reportDoctor(runnerOk);

		function reportDoctor(ok: boolean): number {
			if (flags.json) {
				logOut(
					JSON.stringify({
						ok,
						paired: true,
						instanceId: config!.instanceId,
						dashboardUrl: config!.dashboardUrl,
						pairedAt: config!.pairedAt,
						...(refreshed?.lastRefreshAt !== undefined
							? {lastRefreshAt: refreshed.lastRefreshAt}
							: {}),
						configPath: configPath(),
						...(runnerReport ? {runner: runnerReport} : {}),
					}),
				);
			} else {
				logOut(
					`runner: paired to ${config!.dashboardUrl} as ${config!.instanceId}`,
				);
				if (token) {
					logOut(`runner: refresh token rotated, access token minted`);
				}
				if (runnerReport) {
					if (runnerReport.matches) {
						logOut(
							`runner: runner ${runnerReport.id} bound to this instance (executionTarget=remote, remoteInstanceId=${runnerReport.remoteInstanceId})`,
						);
					} else {
						logError(
							`runner doctor: runner ${runnerReport.id} not bound — ${
								runnerReport.error ?? 'unknown reason'
							}`,
						);
					}
				}
			}
			return ok ? 0 : 1;
		}
	}

	if (subcommand === 'console') {
		const message =
			'dashboard console is deprecated; paired dashboard feed sync now routes dashboard UI and channel decisions.';
		if (flags.json) {
			logOut(JSON.stringify({ok: false, deprecated: true, message}));
		} else {
			logError(message);
		}
		return 1;
	}

	if (subcommand === 'list') {
		if (subcommandArgs.length > 0) {
			logError(`runner list: unexpected argument ${subcommandArgs[0]}`);
			return 2;
		}
		const config = readConfig();
		if (!config) {
			if (flags.json) {
				logOut(JSON.stringify({ok: false, paired: false}));
			} else {
				logError('runner list: not paired. Run "drisp runner pair" first.');
			}
			return 1;
		}
		const mirror = readMirror();
		if (!mirror) {
			if (flags.json) {
				logOut(
					JSON.stringify({
						ok: true,
						paired: true,
						instanceId: config.instanceId,
						attachments: [],
						mirror: null,
					}),
				);
			} else {
				logOut(
					`runner list: paired as ${config.instanceId}, no attachment mirror on disk.`,
				);
				logOut(
					'runner list: re-run `drisp runner pair` to refresh the mirror.',
				);
			}
			return 0;
		}
		if (flags.json) {
			logOut(
				JSON.stringify({
					ok: true,
					paired: true,
					instanceId: mirror.instanceId,
					fetchedAt: mirror.fetchedAt,
					attachments: mirror.attachments,
				}),
			);
		} else {
			logOut(`runner: instance ${mirror.instanceId}`);
			logOut(
				`runner: mirror fetched ${new Date(mirror.fetchedAt).toISOString()}`,
			);
			if (mirror.attachments.length === 0) {
				logOut('runner: no runners attached.');
			} else {
				logOut(`runner: ${mirror.attachments.length} runner(s) attached:`);
				for (const a of mirror.attachments) {
					const label = a.name ? `${a.name} (${a.runnerId})` : a.runnerId;
					const target = a.executionTarget ? ` [${a.executionTarget}]` : '';
					logOut(`  - ${label}${target}`);
				}
			}
		}
		return 0;
	}

	if (subcommand === 'unpair') {
		if (subcommandArgs.length > 0) {
			logError(`runner unpair: unexpected argument ${subcommandArgs[0]}`);
			return 2;
		}
		const config = readConfig();
		if (!config) {
			if (flags.json) {
				logOut(JSON.stringify({ok: true, paired: false}));
			} else {
				logOut('runner unpair: not paired (nothing to do)');
			}
			return 0;
		}

		// 1. Stop the runner first so it stops processing assignments before we
		//    invalidate its credentials.
		const stopResult = await (deps.stopRunner ?? defaultStopRunner)({});
		if (!flags.json) {
			if (stopResult.wasRunning) {
				if (stopResult.ok) {
					logOut('runner: stopped');
				} else {
					logError(`runner: stop failed: ${stopResult.message ?? 'unknown'}`);
				}
			} else {
				logOut('runner: not running (skipping stop)');
			}
		}

		// 2. Best-effort revoke. If the dashboard endpoint is unavailable or the
		//    network is down, surface a warning but proceed with local removal —
		//    leaving a paired-on-disk-but-unreachable config is worse UX than a
		//    server-side token that's still valid for a few minutes.
		let revokeOk = false;
		let revokeMessage: string | undefined;
		try {
			const refreshResult = await tryRefresh('refresh');
			if (refreshResult.ok) {
				const url = new URL(
					`/api/instances/${encodeURIComponent(config.instanceId)}/revoke`,
					config.dashboardUrl,
				).toString();
				const response = await fetchImpl(url, {
					method: 'POST',
					headers: {
						authorization: `Bearer ${refreshResult.token.accessToken}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify({}),
				});
				if (response.ok || response.status === 404) {
					revokeOk = true;
				} else {
					const detail = await safeReadError(response);
					revokeMessage = `dashboard returned ${response.status}${
						detail ? ` — ${detail}` : ''
					}`;
				}
			} else {
				revokeMessage = 'could not refresh access token';
			}
		} catch (err) {
			revokeMessage = err instanceof Error ? err.message : String(err);
		}

		if (!flags.json) {
			if (revokeOk) {
				logOut(`runner: revoking refresh token at ${config.dashboardUrl}`);
				logOut('runner: refresh token revoked');
			} else {
				logError(
					`runner: revoke failed${revokeMessage ? `: ${revokeMessage}` : ''}`,
				);
				logOut(
					'runner: WARNING — refresh token may still be valid until you revoke it from the dashboard UI.',
				);
			}
		}

		// 3. Remove local credentials and the attachment mirror.
		removeConfig();
		removeMirror();

		if (flags.json) {
			logOut(
				JSON.stringify({
					ok: true,
					runner: stopResult,
					revoke: {
						ok: revokeOk,
						...(revokeMessage ? {message: revokeMessage} : {}),
					},
				}),
			);
		} else {
			logOut(
				`runner: unpaired (credentials removed${
					stopResult.wasRunning ? ', runner stopped' : ''
				})`,
			);
		}
		return 0;
	}

	logError(`Unknown runner subcommand: ${subcommand}`);
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

function resolveRunnerEntry(): string | null {
	// `import.meta.url` resolves to the bundled chunk under `dist/`. The
	// runner entry is bundled as a sibling `runner.js`. Walking up to the
	// chunk's directory is robust whether the chunk lives at `dist/cli.js` or
	// at a hashed split chunk like `dist/chunk-X.js`.
	let here: string;
	try {
		here = fileURLToPath(import.meta.url);
	} catch {
		return null;
	}
	const candidates = [
		path.join(path.dirname(here), 'runner.js'),
		// When invoked via `npm run start`, `here` may be the unbundled source
		// path. Walk up until we hit a `dist/` sibling.
		path.join(path.dirname(here), '..', '..', '..', 'dist', 'runner.js'),
	];
	for (const candidate of candidates) {
		try {
			fs.accessSync(candidate, fs.constants.R_OK);
			return candidate;
		} catch {
			// next candidate
		}
	}
	return null;
}

// NODE_OPTIONS is intentionally excluded — it can carry --require/--inspect
// which would let a parent shell inject arbitrary code into the runner. The
// runner should boot from a clean environment.
const RUNNER_ENV_ALLOWLIST = [
	'HOME',
	'PATH',
	'LANG',
	'LC_ALL',
	'ATHENA_DASHBOARD_ORIGIN',
];

function buildRunnerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const key of RUNNER_ENV_ALLOWLIST) {
		if (env[key] !== undefined) out[key] = env[key];
	}
	for (const [key, value] of Object.entries(env)) {
		if (key.startsWith('XDG_') && value !== undefined) {
			out[key] = value;
		}
	}
	return out;
}

/**
 * The live runner, if any: `runner.pid`, or for one release the pre-runner
 * `dashboard-daemon.pid` a daemon left running across the upgrade.
 */
function readRunnerPid(
	paths: RunnerStatePaths,
): PidLockReadResult & {pidPath: string} {
	const current = readPidLock(paths.pidPath);
	if (current.state === 'held') return {...current, pidPath: paths.pidPath};
	const legacy = readPidLock(paths.legacyPidPath);
	if (legacy.state === 'held') return {...legacy, pidPath: paths.legacyPidPath};
	return {...current, pidPath: paths.pidPath};
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

const SOCKET_PROBE_TIMEOUT_MS = 10_000;
const SOCKET_PROBE_INTERVAL_MS = 200;

async function defaultStartDetachedRunner(opts: {
	log: (msg: string) => void;
}): Promise<RunnerStartResult> {
	const paths = runnerStatePaths();

	const existing = readRunnerPid(paths);
	if (existing.state === 'held') {
		return {
			ok: false,
			pid: existing.pid,
			message: alreadyRunningMessage(existing.pid, existing.pidPath),
		};
	}

	const entry = resolveRunnerEntry();
	if (!entry) {
		return {ok: false, message: 'cannot resolve runner.js entry path'};
	}

	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(process.execPath, [entry], {
			detached: true,
			stdio: 'ignore',
			env: buildRunnerEnv(process.env),
		});
	} catch (err) {
		return {
			ok: false,
			message: err instanceof Error ? err.message : String(err),
		};
	}
	child.unref();

	// Track child lifecycle so we can fail fast when the runner dies before
	// the probe deadline rather than waiting the full 10s. Without this the
	// user sees a generic "socket not verified within 10s" for any startup
	// crash (binary mismatch, missing module, lock contention, …).
	let earlyExit: string | undefined;
	let spawnError: string | undefined;
	const onError = (err: Error): void => {
		spawnError = err.message;
	};
	const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
		earlyExit = `runner exited early (code=${code ?? 'null'}, signal=${
			signal ?? 'null'
		})`;
	};
	child.once('error', onError);
	child.once('exit', onExit);

	// Verify-then-return: poll the pid file and the status file until the
	// runner reports its socket connected, max 10s. Pairing succeeded on disk
	// regardless — this is purely about reporting an honest "connected".
	const probeDeadline = Date.now() + SOCKET_PROBE_TIMEOUT_MS;
	let connected = false;
	let everReached = false;
	let pid: number | undefined;
	while (Date.now() < probeDeadline) {
		if (spawnError) break;
		if (earlyExit) break;
		const report = defaultReadRunnerStatus();
		if (report.running) {
			everReached = true;
			pid = report.status.pid;
			if (report.status.socketConnected) {
				connected = true;
				break;
			}
		}
		await new Promise(r => setTimeout(r, SOCKET_PROBE_INTERVAL_MS));
	}

	child.off('error', onError);
	child.off('exit', onExit);

	// "ok" iff we have evidence the runner is alive: either the socket is fully
	// connected, or it wrote its status file at least once. If the child
	// crashed early or never reported, that is a real start failure.
	if (spawnError) {
		return {ok: false, message: `runner failed to start: ${spawnError}`};
	}
	if (earlyExit && !connected) {
		return {ok: false, message: earlyExit};
	}
	if (!connected && !everReached) {
		return {
			ok: false,
			message: `runner did not report status within ${SOCKET_PROBE_TIMEOUT_MS}ms (see ${paths.logPath})`,
		};
	}

	opts.log(
		connected
			? `runner: socket verified${pid !== undefined ? ` (pid ${pid})` : ''}`
			: 'runner: started but socket not yet connected',
	);

	return {
		ok: true,
		connected,
		...(pid !== undefined ? {pid} : {}),
		message: connected
			? 'started, socket verified'
			: 'started, socket not yet verified',
	};
}

async function defaultStopRunner(
	opts: {timeoutMs?: number} = {},
): Promise<RunnerStopResult> {
	const paths = runnerStatePaths();
	const existing = readRunnerPid(paths);
	if (existing.state !== 'held') {
		return {ok: true, wasRunning: false, message: 'runner not running'};
	}
	try {
		process.kill(existing.pid, 'SIGTERM');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
			return {ok: true, wasRunning: false, message: 'runner not running'};
		}
		return {
			ok: false,
			wasRunning: true,
			message: err instanceof Error ? err.message : String(err),
		};
	}
	// Wait for the pid file to be released so callers know the previous
	// runner is fully gone before they restart.
	const deadline = Date.now() + (opts.timeoutMs ?? 5_000);
	while (Date.now() < deadline) {
		const after = readPidLock(existing.pidPath);
		if (after.state !== 'held' || after.pid !== existing.pid) {
			return {ok: true, wasRunning: true};
		}
		await new Promise(r => setTimeout(r, 100));
	}
	return {ok: false, wasRunning: true, message: 'runner did not exit in time'};
}

function defaultReadRunnerStatus(): RunnerStatusReport {
	const paths = runnerStatePaths();
	const existing = readRunnerPid(paths);
	if (existing.state !== 'held') {
		return {running: false, error: 'runner not running'};
	}
	const status = readRunnerStatusFile(paths.statusPath);
	if (!status || status.pid !== existing.pid || !isProcessAlive(status.pid)) {
		return {
			running: false,
			error: `runner pid ${existing.pid} is alive but has not written ${paths.statusPath} yet`,
		};
	}
	return {running: true, status};
}

async function defaultTailRunnerLog(opts: {
	tail: number;
	follow: boolean;
}): Promise<number> {
	const paths = runnerStatePaths();
	let stream: fs.ReadStream | null = null;
	let watcher: fs.FSWatcher | null = null;
	try {
		const stat = fs.statSync(paths.logPath);
		const size = stat.size;
		const buf = Buffer.alloc(Math.min(size, opts.tail * 1024));
		const fd = fs.openSync(paths.logPath, 'r');
		try {
			fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
		} finally {
			fs.closeSync(fd);
		}
		const lines = buf
			.toString('utf-8')
			.split('\n')
			.filter(l => l.length > 0);
		const tail = lines.slice(-opts.tail);
		for (const line of tail) {
			process.stdout.write(line + '\n');
		}
		if (!opts.follow) return 0;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			process.stderr.write(
				`runner logs: log file ${paths.logPath} does not exist yet\n`,
			);
			return opts.follow ? 0 : 1;
		}
		throw err;
	}

	let position = fs.statSync(paths.logPath).size;
	return await new Promise<number>(resolve => {
		let pollTimer: NodeJS.Timeout | null = null;
		const drain = (): void => {
			try {
				const stat = fs.statSync(paths.logPath);
				if (stat.size < position) {
					// rotated — start from the new file's beginning
					position = 0;
				}
				if (stat.size > position) {
					const fd = fs.openSync(paths.logPath, 'r');
					const buf = Buffer.alloc(stat.size - position);
					try {
						fs.readSync(fd, buf, 0, buf.length, position);
					} finally {
						fs.closeSync(fd);
					}
					position = stat.size;
					process.stdout.write(buf);
				}
			} catch (err) {
				// ENOENT during rotation is expected; surface anything else.
				if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
					process.stderr.write(
						`runner logs: tail error: ${
							err instanceof Error ? err.message : String(err)
						}\n`,
					);
				}
			}
		};
		try {
			watcher = fs.watch(paths.logPath, {persistent: true}, () => {
				drain();
			});
		} catch {
			// fs.watch may fail on certain filesystems; fall back to polling
			pollTimer = setInterval(drain, 500);
			pollTimer.unref();
		}
		const onSignal = (): void => {
			if (watcher) {
				watcher.close();
				watcher = null;
			}
			if (pollTimer) {
				clearInterval(pollTimer);
				pollTimer = null;
			}
			if (stream) {
				stream.close();
				stream = null;
			}
			resolve(0);
		};
		process.once('SIGINT', onSignal);
		process.once('SIGTERM', onSignal);
	});
}

function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return '?';
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3_600) {
		const m = Math.floor(seconds / 60);
		const s = seconds % 60;
		return s > 0 ? `${m}m${s}s` : `${m}m`;
	}
	if (seconds < 86_400) {
		const h = Math.floor(seconds / 3_600);
		const m = Math.floor((seconds % 3_600) / 60);
		return m > 0 ? `${h}h${m}m` : `${h}h`;
	}
	const d = Math.floor(seconds / 86_400);
	const h = Math.floor((seconds % 86_400) / 3_600);
	return h > 0 ? `${d}d${h}h` : `${d}d`;
}

type FetchedRunnerHealth = {
	id: string;
	matches: boolean;
	executionTarget?: string;
	remoteInstanceId?: string;
	error?: string;
};

async function fetchRunnerHealth(
	fetchImpl: typeof fetch,
	dashboardUrl: string,
	runnerId: string,
	token: DashboardAccessToken,
): Promise<FetchedRunnerHealth> {
	const url = new URL(
		`/api/runners/${encodeURIComponent(runnerId)}`,
		dashboardUrl,
	).toString();
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: 'GET',
			headers: {
				authorization: `Bearer ${token.accessToken}`,
				accept: 'application/json',
			},
		});
	} catch (err) {
		return {
			id: runnerId,
			matches: false,
			error: `request failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		};
	}
	if (!response.ok) {
		return {
			id: runnerId,
			matches: false,
			error: `dashboard returned ${response.status}`,
		};
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch (err) {
		return {
			id: runnerId,
			matches: false,
			error: `invalid response body: ${
				err instanceof Error ? err.message : String(err)
			}`,
		};
	}
	const obj =
		typeof body === 'object' && body !== null
			? (body as Record<string, unknown>)
			: {};
	const executionTarget =
		typeof obj['executionTarget'] === 'string'
			? (obj['executionTarget'] as string)
			: undefined;
	const remoteInstanceId =
		typeof obj['remoteInstanceId'] === 'string'
			? (obj['remoteInstanceId'] as string)
			: undefined;
	const matches =
		executionTarget === 'remote' && remoteInstanceId === token.instanceId;
	const reasons: string[] = [];
	if (executionTarget !== 'remote') {
		reasons.push(
			`executionTarget=${executionTarget ?? 'unset'} (expected "remote")`,
		);
	}
	if (remoteInstanceId !== token.instanceId) {
		reasons.push(
			`remoteInstanceId=${remoteInstanceId ?? 'unset'} (expected "${token.instanceId}")`,
		);
	}
	return {
		id: runnerId,
		matches,
		...(executionTarget !== undefined ? {executionTarget} : {}),
		...(remoteInstanceId !== undefined ? {remoteInstanceId} : {}),
		...(reasons.length > 0 ? {error: reasons.join('; ')} : {}),
	};
}

function defaultInstallServiceUnit(): ServiceInstallResult {
	const entry = resolveRunnerEntry();
	if (!entry) {
		return {
			ok: false,
			platform: 'unsupported',
			message: 'cannot resolve runner.js entry path',
		};
	}
	return installServiceUnit({
		runnerEntry: entry,
		nodeBinary: process.execPath,
	});
}

function compareSemver(a: string, b: string): number {
	const parseN = (s: string): [number, number, number] => {
		const parts = s.replace(/^v/, '').split('-')[0]!.split('.');
		return [
			Number.parseInt(parts[0] ?? '0', 10) || 0,
			Number.parseInt(parts[1] ?? '0', 10) || 0,
			Number.parseInt(parts[2] ?? '0', 10) || 0,
		];
	};
	const av = parseN(a);
	const bv = parseN(b);
	for (let i = 0; i < 3; i += 1) {
		if (av[i]! < bv[i]!) return -1;
		if (av[i]! > bv[i]!) return 1;
	}
	return 0;
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
		...(typeof obj['jti'] === 'string' ? {jti: obj['jti'] as string} : {}),
		...(typeof obj['accessToken'] === 'string'
			? {accessToken: obj['accessToken'] as string}
			: {}),
		...(typeof obj['expiresInSec'] === 'number'
			? {expiresInSec: obj['expiresInSec'] as number}
			: {}),
		...(Array.isArray(obj['runners'])
			? {
					runners: obj['runners']
						.map(parsePairedRunner)
						.filter((runner): runner is PairedRunner => runner !== null),
				}
			: {}),
		...(typeof obj['requiredCliVersion'] === 'string'
			? {requiredCliVersion: obj['requiredCliVersion'] as string}
			: {}),
		...(typeof obj['capabilityAck'] === 'object' &&
		obj['capabilityAck'] !== null
			? {capabilityAck: parseCapabilityAck(obj['capabilityAck'])}
			: {}),
	};
}

function parseCapabilityAck(raw: unknown): CapabilityAck {
	if (typeof raw !== 'object' || raw === null) return {};
	const obj = raw as Record<string, unknown>;
	const ack: CapabilityAck = {};
	if (typeof obj['runtimeDaemon'] === 'boolean') {
		ack.runtimeDaemon = obj['runtimeDaemon'] as boolean;
	}
	if (typeof obj['instanceSocket'] === 'boolean') {
		ack.instanceSocket = obj['instanceSocket'] as boolean;
	}
	return ack;
}

function parsePairedRunner(raw: unknown): PairedRunner | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const obj = raw as Record<string, unknown>;
	const runnerId = obj['runnerId'];
	if (typeof runnerId !== 'string' || runnerId.length === 0) return null;
	return {
		runnerId,
		...(typeof obj['name'] === 'string' ? {name: obj['name'] as string} : {}),
		...(typeof obj['executionTarget'] === 'string'
			? {executionTarget: obj['executionTarget'] as string}
			: {}),
		...(typeof obj['remoteInstanceId'] === 'string'
			? {remoteInstanceId: obj['remoteInstanceId'] as string}
			: {}),
	};
}
