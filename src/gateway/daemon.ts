/**
 * GatewayDaemon — long-running process that owns channel adapters, brokers
 * cloud function invocations, and dispatches inbound chats to a registered
 * Athena interactive runtime over a UDS NDJSON control plane.
 *
 * M3 wired lock acquisition, token loading, and the control-plane server.
 * M5 adds the channel manager + session registry + dispatcher and routes
 * push frames to whichever connection has the registered runtime. Channel
 * registration from config and the cloud function invoker land in M6+.
 */

import fs from 'node:fs';
import {loadOrCreateToken} from './auth';
import {ChannelManager} from './channelManager';
import {ChannelSidecarReconciler} from './channelSidecarReconciler';
import {createDispatcher} from './control/handlers';
import {startControlServer, type ControlServer} from './control/server';
import {DispatchPipeline} from './dispatchPipeline';
import {planListener} from './listenerPlan';
import {acquireLock, type LockHandle} from './lock';
import {
	isLoopbackHost,
	resolveGatewayPaths,
	resolveListenSpec,
	type GatewayListenSpec,
	type GatewayPaths,
} from './paths';
import {RelayCoordinator} from './relay/coordinator';
import {openGatewayState, type GatewayStateDb} from './state/db';
import {createUdsServerTransport} from './transport/uds';
import type {ListenerDescription, ServerTransport} from './transport/types';
import {createWsServerTransport} from './transport/ws';
import {
	trackGatewayRuntimeExpired,
	trackGatewayRuntimeRebind,
	trackGatewayTransportConnect,
	trackGatewayTransportDisconnect,
} from '../infra/telemetry/events';
import type {
	ChannelReloadResult,
	ListenerStatusEntry,
} from '../shared/gateway-protocol';

/**
 * Map a transport-owned {@link ListenerDescription} up to the protocol
 * `ListenerStatusEntry`, adding the policy fields (`insecure`, `loopback`) the
 * transport does not own. The transport reports where it is reachable
 * (host/port/url/tls); the daemon owns how that bind was authorized.
 */
function describeToStatus(
	desc: ListenerDescription,
	spec: GatewayListenSpec,
): ListenerStatusEntry {
	if (desc.kind === 'uds') {
		return {kind: 'uds', socketPath: desc.socketPath};
	}
	return {
		kind: 'tcp',
		host: desc.host,
		port: desc.port,
		url: desc.url,
		tls: desc.tls,
		insecure: spec.kind === 'tcp' ? spec.insecure : false,
		loopback: isLoopbackHost(desc.host),
	};
}

export type DaemonOptions = {
	/** When true the daemon stays in foreground (no detach). */
	foreground: boolean;
	silent?: boolean;
	paths?: GatewayPaths;
	env?: NodeJS.ProcessEnv;
	skipSignalHandlers?: boolean;
	/**
	 * When true, skip loading `~/.config/athena/channels/*.json` sidecars on
	 * startup. Tests use this to keep the daemon adapter-free.
	 */
	skipChannelLoad?: boolean;
	/**
	 * Keep a runtime registration alive after its transport disconnects. Local
	 * UDS mode uses the historical immediate cleanup default; remote mode will
	 * set this to 60s when non-loopback listener support lands.
	 */
	disconnectGracePeriodMs?: number;
	listenSpec?: GatewayListenSpec;
};

export type DaemonHandle = {
	startedAt: number;
	pid: number;
	paths: GatewayPaths;
	pipeline: DispatchPipeline;
	channelManager: ChannelManager;
	relayCoordinator: RelayCoordinator;
	listener: {
		kind: GatewayListenSpec['kind'];
		socketPath?: string;
		url?: string;
		host?: string;
		port?: number;
	};
	stop: () => Promise<void>;
};

