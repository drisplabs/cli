import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import {WebSocketServer, type WebSocket as ServerWebSocket} from 'ws';
import {
	runDashboardRuntimeDaemon,
	type RuntimeDaemonHandle,
} from './runtimeDaemon';
import type {InstanceSocketFrame} from './instanceSocketClient';
import type {PairedFeedPublisher} from './pairedFeedPublisher';
import type {DashboardDecisionInbox} from './dashboardDecisionInbox';
import type {
	HarnessVerificationCheck,
	HarnessVerificationResult,
} from '../../harnesses/types';

/**
 * Live-transport integration harness for the dashboard-daemon
 * reconnect/reconcile path.
 *
 * Unlike the unit tests (which inject the `makeInstanceSocketClient` /
 * `fetchAttachments` seams), this harness leaves the transport REAL: it stands
 * up a local `http` server plus a real `ws` `WebSocketServer` on a loopback
 * port and boots the production `runDashboardRuntimeDaemon` so the daemon
 * exercises the real `createInstanceSocketClient` (real `ws`, access token as
 * subprotocol) and the default `fetchDashboardAttachments` (real `fetch` →
 * real 503). Only the non-transport seams the daemon needs to run offline are
 * stubbed: `readConfig`, `refreshAccessToken`, `executeRemoteAssignment`,
 * `reconnectDelaysMs`, and the disk-writing seams (`writeMirror`,
 * `pairedFeedPublisher`, `decisionInbox`) so the run leaves no working-tree or
 * state-dir pollution.
 *
 * Scenarios verified, each reported as a check:
 *   1. Graceful degradation when the attachment reconcile returns 503.
 *   2. An assignment is admitted and `assignment_accepted` is observed back
 *      over the real socket.
 *   3. The daemon reconnects after the server drops the socket.
 *
 * See `liveTransportHarness.README.md` for invocation and expected output.
 */

const INSTANCE_ID = 'inst_live_harness';
const ACCESS_TOKEN = 'live-harness-access-token';
const ASSIGNMENT_RUN_ID = 'run_live_harness_1';
const DEFAULT_STEP_TIMEOUT_MS = 5_000;

export type RunLiveTransportHarnessOptions = {
	/** Per-step wait timeout in milliseconds. Defaults to 5000ms. */
	stepTimeoutMs?: number;
};

async function waitFor(
	predicate: () => boolean,
	label: string,
	timeoutMs: number,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}

function pass(label: string, message: string): HarnessVerificationCheck {
	return {label, status: 'pass', message};
}

function fail(label: string, message: string): HarnessVerificationCheck {
	return {label, status: 'fail', message};
}

