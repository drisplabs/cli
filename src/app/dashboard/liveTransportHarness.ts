import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import type {AddressInfo} from 'node:net';
import {WebSocketServer, type WebSocket as ServerWebSocket} from 'ws';
import {
	FrameSchema,
	PROTOCOL_VERSION,
	hello,
	normalizeFrame,
	toLegacyFrame,
	type CanonicalFrame,
} from '@drisp/protocol';
import {
	runDashboardRuntimeDaemon,
	type RuntimeDaemonHandle,
} from './runtimeDaemon';
import type {PairedFeedPublisher} from './pairedFeedPublisher';
import type {DashboardDecisionInbox} from './dashboardDecisionInbox';
import type {
	HarnessVerificationCheck,
	HarnessVerificationResult,
} from '../../harnesses/types';

/**
 * Live-transport integration harness for the dashboard daemon: a fake hub
 * built from the `@drisp/protocol` schemas, driven over a REAL transport.
 *
 * Unlike the unit tests (which inject the `makeInstanceSocketClient` /
 * `fetchAttachments` seams), this harness leaves the transport REAL: it stands
 * up a local `http` server plus a real `ws` `WebSocketServer` on a loopback
 * port and boots the production `runDashboardRuntimeDaemon` so the daemon
 * exercises the real `createInstanceSocketClient` (real `ws`, access token as
 * subprotocol, `hello` handshake, frame normalisation) and the default
 * `fetchDashboardAttachments` (real `fetch` → real 503). Only the
 * non-transport seams the daemon needs to run offline are stubbed:
 * `readConfig`, `refreshAccessToken`, `executeRemoteAssignment`,
 * `reconnectDelaysMs`, and the disk-writing seams (`writeMirror`,
 * `pairedFeedPublisher`, `decisionInbox`) so the run leaves no working-tree or
 * state-dir pollution.
 *
 * The fake hub speaks one of two frame-name sets (`hubProtocol`):
 *
 *   - `legacy`    — the hub that exists today: it never sends `hello`, sends
 *                   `job_assignment` / `cancel`, and expects the old names
 *                   (`run_event`, `feed_event`) back.
 *   - `canonical` — a migrated hub: it announces `PROTOCOL_VERSION` in a
 *                   `hello`, sends `run.start` / `stop`, and expects the new
 *                   names (`event` with `stream`) back.
 *
 * Every frame the runner puts on the wire is validated against the package
 * schema and checked to be in the name set the hub expects; a frame under the
 * wrong name set is a violation reported by the last check.
 *
 * See `liveTransportHarness.README.md` for invocation and expected output.
 */

const INSTANCE_ID = 'inst_live_harness';
const ACCESS_TOKEN = 'live-harness-access-token';
const ASSIGNMENT_RUN_ID = 'run_live_harness_1';
const ATHENA_SESSION_ID = 'athena-live-harness';
const STEER_TEXT = 'live-transport harness steer';
const DEFAULT_STEP_TIMEOUT_MS = 5_000;

export type HubProtocol = 'legacy' | 'canonical';

