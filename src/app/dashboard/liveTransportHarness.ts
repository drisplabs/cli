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
	PhaseFeedEventSchema,
	hello,
	normalizeFrame,
	toLegacyFrame,
	type CanonicalFrame,
	type InstalledWorkflow,
} from '@drisp/protocol';
import {buildPhaseFeedEvent} from '../../core/feed/phaseFeedEvent';
import {
	runDashboardRuntimeDaemon,
	type RuntimeDaemonHandle,
} from './runtimeDaemon';
import {createDashboardFeedOutbox} from './dashboardFeedPublisher';
import {
	createPairedFeedPublisher,
	type PairedFeedPublisher,
} from './pairedFeedPublisher';
import type {
	DashboardDecisionInbox,
	DashboardDecisionInboxRow,
} from './dashboardDecisionInbox';
import type {
	HarnessVerificationCheck,
	HarnessVerificationResult,
} from '../../harnesses/types';
import {createWorkflowRunner} from '../../core/workflows/workflowRunner';
import {STEER_BLOCK_OPEN} from '../../core/workflows/steer';

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
 * `decisionInbox`; the paired feed publisher is REAL, with its durable outbox
 * placed in the temp workspace) so the run leaves no working-tree or
 * state-dir pollution. The Workflow store is REAL but pointed at a temp dir
 * (`workflowStoreDir`), so the inventory the runner reports on `hello` and the
 * `workflows.changed` push after an install go through the real store read
 * and the real directory watch.
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
const PHASE_STEP = 'Orient';
const DEFERRED_REQUEST_ID = 'req_live_harness_deferred';
const DEFERRED_CALL = 'Bash: git push origin main';
const DEFAULT_STEP_TIMEOUT_MS = 5_000;
const CLI_VERSION = 'live-harness';
const SEEDED_WORKFLOW: InstalledWorkflow = {
	name: 'harness-review',
	version: '1.0.0',
	source: {kind: 'marketplace-remote', ref: 'review@drisp/harness'},
};
const INSTALLED_WORKFLOW: InstalledWorkflow = {
	name: 'harness-scratch',
	version: '0.2.0',
	source: {kind: 'filesystem', path: '/home/harness/scratch/workflow.json'},
};
const BUILTIN_WORKFLOW: InstalledWorkflow = {
	name: 'default',
	version: CLI_VERSION,
	source: {kind: 'builtin'},
};

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
 * Write a Workflow into the store the way `installWorkflowFromSource` does:
 * `{name}/workflow.json` plus its `source.json`.
 */