export async function runLiveTransportHarness(
	options: RunLiveTransportHarnessOptions = {},
): Promise<HarnessVerificationResult> {
	const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
	const checks: HarnessVerificationCheck[] = [];

	// Observable server-side state, mutated by the http + ws handlers below.
	let attachmentFetches = 0;
	let socketConnections = 0;
	// Held in an object so the closure reassignment below is not flattened to
	// `null` by control-flow narrowing at the read sites.
	const serverState: {socket: ServerWebSocket | null} = {socket: null};
	const acceptedRunIds: string[] = [];
	const handshakeSubprotocols: string[] = [];

	// Hermetic workspace for the admitted assignment. Pointing the assignment's
	// `runSpec.projectDir` here keeps `resolveRemoteWorkspace` off the daemon
	// state dir, so the run writes nothing outside this temp dir.
	const tempWorkspace = fs.mkdtempSync(
		path.join(os.tmpdir(), 'athena-live-transport-harness-'),
	);

	const httpServer = http.createServer((req, res) => {
		if (req.url && /^\/api\/instances\/[^/]+\/attachments$/.test(req.url)) {
			attachmentFetches += 1;
			res.writeHead(503, {'content-type': 'application/json'});
			res.end(JSON.stringify({error: 'service unavailable (harness)'}));
			return;
		}
		res.writeHead(404);
		res.end();
	});

	const wss = new WebSocketServer({server: httpServer});
	wss.on('connection', (socket, req) => {
		socketConnections += 1;
		serverState.socket = socket;
		const protocol = req.headers['sec-websocket-protocol'];
		if (typeof protocol === 'string') handshakeSubprotocols.push(protocol);
		socket.on('message', data => {
			let frame: InstanceSocketFrame;
			try {
				frame = JSON.parse(data.toString()) as InstanceSocketFrame;
			} catch {
				return;
			}
			if (frame.type === 'assignment_accepted') {
				acceptedRunIds.push(frame.runId);
			}
		});
	});

	let daemon: RuntimeDaemonHandle | null = null;

	// Disk-writing seams stubbed so the harness never touches the dashboard
	// state dir. These are not transport seams, so stubbing them does not
	// weaken the live-transport coverage.
	const pairedFeedPublisher: PairedFeedPublisher = {
		publish: () => {},
		attachTransport: () => {},
		detachTransport: () => {},
		handleAck: () => {},
		close: () => {},
	};
	const decisionInbox: DashboardDecisionInbox = {
		enqueue: () => {},
		pendingForSession: () => [],
		markConsumed: () => {},
		close: () => {},
	};

	try {
		await new Promise<void>((resolve, reject) => {
			httpServer.once('error', reject);
			httpServer.listen(0, '127.0.0.1', () => resolve());
		});
		const {port} = httpServer.address() as AddressInfo;
		const dashboardUrl = `http://127.0.0.1:${port}`;

		daemon = await runDashboardRuntimeDaemon({
			readConfig: () => ({
				dashboardUrl,
				instanceId: INSTANCE_ID,
				refreshToken: 'live-harness-refresh-token',
				fingerprint: 'live-harness-fingerprint',
				pairedAt: Date.now(),
			}),
			refreshAccessToken: async () => ({
				accessToken: ACCESS_TOKEN,
				instanceId: INSTANCE_ID,
				expiresInSec: 900,
			}),
			executeRemoteAssignment: async () => {},
			reconnectDelaysMs: [10],
			projectDir: tempWorkspace,
			writeMirror: () => {},
			pairedFeedPublisher,
			decisionInbox,
		});

		// Scenario 1: the daemon connected the real socket, the attachment
		// reconcile hit the real 503, and the daemon degraded to push-only
		// instead of tearing the control channel down.
		await waitFor(
			() => socketConnections >= 1,
			'initial socket connection',
			stepTimeoutMs,
		);
		await waitFor(
			() => attachmentFetches >= 1,
			'attachment reconcile fetch (503)',
			stepTimeoutMs,
		);
		const degradedConnected = daemon.snapshot().socketConnected;
		const tokenCarried = handshakeSubprotocols.includes(ACCESS_TOKEN);
		checks.push(
			degradedConnected
				? pass(
						'Graceful degradation on 503 reconcile',
						`Real socket connected (access token ${
							tokenCarried ? 'carried via subprotocol' : 'handshake completed'
						}); attachment reconcile returned 503 and the daemon stayed connected in push-only mode.`,
					)
				: fail(
						'Graceful degradation on 503 reconcile',
						'Daemon dropped the socket after the 503 reconcile instead of degrading to push-only.',
					),
		);

		// Scenario 2: send a real job_assignment over the wire and observe the
		// daemon emit `assignment_accepted` back.
		serverState.socket?.send(
			JSON.stringify({
				type: 'job_assignment',
				runId: ASSIGNMENT_RUN_ID,
				runSpec: {
					prompt: 'live-transport harness probe',
					projectDir: tempWorkspace,
				},
			} satisfies InstanceSocketFrame),
		);
		try {
			await waitFor(
				() => acceptedRunIds.includes(ASSIGNMENT_RUN_ID),
				'assignment_accepted frame over the wire',
				stepTimeoutMs,
			);
			checks.push(
				pass(
					'Assignment admitted over the wire',
					`Daemon admitted ${ASSIGNMENT_RUN_ID} and sent assignment_accepted back over the real socket.`,
				),
			);
		} catch (err) {
			checks.push(
				fail(
					'Assignment admitted over the wire',
					err instanceof Error ? err.message : String(err),
				),
			);
		}

		// Scenario 3: drop the socket from the server and confirm the daemon
		// reconnects through the real reconnect loop.
		const connectionsBeforeClose = socketConnections;
		serverState.socket?.close();
		try {
			await waitFor(
				() => socketConnections > connectionsBeforeClose,
				'socket reconnection after close',
				stepTimeoutMs,
			);
			await waitFor(
				() => daemon!.snapshot().socketConnected,
				'daemon to report reconnected',
				stepTimeoutMs,
			);
			checks.push(
				pass(
					'Reconnect after close',
					`Daemon re-established the real socket (connection #${socketConnections}) after the server dropped it.`,
				),
			);
		} catch (err) {
			checks.push(
				fail(
					'Reconnect after close',
					err instanceof Error ? err.message : String(err),
				),
			);
		}
	} catch (err) {
		checks.push(
			fail(
				'Harness execution',
				`Unexpected failure: ${err instanceof Error ? err.message : String(err)}`,
			),
		);
	} finally {
		// Teardown runs even on failure: stop the daemon, close both servers,
		// and remove the temp workspace so no ports, timers, or disk leak.
		if (daemon) {
			try {
				await daemon.stop('harness teardown');
			} catch {
				// best-effort; teardown must continue
			}
		}
		await new Promise<void>(resolve => {
			wss.close(() => resolve());
		});
		await new Promise<void>(resolve => {
			httpServer.close(() => resolve());
		});
		try {
			fs.rmSync(tempWorkspace, {recursive: true, force: true});
		} catch {
			// best-effort cleanup
		}
	}

	const hasFailure = checks.some(check => check.status === 'fail');
	return {
		ok: !hasFailure,
		summary: hasFailure
			? 'Dashboard-daemon live-transport harness FAILED'
			: 'Dashboard-daemon live-transport harness passed all scenarios',
		checks,
	};
}