export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
	const startedAt = Date.now();
	const pid = process.pid;
	const paths = opts.paths ?? resolveGatewayPaths(opts.env);

	fs.mkdirSync(paths.runDir, {recursive: true, mode: 0o700});
	fs.mkdirSync(paths.configDir, {recursive: true, mode: 0o700});
	if (process.platform !== 'win32') {
		try {
			fs.chmodSync(paths.runDir, 0o700);
			fs.chmodSync(paths.configDir, 0o700);
		} catch {
			// best-effort
		}
	}

	const lock: LockHandle = acquireLock(paths.lockPath);
	const token = loadOrCreateToken(paths.tokenPath);
	const listenSpec = opts.listenSpec ?? resolveListenSpec({paths});
	const listenerPlan = planListener(listenSpec, token);

	const listenerHints = {
		transport: (listenSpec.kind === 'tcp' ? 'ws' : 'uds') as 'ws' | 'uds',
		tls: listenSpec.kind === 'tcp' && Boolean(listenSpec.tls),
		loopback: listenSpec.kind === 'uds' || isLoopbackHost(listenSpec.host),
	};

	const stateDb: GatewayStateDb = openGatewayState(paths.statePath);

	const channelManager = new ChannelManager();
	const relayCoordinator = new RelayCoordinator({
		adapters: () => channelManager.listAdapters(),
	});

	const connectionOpenedAt = new Map<string, number>();
	const disconnectGracePeriodMs = opts.disconnectGracePeriodMs ?? 0;
	let listenerStatus: ListenerStatusEntry | null = null;
	const log = (
		level: 'debug' | 'info' | 'warn' | 'error',
		message: string,
	): void => {
		if (opts.silent) return;
		const stream = level === 'error' || level === 'warn' ? 'stderr' : 'stdout';
		process[stream].write(`athena-gateway: [${level}] ${message}\n`);
	};

	const pipeline = new DispatchPipeline({
		stateDb,
		send: (channelId, msg) => channelManager.send(channelId, msg),
		gracePeriodMs: disconnectGracePeriodMs,
		log,
		observers: {
			onRuntimeRebind: ({gapMs, epoch}) =>
				trackGatewayRuntimeRebind({gapMs, epoch}),
			onRuntimeExpired: ({gapMs}) => trackGatewayRuntimeExpired({gapMs}),
			// Single-runtime v1: blanket dispose is safe. Multi-runtime must
			// scope to the disconnecting runtime via disposeAllForRuntime.
			onRuntimeConnectionLost: () =>
				relayCoordinator.disposeAll('connection_lost'),
		},
	});
	pipeline.start();

	channelManager.setInboundSink((inbound, ctx) => {
		pipeline.handleInbound(inbound, ctx);
	});

	const channelSidecarReconciler = new ChannelSidecarReconciler({
		channelManager,
		home: opts.env?.HOME,
	});
	const reloadChannels = async (): Promise<{
		results: ChannelReloadResult[];
	}> =>
		channelSidecarReconciler.reconcile({
			unregisterStale: true,
			logRegistrations: !opts.silent,
		});

	if (!opts.skipChannelLoad) {
		await channelSidecarReconciler.reconcile({
			unregisterStale: false,
			logFailures: true,
			logRegistrations: !opts.silent,
		});
	}

	let transport: ServerTransport;
	const handler = createDispatcher({
		startedAt,
		pipeline,
		channelManager,
		relayCoordinator,
		getListener: () =>
			listenerStatus ?? describeToStatus(transport.describe(), listenSpec),
		reloadChannels,
	});

	let server: ControlServer;
	let listener: DaemonHandle['listener'];
	try {
		const tcpPlan =
			listenerPlan.transport.kind === 'tcp' ? listenerPlan.transport : null;
		transport = tcpPlan
			? createWsServerTransport({
					host: tcpPlan.host,
					port: tcpPlan.port,
					allowNonLoopback: tcpPlan.allowNonLoopback,
					...(tcpPlan.tls ? {tls: tcpPlan.tls} : {}),
				})
			: createUdsServerTransport({socketPath: paths.socketPath});
		server = await startControlServer({
			socketPath: paths.socketPath,
			token,
			startedAt,
			handler,
			transport,
			onConnect: ctx => {
				connectionOpenedAt.set(ctx.connectionId, Date.now());
				trackGatewayTransportConnect({
					transport: listenerHints.transport,
					tls: listenerHints.tls,
					loopback: listenerHints.loopback,
				});
			},
			onDisconnect: ctx => {
				const openedAt = connectionOpenedAt.get(ctx.connectionId);
				connectionOpenedAt.delete(ctx.connectionId);
				const durationMs = openedAt !== undefined ? Date.now() - openedAt : 0;
				trackGatewayTransportDisconnect({
					transport: listenerHints.transport,
					reason: 'closed',
					durationMs,
				});
				pipeline.notifyConnectionClosed(ctx.connectionId);
			},
		});
		const description = transport.describe();
		listenerStatus = describeToStatus(description, listenSpec);
		listener =
			description.kind === 'uds'
				? {kind: 'uds', socketPath: description.socketPath}
				: {
						kind: 'tcp',
						host: description.host,
						port: description.port,
						url: description.url,
					};
	} catch (err) {
		lock.release();
		throw err;
	}

	if (!opts.silent) {
		const target =
			listener.kind === 'tcp' ? listener.url : `socket=${paths.socketPath}`;
		process.stdout.write(`athena-gateway: ok pid=${pid} ${target}\n`);
	}
	for (const warning of listenerPlan.warnings) {
		process.stderr.write(warning + '\n');
	}

	let stopping = false;
	const stop = async (): Promise<void> => {
		if (stopping) return;
		stopping = true;
		try {
			await pipeline.stop();
			relayCoordinator.disposeAll('auto_resolved');
			await channelManager.stop();
			await server.close();
		} finally {
			try {
				stateDb.close();
			} catch {
				// best-effort
			}
			lock.release();
		}
	};

	if (!opts.skipSignalHandlers) {
		const onSignal = (signal: NodeJS.Signals) => {
			process.stderr.write(`athena-gateway: received ${signal}, stopping\n`);
			void stop().then(() => process.exit(0));
		};
		process.once('SIGINT', onSignal);
		process.once('SIGTERM', onSignal);
	}

	return {
		startedAt,
		pid,
		paths,
		pipeline,
		channelManager,
		relayCoordinator,
		listener,
		stop,
	};
}