function installIntoStore(storeDir: string, workflow: InstalledWorkflow): void {
	const dir = path.join(storeDir, workflow.name);
	fs.mkdirSync(dir, {recursive: true});
	fs.writeFileSync(
		path.join(dir, 'workflow.json'),
		JSON.stringify({
			name: workflow.name,
			version: workflow.version,
			plugins: [],
			promptTemplate: '{input}',
			workflowFile: 'WORKFLOW.md',
		}),
	);
	fs.writeFileSync(path.join(dir, 'WORKFLOW.md'), '# harness workflow\n');
	fs.writeFileSync(
		path.join(dir, 'source.json'),
		JSON.stringify({v: 2, ...workflow.source}),
	);
}

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
		answer: (): Record<string, unknown> => ({
			type: hubProtocol === 'canonical' ? 'answer' : 'dashboard_decision',
			athenaSessionId: ATHENA_SESSION_ID,
			requestId: DEFERRED_REQUEST_ID,
			decision: {
				type: 'json',
				source: 'user',
				intent: {kind: 'permission_allow'},
			},
		}),
	};

	// Hermetic workspace for the admitted assignment. Pointing the assignment's
	// `runSpec.projectDir` here keeps `resolveRemoteWorkspace` off the daemon
	// state dir, so the run writes nothing outside this temp dir.
	const tempWorkspace = fs.mkdtempSync(
		path.join(os.tmpdir(), 'athena-live-transport-harness-'),
	);
	// A hermetic Workflow store seeded with one installed Workflow, so the
	// inventory on hello is known and an install/removal can be observed.
	const workflowStoreDir = fs.mkdtempSync(
		path.join(os.tmpdir(), 'athena-live-transport-workflows-'),
	);
	installIntoStore(workflowStoreDir, SEEDED_WORKFLOW);

	// The paired dashboard config the daemon and the feed publisher share; the
	// URL is filled in once the fake hub is listening.
	let dashboardUrl = '';
	const readConfig = () => ({
		dashboardUrl,
		instanceId: INSTANCE_ID,
		refreshToken: 'live-harness-refresh-token',
		fingerprint: 'live-harness-fingerprint',
		pairedAt: Date.now(),
	});

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
			// A hub acks each feed-stream frame so the runner's outbox stops
			// redelivering it.
			if (
				record['type'] === 'feed_event' ||
				(record['type'] === 'event' && record['stream'] === 'feed')
			) {
				socket.send(
					JSON.stringify({
						type: 'feed_ack',
						deliverySeq: record['deliverySeq'],
					}),
				);
			}
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

	// What the stubbed Run's fake harness saw: the prompt of every Turn the
	// real Workflow Runner started, and the Journal as Turn 2 found it.
	const runState: {turnPrompts: string[]; journalSeenByTurn2: string} = {
		turnPrompts: [],
		journalSeenByTurn2: '',
	};

	// The paired feed publisher is real — it is the seam the feed-stream
	// scenario exercises — but its durable outbox lives in the temp workspace,
	// so the dashboard state dir is never touched.
	const feedOutbox = createDashboardFeedOutbox({
		dbPath: path.join(tempWorkspace, 'feed-outbox.db'),
	});
	const pairedFeedPublisher: PairedFeedPublisher = createPairedFeedPublisher({
		readConfig,
		outbox: feedOutbox,
		drainIntervalMs: 50,
	});
	// The decision inbox is real in shape but in-memory: an `answer` the hub
	// sends while the Run is parked must be stored against the request it is
	// for, and observable, without touching the daemon state dir.
	const inboxRows: DashboardDecisionInboxRow[] = [];
	const consumedRows = new Set<number>();
	const decisionInbox: DashboardDecisionInbox = {
		enqueue: input => {
			inboxRows.push({id: inboxRows.length + 1, ...input});
		},
		pendingForSession: ({athenaSessionId}) =>
			inboxRows.filter(
				row =>
					row.athenaSessionId === athenaSessionId && !consumedRows.has(row.id),
			),
		markConsumed: ({id}) => {
			consumedRows.add(id);
		},
		close: () => {},
	};
	// Every wake the stub executor received: the daemon re-launching a parked
	// Run once an answer for its deferred request arrived.
	const wakes: Array<{runId: string; reply: string}> = [];

	try {
		await new Promise<void>((resolve, reject) => {
			httpServer.once('error', reject);
			httpServer.listen(0, '127.0.0.1', () => resolve());
		});
		const {port} = httpServer.address() as AddressInfo;
		dashboardUrl = `http://127.0.0.1:${port}`;

		daemon = await runDashboardRuntimeDaemon({
			readConfig,
			refreshAccessToken: async () => ({
				accessToken: ACCESS_TOKEN,
				instanceId: INSTANCE_ID,
				expiresInSec: 900,
			}),
			// The harness is not under test here; the stub drives the runner →
			// hub frames a real Run would through the REAL client. On its first
			// launch it reports one run-stream event and parks on a deferred
			// permission (needs_human with a `question` addressed by a request
			// id) and returns, the way a parked run's executor does (#190).
			// Woken by the hub's answer for that request, it runs a REAL
			// Workflow Runner over a fake harness whose first Turn stays in
			// flight until the hub's steer lands — so the steer is provably
			// queued mid-Turn and delivered at the head of the next Turn (#191).
			// Turn 1 leaves a Turn Protocol block in the Journal, so the
			// Runner's change of step goes out through the real paired feed
			// publisher (#192). Finally it parks until stopped.
			executeRemoteAssignment: async input => {
				if (input.wake) {
					wakes.push({runId: input.assignment.runId, reply: input.wake.reply});

					const journalPath = path.join(
						tempWorkspace,
						'.athena',
						ATHENA_SESSION_ID,
						'journal.md',
					);
					let releaseFirstTurn: () => void = () => {};
					const firstTurnGate = new Promise<void>(resolve => {
						releaseFirstTurn = resolve;
					});
					const runner = createWorkflowRunner({
						sessionId: ATHENA_SESSION_ID,
						projectDir: tempWorkspace,
						prompt: input.wake.reply,
						workflow: {
							name: 'live-harness',
							plugins: [],
							promptTemplate: '{input}',
							loop: {enabled: true, maxIterations: 3},
						},
						startTurn: async turn => {
							runState.turnPrompts.push(turn.prompt);
							if (runState.turnPrompts.length === 1) {
								await firstTurnGate;
								fs.writeFileSync(
									journalPath,
									[
										'turn 1 done',
										'<!-- TURN_PROTOCOL',
										`step: ${PHASE_STEP}`,
										'step_index: 1',
										'step_total: 3',
										'-->',
									].join('\n'),
									'utf-8',
								);
							} else {
								runState.journalSeenByTurn2 = fs.readFileSync(
									journalPath,
									'utf-8',
								);
								fs.writeFileSync(
									journalPath,
									'<!-- WORKFLOW_COMPLETE -->',
									'utf-8',
								);
							}
							return {
								exitCode: 0,
								error: null,
								streamMessage: null,
								tokens: {
									input: null,
									output: null,
									cacheRead: null,
									cacheWrite: null,
									total: null,
									contextSize: null,
									contextWindowSize: null,
								},
							};
						},
						persistRunState: () => {},
						// A change of workflow step reaches the hub through the paired
						// feed publisher — the feed stream, not the run stream — the
						// way runExec publishes it.
						onPhaseChange: phase => {
							input.dashboardFeedPublisher?.publish({
								origin: 'dashboard',
								athenaSessionId: ATHENA_SESSION_ID,
								feedEvents: [
									buildPhaseFeedEvent({
										phase,
										sessionId: ATHENA_SESSION_ID,
										runId: `${ATHENA_SESSION_ID}:R1`,
										seq: 1,
										ts: Date.now(),
									}),
								],
							});
						},
					});
					// The daemon's steer queue is the seam runExec subscribes on in
					// production; here the stub subscribes the same way.
					input.steerQueue?.subscribe(steer => {
						runner.steer(steer);
						releaseFirstTurn();
					});
					input.abortSignal?.addEventListener(
						'abort',
						() => {
							runner.cancel();
							releaseFirstTurn();
						},
						{once: true},
					);
					await runner.result;
					await new Promise<void>(resolve => {
						if (input.abortSignal?.aborted) return resolve();
						input.abortSignal?.addEventListener('abort', () => resolve(), {
							once: true,
						});
					});
					return;
				}
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
						kind: 'question',
						message: `permission request (Bash) unanswered within the grace window (60s); deferred: git push origin main`,
						requestId: DEFERRED_REQUEST_ID,
						question: DEFERRED_CALL,
					},
				});
			},
			reconnectDelaysMs: [10],
			projectDir: tempWorkspace,
			writeMirror: () => {},
			pairedFeedPublisher,
			decisionInbox,
			workflowStoreDir,
			cliVersion: CLI_VERSION,
		});

		// Scenario 1: the very first frame the runner puts on the wire is a
		// versioned hello that reports the installed Workflows: the built-in
		// (versioned by the CLI) and the one seeded in the store.
		await waitFor(
			() => socketConnections >= 1 && framesOnConnection(1).length >= 1,
			'first frame on the initial connection',
			stepTimeoutMs,
		);
		const first = framesOnConnection(1).at(0);
		const initialInventory = [BUILTIN_WORKFLOW, SEEDED_WORKFLOW];
		checks.push(
			isDeepStrictEqual(first, {
				type: 'hello',
				protocolVersion: PROTOCOL_VERSION,
				role: 'runner',
				instanceId: INSTANCE_ID,
				workflows: initialInventory,
			})
				? pass(
						'Versioned hello first',
						`First frame on the wire was hello (protocolVersion=${PROTOCOL_VERSION}, role=runner, instanceId=${INSTANCE_ID}) reporting workflows ${initialInventory
							.map(w => `${w.name}@${w.version ?? '?'} (${w.source.kind})`)
							.join(', ')}.`,
					)
				: fail(
						'Versioned hello first',
						`First frame on the wire was ${JSON.stringify(first)}, not a versioned hello reporting ${JSON.stringify(initialInventory)}.`,
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

		// Scenario 6: the Run is parked on a deferred permission. The hub's
		// answer for that request (under its own name set) is acked, stored in
		// the inbox and against the Run's Interruption, and wakes the Run: the
		// executor is re-launched with a wake reply and the Run is active again.
		serverState.socket?.send(JSON.stringify(hubFrames.answer()));
		try {
			await waitFor(
				() =>
					framesOfType('decision_ack').some(
						f => f['requestId'] === DEFERRED_REQUEST_ID,
					) &&
					wakes.length >= 1 &&
					daemon!
						.listRuns()
						.some(
							run =>
								run.runId === ASSIGNMENT_RUN_ID &&
								run.status === 'running' &&
								run.answer?.requestId === DEFERRED_REQUEST_ID &&
								run.interruption?.kind === 'question' &&
								run.interruption.requestId === DEFERRED_REQUEST_ID,
						),
				'answer acked, stored on the parked run, and the run woken',
				stepTimeoutMs,
			);
			const stored = decisionInbox
				.pendingForSession({athenaSessionId: ATHENA_SESSION_ID, limit: 25})
				.some(row => row.requestId === DEFERRED_REQUEST_ID);
			const reply = wakes[0]?.reply ?? '';
			const replyNamesAnswer =
				reply.includes(DEFERRED_CALL) && reply.includes('allow');
			checks.push(
				stored && replyNamesAnswer
					? pass(
							'Answer stored and Run woken while parked',
							`${hubProtocol === 'canonical' ? 'answer' : 'dashboard_decision'} for ${DEFERRED_REQUEST_ID} was acked, kept in the inbox for replay, recorded on the parked Run, and the Run was woken with the reply naming the answer.`,
						)
					: fail(
							'Answer stored and Run woken while parked',
							`stored=${stored} reply=${JSON.stringify(reply)}`,
						),
			);
		} catch (err) {
			checks.push(
				fail(
					'Answer stored and Run woken while parked',
					err instanceof Error ? err.message : String(err),
				),
			);
		}

		// Scenario 7: a steer sent while Turn 1 of the woken Run is in flight is
		// recorded on the Run, waits for the Turn boundary, and heads the next
		// Turn's prompt.
		try {
			await waitFor(
				() => runState.turnPrompts.length >= 1,
				'the Run to start its first Turn before the steer',
				stepTimeoutMs,
			);
			serverState.socket?.send(JSON.stringify(hubFrames.steer()));
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
			await waitFor(
				() => runState.turnPrompts.length >= 2,
				'the Turn after the steer to start',
				stepTimeoutMs,
			);
			const [firstPrompt = '', secondPrompt = ''] = runState.turnPrompts;
			const notInjected = !firstPrompt.includes(STEER_TEXT);
			const atHead =
				secondPrompt.startsWith(STEER_BLOCK_OPEN) &&
				secondPrompt.includes(STEER_TEXT);
			const journaled = runState.journalSeenByTurn2.includes(
				'Human steer (via hub)',
			);
			checks.push(
				notInjected && atHead && journaled
					? pass(
							'Steer delivered into the next Turn',
							`steer frame for ${ASSIGNMENT_RUN_ID} was recorded, left Turn 1 untouched, headed Turn 2's prompt, and was journaled with its origin.`,
						)
					: fail(
							'Steer delivered into the next Turn',
							`notInjected=${notInjected} atHead=${atHead} journaled=${journaled}; turn 2 prompt: ${JSON.stringify(secondPrompt.slice(0, 200))}`,
						),
			);
		} catch (err) {
			checks.push(
				fail(
					'Steer delivered into the next Turn',
					err instanceof Error ? err.message : String(err),
				),
			);
		}

		// Scenario 8: the change of workflow step Turn 1's Journal named reaches
		// the hub as a `phase` FeedEvent on the feed stream — produced by the
		// real Workflow Runner, published through the real paired feed
		// publisher — under the hub's name set, addressed to the Run's Athena
		// Session, and parsing under PhaseFeedEventSchema.
		const feedStreamType = hubProtocol === 'canonical' ? 'event' : 'feed_event';
		const isPhaseFrame = (frame: Record<string, unknown>): boolean => {
			if (hubProtocol === 'canonical' && frame['stream'] !== 'feed') {
				return false;
			}
			const envelope = frame['envelope'] as
				| {feedEvent?: {kind?: unknown}}
				| undefined;
			return envelope?.feedEvent?.kind === 'phase';
		};
		try {
			await waitFor(
				() => framesOfType(feedStreamType).some(isPhaseFrame),
				'phase FeedEvent on the feed stream',
				stepTimeoutMs,
			);
			const phaseFrame = framesOfType(feedStreamType).find(isPhaseFrame)!;
			const envelope = phaseFrame['envelope'] as {
				athenaSessionId?: unknown;
				feedEvent: unknown;
			};
			const parsed = PhaseFeedEventSchema.safeParse(envelope.feedEvent);
			checks.push(
				parsed.success && envelope.athenaSessionId === ATHENA_SESSION_ID
					? pass(
							'Phase event on the feed stream',
							`Step "${parsed.data.data.step}" (${parsed.data.data.stepIndex}/${parsed.data.data.stepTotal}) of ${parsed.data.data.runId}, named by Turn ${parsed.data.data.turn}, arrived as ${feedStreamType}${
								hubProtocol === 'canonical' ? " (stream: 'feed')" : ''
							} and parsed under PhaseFeedEventSchema.`,
						)
					: fail(
							'Phase event on the feed stream',
							parsed.success
								? `phase envelope addressed to ${String(envelope.athenaSessionId)}, not ${ATHENA_SESSION_ID}`
								: `phase FeedEvent does not parse under PhaseFeedEventSchema: ${parsed.error.message}`,
						),
			);
		} catch (err) {
			checks.push(
				fail(
					'Phase event on the feed stream',
					err instanceof Error ? err.message : String(err),
				),
			);
		}

		// Scenario 9: a malformed frame is answered with a typed error and does
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

		// Scenario 10: the hub stops the Run under its own name set.
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

		// Scenario 11: a Workflow installed into the store while connected is
		// pushed as a full-list replace (`workflows.changed`), and so is a
		// removal. The store is watched for real; nothing tells the daemon.
		const changesBefore = framesOfType('workflows.changed').length;
		const afterInstall = [
			BUILTIN_WORKFLOW,
			SEEDED_WORKFLOW,
			INSTALLED_WORKFLOW,
		];
		const afterRemoval = [BUILTIN_WORKFLOW, INSTALLED_WORKFLOW];
		try {
			installIntoStore(workflowStoreDir, INSTALLED_WORKFLOW);
			await waitFor(
				() =>
					framesOfType('workflows.changed')
						.slice(changesBefore)
						.some(f => isDeepStrictEqual(f['workflows'], afterInstall)),
				`workflows.changed reporting ${INSTALLED_WORKFLOW.name} after install`,
				stepTimeoutMs,
			);
			fs.rmSync(path.join(workflowStoreDir, SEEDED_WORKFLOW.name), {
				recursive: true,
				force: true,
			});
			await waitFor(
				() =>
					framesOfType('workflows.changed')
						.slice(changesBefore)
						.some(f => isDeepStrictEqual(f['workflows'], afterRemoval)),
				`workflows.changed without ${SEEDED_WORKFLOW.name} after removal`,
				stepTimeoutMs,
			);
			checks.push(
				pass(
					'Workflow store change pushed',
					`Installing ${INSTALLED_WORKFLOW.name}@${INSTALLED_WORKFLOW.version} into the store produced workflows.changed listing ${afterInstall
						.map(w => w.name)
						.join(
							', ',
						)}; removing ${SEEDED_WORKFLOW.name} produced workflows.changed listing ${afterRemoval
						.map(w => w.name)
						.join(', ')}.`,
				),
			);
		} catch (err) {
			checks.push(
				fail(
					'Workflow store change pushed',
					`${err instanceof Error ? err.message : String(err)}; saw ${JSON.stringify(
						framesOfType('workflows.changed').slice(changesBefore),
					)}`,
				),
			);
		}

		// Scenario 12: drop the socket from the server and confirm the daemon
		// reconnects through the real reconnect loop — re-negotiating the wire
		// mode and re-reading the store for the new connection's hello.
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
			const inventoryCurrent = isDeepStrictEqual(
				reconnectFirst?.['workflows'],
				afterRemoval,
			);
			checks.push(
				helloAgain && inventoryCurrent
					? pass(
							'Reconnect after close',
							`Daemon re-established the real socket (connection #${socketConnections}), sent hello first with the current workflows (${afterRemoval
								.map(w => w.name)
								.join(', ')}), and is back on ${hubProtocol} frame names.`,
						)
					: fail(
							'Reconnect after close',
							helloAgain
								? `Reconnected with hello, but its workflows were ${JSON.stringify(reconnectFirst['workflows'])}, not the current store ${JSON.stringify(afterRemoval)}.`
								: `Reconnected but the first frame was ${JSON.stringify(reconnectFirst)}, not hello.`,
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

		// Scenario 13: every frame the runner put on the wire parsed under the
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
		try {
			feedOutbox.close();
		} catch {
			// best-effort; the temp workspace is removed below regardless
		}
		await new Promise<void>(resolve => {
			wss.close(() => resolve());
		});
		await new Promise<void>(resolve => {
			httpServer.close(() => resolve());
		});
		try {
			fs.rmSync(tempWorkspace, {recursive: true, force: true});
			fs.rmSync(workflowStoreDir, {recursive: true, force: true});
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