export type RunLiveTransportHarnessOptions = {
	/** Per-step wait timeout in milliseconds. Defaults to 5000ms. */
	stepTimeoutMs?: number;
	/** Which frame-name set the fake hub speaks. Defaults to `legacy`. */
	hubProtocol?: HubProtocol;
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

type WireFrame = {connection: number; frame: Record<string, unknown>};

/**
 * The fake hub's view of one runner frame: does it parse under the package,
 * and is it under the name set this hub expects? Returns a violation message
 * or `null`.
 */
function checkNameSet(
	hubProtocol: HubProtocol,
	frame: Record<string, unknown>,
): string | null {
	if (!FrameSchema.safeParse(frame).success) {
		return `frame does not parse under @drisp/protocol: ${JSON.stringify(frame)}`;
	}
	const canonical = normalizeFrame(frame);
	const expected: unknown =
		hubProtocol === 'canonical' ? canonical : toLegacyFrame(canonical);
	// Compare through the parser so key order and zod's output shape do not
	// matter: what must match is the name set, not the byte layout.
	if (!isDeepStrictEqual(normalizeFrame(expected), canonical)) {
		return `unexpected normalisation of ${JSON.stringify(frame)}`;
	}
	const wireType = frame['type'];
	const expectedType = (expected as {type: string}).type;
	if (wireType !== expectedType) {
		return `frame type=${String(wireType)} is not in the ${hubProtocol} name set (expected ${expectedType})`;
	}
	return null;
}

export async function runLiveTransportHarness(
	options: RunLiveTransportHarnessOptions = {},
): Promise<HarnessVerificationResult> {
	const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
	const hubProtocol = options.hubProtocol ?? 'legacy';
	const checks: HarnessVerificationCheck[] = [];

	// Observable server-side state, mutated by the http + ws handlers below.
	let attachmentFetches = 0;
	let socketConnections = 0;
	// Held in an object so the closure reassignment below is not flattened to
	// `null` by control-flow narrowing at the read sites.
	const serverState: {socket: ServerWebSocket | null} = {socket: null};
	const wire: WireFrame[] = [];
	const violations: string[] = [];
	const handshakeSubprotocols: string[] = [];

	const framesOfType = (type: string): Record<string, unknown>[] =>
		wire.filter(entry => entry.frame['type'] === type).map(e => e.frame);
	const framesOnConnection = (connection: number): Record<string, unknown>[] =>
		wire.filter(entry => entry.connection === connection).map(e => e.frame);

	// Hub → runner frames under the hub's own name set.
	const hubFrames = {
		assign: (tempWorkspace: string): Record<string, unknown> => ({
			type: hubProtocol === 'canonical' ? 'run.start' : 'job_assignment',
			runId: ASSIGNMENT_RUN_ID,
			runSpec: {
				prompt: 'live-transport harness probe',
				projectDir: tempWorkspace,
				athenaSessionId: ATHENA_SESSION_ID,
			},
		}),
		steer: (): CanonicalFrame => ({
			type: 'steer',
			runId: ASSIGNMENT_RUN_ID,
			athenaSessionId: ATHENA_SESSION_ID,
			text: STEER_TEXT,
		}),
		stop: (): Record<string, unknown> => ({
			type: hubProtocol === 'canonical' ? 'stop' : 'cancel',
			runId: ASSIGNMENT_RUN_ID,
		}),
	};

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
		const connection = socketConnections;
		serverState.socket = socket;
		const protocol = req.headers['sec-websocket-protocol'];
		if (typeof protocol === 'string') handshakeSubprotocols.push(protocol);
		socket.on('message', data => {
			let frame: unknown;
			try {
				frame = JSON.parse(data.toString());
			} catch {
				violations.push(`runner sent non-JSON: ${data.toString()}`);
				return;
			}
			if (typeof frame !== 'object' || frame === null) {
				violations.push(`runner sent a non-object frame: ${String(frame)}`);
				return;
			}
			const record = frame as Record<string, unknown>;
			wire.push({connection, frame: record});
			const violation = checkNameSet(hubProtocol, record);
			if (violation) violations.push(violation);
		});
		// A migrated hub announces itself; the hub of today says nothing.
		if (hubProtocol === 'canonical') {
			socket.send(
				JSON.stringify(hello({role: 'hub', agent: {name: 'fake-hub'}})),
			);
		}
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
			// Execution is not under test here; the stub only drives the
			// runner → hub frames a real Run would (one run-stream event and a
			// needs_human) through the REAL client, then parks until stopped.
			executeRemoteAssignment: async input => {
				input.client.sendRunEvent({
					runId: input.assignment.runId,
					seq: 1,
					ts: Date.now(),
					kind: 'progress',
					payload: {message: 'live-transport harness run'},
				});
				input.client.sendNeedsHuman({
					runId: input.assignment.runId,
					athenaSessionId: ATHENA_SESSION_ID,
					interruption: {
						kind: 'blocked',
						reason: 'harness',
						message: 'agent declared NEEDS_HUMAN: harness',
					},
				});
				await new Promise<void>(resolve => {
					if (input.abortSignal?.aborted) return resolve();
					input.abortSignal?.addEventListener('abort', () => resolve(), {
						once: true,
					});
				});
			},
			reconnectDelaysMs: [10],
			projectDir: tempWorkspace,
			writeMirror: () => {},
			pairedFeedPublisher,
			decisionInbox,
		});

		// Scenario 1: the very first frame the runner puts on the wire is a
		// versioned hello.
		await waitFor(
			() => socketConnections >= 1 && framesOnConnection(1).length >= 1,
			'first frame on the initial connection',
			stepTimeoutMs,
		);
		const first = framesOnConnection(1).at(0);
		checks.push(
			isDeepStrictEqual(first, {
				type: 'hello',
				protocolVersion: PROTOCOL_VERSION,
				role: 'runner',
				instanceId: INSTANCE_ID,
			})
				? pass(
						'Versioned hello first',
						`First frame on the wire was hello (protocolVersion=${PROTOCOL_VERSION}, role=runner, instanceId=${INSTANCE_ID}).`,
					)
				: fail(
						'Versioned hello first',
						`First frame on the wire was ${JSON.stringify(first)}, not a versioned hello.`,
					),
		);

		// Scenario 2: the attachment reconcile hit the real 503 and the daemon
		// degraded to push-only instead of tearing the control channel down.
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

		// Scenario 3: the wire mode follows what the hub announced — legacy
		// when it said nothing, canonical once its hello carried our version.
		try {
			await waitFor(
				() => daemon!.snapshot().wireMode === hubProtocol,
				`wire mode ${hubProtocol}`,
				stepTimeoutMs,
			);
			checks.push(
				pass(
					'Wire mode negotiated',
					hubProtocol === 'canonical'
						? `Hub hello announced protocol v${PROTOCOL_VERSION}; runner switched to canonical frame names.`
						: 'Hub sent no hello; runner stayed on the legacy frame names.',
				),
			);
		} catch (err) {
			checks.push(
				fail(
					'Wire mode negotiated',
					err instanceof Error ? err.message : String(err),
				),
			);
		}

		// Scenario 4: send a real assignment under the hub's name set and
		// observe the daemon emit `assignment_accepted` back.
		serverState.socket?.send(JSON.stringify(hubFrames.assign(tempWorkspace)));
		try {
			await waitFor(
				() =>
					framesOfType('assignment_accepted').some(
						f => f['runId'] === ASSIGNMENT_RUN_ID,
					),
				'assignment_accepted frame over the wire',
				stepTimeoutMs,
			);
			checks.push(
				pass(
					'Assignment admitted over the wire',
					`Daemon admitted ${ASSIGNMENT_RUN_ID} from a ${
						hubProtocol === 'canonical' ? 'run.start' : 'job_assignment'
					} frame and sent assignment_accepted back over the real socket.`,
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

		// Scenario 5: the Run's stream and its needs_human escalation reach the
		// hub under the name set it expects.
		const runStreamType = hubProtocol === 'canonical' ? 'event' : 'run_event';
		try {
			await waitFor(
				() =>
					framesOfType(runStreamType).some(
						f =>
							f['runId'] === ASSIGNMENT_RUN_ID &&
							(hubProtocol === 'legacy' || f['stream'] === 'run'),
					) &&
					framesOfType('needs_human').some(
						f => f['runId'] === ASSIGNMENT_RUN_ID,
					),
				`${runStreamType} and needs_human frames for the run`,
				stepTimeoutMs,
			);
			checks.push(
				pass(
					'Run stream and needs_human on the wire',
					`Run stream arrived as ${runStreamType}${
						hubProtocol === 'canonical' ? " (stream: 'run')" : ''
					} and the parked Run was reported with needs_human.`,
				),
			);
		} catch (err) {
			checks.push(
				fail(
					'Run stream and needs_human on the wire',
					err instanceof Error ? err.message : String(err),
				),
			);
		}

		// Scenario 6: a steer for the Run is accepted and recorded on it.
		serverState.socket?.send(JSON.stringify(hubFrames.steer()));
		try {
			await waitFor(
				() =>
					daemon!
						.listRuns()
						.some(
							run =>
								run.runId === ASSIGNMENT_RUN_ID &&
								(run.steers ?? []).some(s => s.text === STEER_TEXT),
						),
				'steer recorded on the run',
				stepTimeoutMs,
			);
			checks.push(
				pass(
					'Steer accepted',
					`steer frame for ${ASSIGNMENT_RUN_ID} was accepted and recorded on the Run.`,
				),
			);
		} catch (err) {
			checks.push(
				fail(
					'Steer accepted',
					err instanceof Error ? err.message : String(err),
				),
			);
		}

		// Scenario 7: a malformed frame is answered with a typed error and does
		// not take the connection down.
		const errorsBefore = framesOfType('error').length;
		serverState.socket?.send(JSON.stringify({type: 'not-a-frame', x: 1}));
		serverState.socket?.send('{"type": "run.start"');
		try {
			await waitFor(
				() => framesOfType('error').length >= errorsBefore + 2,
				'error frames answering malformed input',
				stepTimeoutMs,
			);
			const errors = framesOfType('error').slice(errorsBefore);
			const typed = errors.every(e => e['code'] === 'malformed_frame');
			const stillConnected = daemon.snapshot().socketConnected;
			checks.push(
				typed && stillConnected
					? pass(
							'Malformed frames answered with error',
							'Both a non-frame object and invalid JSON were answered with error{code: malformed_frame}; the socket stayed up.',
						)
					: fail(
							'Malformed frames answered with error',
							`typed=${typed} connected=${stillConnected}: ${JSON.stringify(errors)}`,
						),
			);
		} catch (err) {
			checks.push(
				fail(
					'Malformed frames answered with error',
					err instanceof Error ? err.message : String(err),
				),
			);
		}

		// Scenario 8: the hub stops the Run under its own name set.
		serverState.socket?.send(JSON.stringify(hubFrames.stop()));
		try {
			await waitFor(
				() =>
					daemon!
						.listRuns()
						.some(
							run =>
								run.runId === ASSIGNMENT_RUN_ID && run.status === 'cancelled',
						),
				'run cancelled after stop',
				stepTimeoutMs,
			);
			checks.push(
				pass(
					'Stop cancels the run',
					`${hubProtocol === 'canonical' ? 'stop' : 'cancel'} frame aborted ${ASSIGNMENT_RUN_ID}.`,
				),
			);
		} catch (err) {
			checks.push(
				fail(
					'Stop cancels the run',
					err instanceof Error ? err.message : String(err),
				),
			);
		}

		// Scenario 9: drop the socket from the server and confirm the daemon
		// reconnects through the real reconnect loop — and re-negotiates the
		// wire mode on the new connection.
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
			await waitFor(
				() => daemon!.snapshot().wireMode === hubProtocol,
				`wire mode ${hubProtocol} after reconnect`,
				stepTimeoutMs,
			);
			await waitFor(
				() => framesOnConnection(socketConnections).length >= 1,
				'first frame on the reconnected socket',
				stepTimeoutMs,
			);
			const reconnectFirst = framesOnConnection(socketConnections).at(0);
			const helloAgain = reconnectFirst?.['type'] === 'hello';
			checks.push(
				helloAgain
					? pass(
							'Reconnect after close',
							`Daemon re-established the real socket (connection #${socketConnections}), sent hello first, and is back on ${hubProtocol} frame names.`,
						)
					: fail(
							'Reconnect after close',
							`Reconnected but the first frame was ${JSON.stringify(reconnectFirst)}, not hello.`,
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

		// Scenario 10: every frame the runner put on the wire parsed under the
		// package and was in the name set this hub speaks.
		checks.push(
			violations.length === 0
				? pass(
						'Every runner frame in the expected name set',
						`${wire.length} frames validated against @drisp/protocol under the ${hubProtocol} names: ${[
							...new Set(wire.map(e => String(e.frame['type']))),
						]
							.sort()
							.join(', ')}.`,
					)
				: fail(
						'Every runner frame in the expected name set',
						violations.join('\n'),
					),
		);
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
			? `Dashboard-daemon live-transport harness (${hubProtocol} hub) FAILED`
			: `Dashboard-daemon live-transport harness (${hubProtocol} hub) passed all scenarios`,
		checks,
	};
}
