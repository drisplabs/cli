import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {runDashboardRuntimeDaemon} from './runtimeDaemon';
import type {
	InstanceSocketClient,
	InstanceSocketFrame,
} from './instanceSocketClient';
import type {DashboardClientConfig} from '../../infra/config/dashboardClient';
import {createDashboardFeedOutbox} from './dashboardFeedPublisher';
import {createPairedFeedPublisher} from './pairedFeedPublisher';

const tmpDirs: string[] = [];
const originalXdgStateHome = process.env['XDG_STATE_HOME'];
const originalHome = process.env['HOME'];

function tempDbPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-daemon-outbox-'));
	tmpDirs.push(dir);
	return path.join(dir, 'outbox.db');
}

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalXdgStateHome === undefined) {
		delete process.env['XDG_STATE_HOME'];
	} else {
		process.env['XDG_STATE_HOME'] = originalXdgStateHome;
	}
	if (originalHome === undefined) {
		delete process.env['HOME'];
	} else {
		process.env['HOME'] = originalHome;
	}
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

beforeEach(() => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-daemon-state-'));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-daemon-home-'));
	tmpDirs.push(dir, home);
	process.env['XDG_STATE_HOME'] = dir;
	process.env['HOME'] = home;
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json({attachments: []})),
	);
});

function makeFakeSocket() {
	const frameHandlers: Array<(frame: InstanceSocketFrame) => void> = [];
	const closeHandlers: Array<(reason: string) => void> = [];
	const calls = {
		connect: 0,
		close: [] as string[],
		assignmentAccepted: [] as string[],
		assignmentRejected: [] as Array<{
			runId: string;
			reason: string;
			message?: string;
		}>,
		feedEvents: [] as unknown[],
		decisionAcks: [] as unknown[],
	};
	const client: InstanceSocketClient = {
		connect: async () => {
			calls.connect += 1;
		},
		close: (reason?: string) => calls.close.push(reason ?? ''),
		onFrame: handler => {
			frameHandlers.push(handler);
		},
		onClose: handler => {
			closeHandlers.push(handler);
		},
		sendAssignmentAccepted: runId => {
			calls.assignmentAccepted.push(runId);
		},
		sendAssignmentRejected: input => {
			calls.assignmentRejected.push(input);
		},
		sendRunEvent: () => {},
		sendFeedEvent: frame => {
			calls.feedEvents.push(frame);
		},
		sendDecisionAck: frame => {
			calls.decisionAcks.push(frame);
		},
	};
	return {
		client,
		calls,
		emitFrame: (frame: InstanceSocketFrame) => {
			for (const handler of frameHandlers) handler(frame);
		},
		emitClose: (reason: string) => {
			for (const handler of closeHandlers) handler(reason);
		},
	};
}

const stored: DashboardClientConfig = {
	dashboardUrl: 'https://example.com',
	instanceId: 'inst_1',
	refreshToken: 'refresh',
	fingerprint: 'fp',
	pairedAt: 1,
};

describe('runDashboardRuntimeDaemon', () => {
	it('drains queued dashboard feed events over the instance socket and removes ACKed rows', async () => {
		vi.useFakeTimers();
		try {
			const fake = makeFakeSocket();
			const dbPath = tempDbPath();
			const outbox = createDashboardFeedOutbox({dbPath});
			const publisher = createPairedFeedPublisher({
				readConfig: () => stored,
				outbox,
				now: () => 1234,
			});
			publisher.publish({
				origin: 'local',
				athenaSessionId: 'athena-1',
				feedEvents: [
					{
						event_id: 'feed-1',
						seq: 9,
						ts: 1234,
						session_id: 'adapter-1',
						run_id: 'run-1',
						kind: 'notification',
						level: 'info',
						actor_id: 'agent:root',
						title: 'Notice',
						data: {message: 'queued'},
					},
				],
			});

			const daemon = await runDashboardRuntimeDaemon({
				readConfig: () => stored,
				refreshAccessToken: async () => ({
					instanceId: 'inst_1',
					accessToken: 'a',
					expiresInSec: 900,
				}),
				makeInstanceSocketClient: () => fake.client,
				executeRemoteAssignment: vi.fn(async () => {}),
				reconnectDelaysMs: [],
				pairedFeedPublisher: publisher,
			});

			await vi.advanceTimersByTimeAsync(100);
			expect(fake.calls.feedEvents).toEqual([
				expect.objectContaining({
					deliverySeq: 1,
					envelope: expect.objectContaining({
						eventId: 'athena-1:feed-1',
						feedSeq: 1,
					}),
				}),
			]);

			fake.emitFrame({type: 'feed_ack', deliverySeq: 1});
			expect(outbox.pendingBatch({limit: 10, now: 1234})).toEqual([]);

			await daemon.stop('test');
			outbox.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it('persists inbound dashboard decisions for local sessions', async () => {
		const fake = makeFakeSocket();
		const decisionInbox = {
			enqueue: vi.fn(),
			pendingForSession: vi.fn(() => []),
			markConsumed: vi.fn(),
			close: vi.fn(),
		};

		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'a',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: vi.fn(async () => {}),
			reconnectDelaysMs: [],
			decisionInbox,
			now: () => 555,
		});

		fake.emitFrame({
			type: 'dashboard_decision',
			athenaSessionId: 'athena-1',
			requestId: 'req-1',
			decision: {
				type: 'json',
				source: 'user',
				intent: {kind: 'permission_allow'},
			},
		});

		expect(decisionInbox.enqueue).toHaveBeenCalledWith({
			athenaSessionId: 'athena-1',
			requestId: 'req-1',
			decision: {
				type: 'json',
				source: 'user',
				intent: {kind: 'permission_allow'},
			},
			receivedAt: 555,
		});
		expect(fake.calls.decisionAcks).toEqual([
			{athenaSessionId: 'athena-1', requestId: 'req-1'},
		]);

		await daemon.stop('test');
	});

	it('connects with a refreshed token and executes each assignment once', async () => {
		const fake = makeFakeSocket();
		const executor = vi.fn(async () => {});
		const pairedFeedPublisher = {
			publish: vi.fn(),
			attachTransport: vi.fn(),
			detachTransport: vi.fn(),
			handleAck: vi.fn(),
			close: vi.fn(),
		};

		const stop = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'access_1',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: opts => {
				expect(opts).toMatchObject({
					dashboardUrl: 'https://example.com',
					instanceId: 'inst_1',
					accessToken: 'access_1',
				});
				return fake.client;
			},
			executeRemoteAssignment: executor,
			pairedFeedPublisher,
			reconnectDelaysMs: [],
		});

		const frame: InstanceSocketFrame = {
			type: 'job_assignment',
			runId: 'run_1',
			runSpec: {prompt: 'hi'},
		};
		fake.emitFrame(frame);
		fake.emitFrame(frame);
		await Promise.resolve();

		expect(fake.calls.connect).toBe(1);
		expect(fake.calls.assignmentAccepted).toEqual(['run_1']);
		expect(executor).toHaveBeenCalledTimes(1);
		expect(executor.mock.calls[0]![0]).toMatchObject({
			assignment: expect.objectContaining({runId: 'run_1', frame}),
			dashboardFeedPublisher: pairedFeedPublisher,
		});

		await stop.stop('test');
	});

	it('buffers assignments until reconnect attachment reconciliation completes', async () => {
		const fake = makeFakeSocket();
		let resolveAttachments: (
			value: Array<{runnerId: string}>,
		) => void = () => {};
		const fetchAttachments = vi.fn(
			async () =>
				new Promise<Array<{runnerId: string}>>(resolve => {
					resolveAttachments = resolve;
				}),
		);
		const executor = vi.fn(async () => {});
		const daemonPromise = runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'access_1',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: executor,
			reconnectDelaysMs: [],
			fetchAttachments,
		});

		await vi.waitFor(() => {
			expect(fake.calls.connect).toBe(1);
			expect(fetchAttachments).toHaveBeenCalledTimes(1);
		});
		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_waiting',
			runSpec: {prompt: 'hi'},
		});
		expect(executor).not.toHaveBeenCalled();
		expect(fake.calls.assignmentAccepted).toEqual([]);

		resolveAttachments([{runnerId: 'r1'}]);
		const daemon = await daemonPromise;
		await Promise.resolve();
		expect(executor).toHaveBeenCalledTimes(1);
		expect(executor.mock.calls[0]![0].projectDir).toBe(
			path.join(
				process.env['XDG_STATE_HOME']!,
				'drisp',
				'remote-workspaces',
				'example.com',
				'legacy',
				'runs',
				'run_waiting',
			),
		);
		expect(fake.calls.assignmentAccepted).toEqual(['run_waiting']);
		await daemon.stop('test');
	});

	it('keeps the connection and admits assignments when attachment reconciliation fails', async () => {
		const fake = makeFakeSocket();
		const fetchAttachments = vi
			.fn()
			.mockRejectedValue(new Error('attachments unavailable'));
		const executor = vi.fn(async () => {});
		const log = vi.fn();

		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'access_1',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: executor,
			reconnectDelaysMs: [],
			fetchAttachments,
			log,
		});

		// Reconcile failure must not tear the socket down — it degrades to the
		// push-based mirror and continues serving assignments.
		expect(fake.calls.connect).toBe(1);
		expect(fake.calls.close).not.toContain('attachment reconciliation failed');
		expect(log).toHaveBeenCalledWith(
			'warn',
			expect.stringContaining('attachment reconciliation failed'),
		);

		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_degraded',
			runSpec: {prompt: 'hi'},
		});
		await Promise.resolve();
		expect(executor).toHaveBeenCalledTimes(1);
		expect(fake.calls.assignmentAccepted).toEqual(['run_degraded']);
		await daemon.stop('test');
	});

	it('does not admit an assignment against a socket dropped mid-reconcile, then admits it once after a clean reconnect', async () => {
		vi.useFakeTimers();
		try {
			const first = makeFakeSocket();
			const second = makeFakeSocket();
			const sockets = [first.client, second.client];

			// The first reconciliation is held open so we can drop the socket
			// while it is still in flight. The reconnect's reconciliation
			// resolves immediately.
			let releaseFirstReconcile: (
				value: Array<{runnerId: string}>,
			) => void = () => {};
			const firstReconcile = new Promise<Array<{runnerId: string}>>(resolve => {
				releaseFirstReconcile = resolve;
			});
			let fetchCalls = 0;
			const fetchAttachments = vi.fn(async () => {
				fetchCalls += 1;
				return fetchCalls === 1 ? firstReconcile : [{runnerId: 'r1'}];
			});
			const executor = vi.fn(async () => {});

			const daemonPromise = runDashboardRuntimeDaemon({
				readConfig: () => stored,
				refreshAccessToken: async () => ({
					instanceId: 'inst_1',
					accessToken: 'access_1',
					expiresInSec: 900,
				}),
				makeInstanceSocketClient: () => sockets.shift() ?? second.client,
				executeRemoteAssignment: executor,
				// Non-zero so the reconnect is deferred and we can observe the
				// dropped-client window before it fires.
				reconnectDelaysMs: [100],
				fetchAttachments,
			});

			// First socket connects; its attachment reconciliation is in flight.
			await vi.waitFor(() => {
				expect(first.calls.connect).toBe(1);
				expect(fetchAttachments).toHaveBeenCalledTimes(1);
			});

			// An assignment arrives mid-reconcile → buffered, not yet admitted.
			first.emitFrame({
				type: 'job_assignment',
				runId: 'run_race',
				runSpec: {prompt: 'hi'},
			});
			expect(executor).not.toHaveBeenCalled();
			expect(first.calls.assignmentAccepted).toEqual([]);

			// The socket dies before reconciliation settles.
			first.emitClose('dropped mid-reconcile');

			// The dead connection's reconciliation now resolves. The in-connect
			// guard (`client !== next`) must short-circuit before mark-ready so
			// the assignment is NOT admitted against the dropped socket and the
			// daemon does not mark itself ready.
			releaseFirstReconcile([{runnerId: 'r1'}]);
			const daemon = await daemonPromise;

			expect(daemon.snapshot().socketConnected).toBe(false);
			expect(executor).not.toHaveBeenCalled();
			expect(first.calls.assignmentAccepted).toEqual([]);

			// A clean reconnect completes; reconciliation succeeds this time and
			// the buffered assignment is drained exactly once over the new socket.
			await vi.advanceTimersByTimeAsync(100);
			await vi.waitFor(() => {
				expect(second.calls.assignmentAccepted).toEqual(['run_race']);
			});
			expect(executor).toHaveBeenCalledTimes(1);
			expect(first.calls.assignmentAccepted).toEqual([]);
			expect(daemon.snapshot().socketConnected).toBe(true);

			await daemon.stop('test');
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not reconcile console sidecars or reload the gateway when attachments change', async () => {
		const fake = makeFakeSocket();
		const home = process.env['HOME']!;
		const channelDir = path.join(home, '.config', 'athena', 'channels');

		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'a',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: vi.fn(async () => {}),
			reconnectDelaysMs: [],
			writeMirror: vi.fn(),
		});

		fake.emitFrame({
			type: 'attachments.changed',
			attachments: [{runnerId: 'r1', name: 'one'}],
		});
		await Promise.resolve();

		expect(fs.existsSync(path.join(channelDir, 'console-r1.json'))).toBe(false);

		await daemon.stop('test');
	});

	it('writes the local attachment mirror when an attachments.changed frame arrives', async () => {
		const fake = makeFakeSocket();
		const writeMirror = vi.fn();

		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'a',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: vi.fn(async () => {}),
			reconnectDelaysMs: [],
			writeMirror,
			now: () => 4242,
		});

		fake.emitFrame({
			type: 'attachments.changed',
			attachments: [
				{
					runnerId: 'r1',
					name: 'laptop',
					executionTarget: 'local',
					remoteInstanceId: 'inst_1',
				},
				{runnerId: 'r2'},
			],
		});

		expect(writeMirror).toHaveBeenCalledTimes(2);
		expect(writeMirror).toHaveBeenLastCalledWith({
			instanceId: 'inst_1',
			fetchedAt: 4242,
			attachments: [
				{
					runnerId: 'r1',
					name: 'laptop',
					executionTarget: 'local',
					remoteInstanceId: 'inst_1',
				},
				{runnerId: 'r2'},
			],
		});

		await daemon.stop('test');
	});

	it('aborts an active assignment when a cancel frame arrives', async () => {
		const fake = makeFakeSocket();
		let seenSignal: AbortSignal | undefined;
		let resolveExecutor: () => void = () => {};
		const executor = vi.fn(async input => {
			seenSignal = input.abortSignal;
			await new Promise<void>(resolve => {
				resolveExecutor = resolve;
			});
		});

		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'access_1',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: executor,
			reconnectDelaysMs: [],
		});

		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_cancel',
			runSpec: {prompt: 'hi'},
		});
		await Promise.resolve();
		expect(seenSignal?.aborted).toBe(false);

		fake.emitFrame({type: 'cancel', runId: 'run_cancel'});
		expect(seenSignal?.aborted).toBe(true);
		resolveExecutor();
		await daemon.stop('test');
	});

	it('does not fail an active legacy assignment when output is emitted during socket reconnect', async () => {
		const fake = makeFakeSocket();
		let releaseOutput: () => void = () => {};
		const executor = vi.fn(async input => {
			await new Promise<void>(resolve => {
				releaseOutput = resolve;
			});
			input.client.sendRunEvent({
				runId: input.assignment.runId,
				seq: 1,
				ts: 123,
				kind: 'progress',
				payload: {message: 'still running'},
			});
		});

		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'a',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: executor,
			reconnectDelaysMs: [10_000],
		});

		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_disconnect',
			runSpec: {prompt: 'legacy'},
		});
		await Promise.resolve();
		fake.emitClose('network');
		releaseOutput();

		await vi.waitFor(() => {
			expect(daemon.listRuns().find(r => r.runId === 'run_disconnect')).toEqual(
				expect.objectContaining({status: 'completed'}),
			);
		});

		await daemon.stop('test');
	});

	it('runs assignments for different runners concurrently with cap=1 per runner', async () => {
		const fake = makeFakeSocket();
		const resolvers = new Map<string, () => void>();
		const executor = vi.fn(async (input: {frame: {runId: string}}) => {
			await new Promise<void>(resolve => {
				resolvers.set(input.assignment.runId, resolve);
			});
		});

		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'a',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: executor,
			reconnectDelaysMs: [],
			maxConcurrentRuns: 1,
		});

		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_a',
			runnerId: 'r1',
			runSpec: {prompt: 'a'},
		});
		await Promise.resolve();
		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_b',
			runnerId: 'r2',
			runSpec: {prompt: 'b'},
		});
		await Promise.resolve();

		expect(executor).toHaveBeenCalledTimes(2);
		const runs = daemon.listRuns();
		expect(runs.find(r => r.runId === 'run_a')?.status).toBe('running');
		expect(runs.find(r => r.runId === 'run_b')?.status).toBe('running');

		for (const resolve of resolvers.values()) resolve();
		await daemon.stop('test');
	});

	it('cancel finds the right run regardless of which runner bucket it is in', async () => {
		const fake = makeFakeSocket();
		const seenSignals = new Map<string, AbortSignal>();
		const resolvers = new Map<string, () => void>();
		const executor = vi.fn(
			async (input: {frame: {runId: string}; abortSignal?: AbortSignal}) => {
				if (input.abortSignal) {
					seenSignals.set(input.assignment.runId, input.abortSignal);
				}
				await new Promise<void>(resolve => {
					resolvers.set(input.assignment.runId, resolve);
				});
			},
		);

		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'a',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: executor,
			reconnectDelaysMs: [],
			maxConcurrentRuns: 1,
		});

		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_a',
			runnerId: 'r1',
			runSpec: {prompt: 'a'},
		});
		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_b',
			runnerId: 'r2',
			runSpec: {prompt: 'b'},
		});
		await Promise.resolve();

		fake.emitFrame({type: 'cancel', runId: 'run_b'});
		expect(seenSignals.get('run_b')?.aborted).toBe(true);
		expect(seenSignals.get('run_a')?.aborted).toBe(false);

		for (const resolve of resolvers.values()) resolve();
		await daemon.stop('test');
	});

	it("legacy assignments (no runnerId) share their own bucket and don't block runner buckets", async () => {
		const fake = makeFakeSocket();
		const resolvers = new Map<string, () => void>();
		const executor = vi.fn(async (input: {frame: {runId: string}}) => {
			await new Promise<void>(resolve => {
				resolvers.set(input.assignment.runId, resolve);
			});
		});

		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'a',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: executor,
			reconnectDelaysMs: [],
			maxConcurrentRuns: 1,
		});

		// Legacy frame fills the legacy bucket.
		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_legacy',
			runSpec: {prompt: 'legacy'},
		});
		await Promise.resolve();
		// Runner-keyed frame goes to its own bucket — runs concurrently.
		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_r1',
			runnerId: 'r1',
			runSpec: {prompt: 'r1'},
		});
		await Promise.resolve();
		// A second legacy frame hits the legacy bucket cap — rejected.
		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_legacy_2',
			runSpec: {prompt: 'legacy 2'},
		});
		await Promise.resolve();

		expect(executor).toHaveBeenCalledTimes(2);
		const runs = daemon.listRuns();
		expect(runs.find(r => r.runId === 'run_legacy')?.status).toBe('running');
		expect(runs.find(r => r.runId === 'run_r1')?.status).toBe('running');
		expect(runs.find(r => r.runId === 'run_legacy_2')?.status).toBe('rejected');
		expect(fake.calls.assignmentRejected).toContainEqual({
			runId: 'run_legacy_2',
			reason: 'local_capacity',
			message: expect.stringContaining('concurrency cap'),
		});

		for (const resolve of resolvers.values()) resolve();
		await daemon.stop('test');
	});

	it('rejects a second assignment for the same runner when its cap is full', async () => {
		const fake = makeFakeSocket();
		let resolveFirst: () => void = () => {};
		const executor = vi.fn(async () => {
			await new Promise<void>(resolve => {
				resolveFirst = resolve;
			});
		});

		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'a',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: executor,
			reconnectDelaysMs: [],
			maxConcurrentRuns: 1,
		});

		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_a1',
			runnerId: 'r1',
			runSpec: {prompt: 'a'},
		});
		await Promise.resolve();
		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_a2',
			runnerId: 'r1',
			runSpec: {prompt: 'b'},
		});
		await Promise.resolve();

		expect(executor).toHaveBeenCalledTimes(1);
		const runs = daemon.listRuns();
		expect(runs.find(r => r.runId === 'run_a2')?.status).toBe('rejected');
		expect(fake.calls.assignmentRejected).toContainEqual({
			runId: 'run_a2',
			reason: 'local_capacity',
			message: expect.stringContaining('concurrency cap'),
		});

		resolveFirst();
		await daemon.stop('test');
	});

	it('rejects assignments over the concurrency cap', async () => {
		const fake = makeFakeSocket();
		let resolveFirst: () => void = () => {};
		const executor = vi.fn(async () => {
			await new Promise<void>(resolve => {
				resolveFirst = resolve;
			});
		});

		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'a',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: executor,
			reconnectDelaysMs: [],
			maxConcurrentRuns: 1,
		});

		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_1',
			runSpec: {prompt: 'first'},
		});
		await Promise.resolve();
		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_2',
			runSpec: {prompt: 'second'},
		});
		await Promise.resolve();

		// Only the first ran; second was rejected via assignment_rejected.
		expect(executor).toHaveBeenCalledTimes(1);

		const runs = daemon.listRuns();
		expect(runs.find(r => r.runId === 'run_2')?.status).toBe('rejected');
		expect(fake.calls.assignmentRejected).toContainEqual({
			runId: 'run_2',
			reason: 'local_capacity',
			message: expect.stringContaining('concurrency cap'),
		});

		resolveFirst();
		await daemon.stop('test');
	});

	it('schedules a proactive refresh at expiresInSec - leadSec', async () => {
		vi.useFakeTimers();
		try {
			const fake = makeFakeSocket();
			const refresh = vi
				.fn()
				.mockResolvedValueOnce({
					instanceId: 'inst_1',
					accessToken: 'first',
					expiresInSec: 200,
				})
				.mockResolvedValueOnce({
					instanceId: 'inst_1',
					accessToken: 'second',
					expiresInSec: 200,
				});

			const daemon = await runDashboardRuntimeDaemon({
				readConfig: () => stored,
				refreshAccessToken: refresh,
				makeInstanceSocketClient: () => fake.client,
				executeRemoteAssignment: vi.fn(async () => {}),
				reconnectDelaysMs: [],
				refreshLeadSec: 60,
			});

			expect(refresh).toHaveBeenCalledTimes(1);
			// Lead = 60s, expires = 200s → fires at 140s.
			await vi.advanceTimersByTimeAsync(140_000);
			expect(refresh).toHaveBeenCalledTimes(2);

			await daemon.stop('test');
		} finally {
			vi.useRealTimers();
		}
	});

	it('exposes a snapshot for the UDS handler', async () => {
		const fake = makeFakeSocket();
		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'a',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: vi.fn(async () => {}),
			reconnectDelaysMs: [],
		});
		const snap = daemon.snapshot();
		expect(snap).toMatchObject({
			socketConnected: true,
			activeRuns: 0,
			completedRuns: 0,
			instanceId: 'inst_1',
			dashboardUrl: 'https://example.com',
		});
		await daemon.stop('test');
	});

	it('exposes refresh circuit-breaker state in the snapshot', async () => {
		const fake = makeFakeSocket();
		// First call succeeds (initial connect). Subsequent refreshes fail and
		// trip the breaker after refreshFailureLimit consecutive failures.
		let calls = 0;
		const refresh = vi.fn(async () => {
			calls += 1;
			if (calls === 1) {
				return {
					instanceId: 'inst_1',
					accessToken: 'a',
					expiresInSec: 900,
				};
			}
			throw new Error('refresh denied');
		});

		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: refresh,
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: vi.fn(async () => {}),
			// Small but non-zero so the reconnect loop yields between attempts.
			reconnectDelaysMs: [5],
			refreshFailureLimit: 3,
			refreshFailureWindowMs: 60_000,
			refreshCooldownMs: 60_000,
		});

		// Trigger reconnects so refresh fires repeatedly.
		fake.emitClose('test');
		await vi.waitFor(
			() => {
				const snap = daemon.snapshot();
				expect(snap.refreshState?.cooldownUntilMs).toBeGreaterThan(0);
			},
			{timeout: 2_000, interval: 25},
		);

		// Stop before the test ends so the cooldown sleep doesn't keep node alive.
		await daemon.stop('test');
	});

	it('sends assignment_rejected when local capacity rejects a dashboard assignment', async () => {
		const fake = makeFakeSocket();
		const logs: Array<{level: string; message: string}> = [];
		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'a',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: vi.fn(
				async (input: {abortSignal?: AbortSignal}) => {
					await new Promise<void>(resolve => {
						input.abortSignal?.addEventListener('abort', () => resolve());
					});
				},
			),
			reconnectDelaysMs: [],
			maxConcurrentRuns: 1,
			log: (level, message) => logs.push({level, message}),
		});

		// First fills the cap.
		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_1',
			runSpec: {prompt: 'first'},
		});
		await Promise.resolve();
		// Second is rejected through the assignment admission protocol.
		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_2',
			runSpec: {prompt: 'second'},
		});
		await Promise.resolve();

		expect(logs).not.toContainEqual(
			expect.objectContaining({
				message: expect.stringContaining('failed to send rejected for run_2'),
			}),
		);
		expect(fake.calls.assignmentRejected).toContainEqual({
			runId: 'run_2',
			reason: 'local_capacity',
			message: expect.stringContaining('concurrency cap'),
		});

		await daemon.stop('test');
	});

	it('listRuns applies limit before active filter', async () => {
		const fake = makeFakeSocket();
		const executors: Array<() => void> = [];
		const executor = vi.fn(async () => {
			await new Promise<void>(resolve => executors.push(resolve));
		});

		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'a',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: executor,
			reconnectDelaysMs: [],
			maxConcurrentRuns: 5,
		});

		// Start 3 runs, complete the first.
		for (let i = 0; i < 3; i += 1) {
			fake.emitFrame({
				type: 'job_assignment',
				runId: `run_${i}`,
				runSpec: {prompt: 'x'},
			});
		}
		await Promise.resolve();
		executors[0]?.(); // resolve run_0 → completed
		await Promise.resolve();
		await Promise.resolve();

		// Limit 2 → last 2 records (run_1, run_2). With active filter, both run_1
		// and run_2 are still running, so we get 2.
		const limited = daemon.listRuns({active: true, limit: 2});
		expect(limited).toHaveLength(2);
		expect(limited.map(r => r.runId)).toEqual(['run_1', 'run_2']);

		// Resolve the rest so stop can drain.
		for (const resolve of executors) resolve();
		await daemon.stop('test');
	});

	it('reconnects after an unsolicited socket close', async () => {
		const first = makeFakeSocket();
		const second = makeFakeSocket();
		const sockets = [first.client, second.client];
		const refreshAccessToken = vi
			.fn()
			.mockResolvedValueOnce({
				instanceId: 'inst_1',
				accessToken: 'access_1',
				expiresInSec: 900,
			})
			.mockResolvedValueOnce({
				instanceId: 'inst_1',
				accessToken: 'access_2',
				expiresInSec: 900,
			});

		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken,
			makeInstanceSocketClient: () => sockets.shift() ?? second.client,
			executeRemoteAssignment: vi.fn(async () => {}),
			reconnectDelaysMs: [0],
		});

		first.emitClose('network dropped');
		await vi.waitFor(() => expect(refreshAccessToken).toHaveBeenCalledTimes(2));
		expect(first.calls.connect).toBe(1);
		expect(second.calls.connect).toBe(1);

		await daemon.stop('test');
	});

	it('stays alive and retries when the initial instance socket connect fails', async () => {
		vi.useFakeTimers();
		try {
			const first = makeFakeSocket();
			const second = makeFakeSocket();
			first.client.connect = async () => {
				first.calls.connect += 1;
				throw new Error('Unexpected server response: 500');
			};
			const sockets = [first.client, second.client];
			const logs: Array<{level: string; message: string}> = [];
			const refreshAccessToken = vi
				.fn()
				.mockResolvedValueOnce({
					instanceId: 'inst_1',
					accessToken: 'access_1',
					expiresInSec: 900,
				})
				.mockResolvedValueOnce({
					instanceId: 'inst_1',
					accessToken: 'access_2',
					expiresInSec: 900,
				});

			const daemon = await runDashboardRuntimeDaemon({
				readConfig: () => stored,
				refreshAccessToken,
				makeInstanceSocketClient: () => sockets.shift() ?? second.client,
				executeRemoteAssignment: vi.fn(async () => {}),
				reconnectDelaysMs: [100],
				log: (level, message) => logs.push({level, message}),
			});

			expect(daemon.snapshot()).toMatchObject({
				socketConnected: false,
				activeRuns: 0,
				completedRuns: 0,
			});
			expect(logs).toContainEqual({
				level: 'warn',
				message:
					'dashboard runtime daemon initial connect failed: Unexpected server response: 500',
			});

			await vi.advanceTimersByTimeAsync(100);
			await vi.waitFor(() =>
				expect(refreshAccessToken).toHaveBeenCalledTimes(2),
			);
			expect(second.calls.connect).toBe(1);
			expect(daemon.snapshot()).toMatchObject({
				socketConnected: true,
				instanceId: 'inst_1',
				dashboardUrl: 'https://example.com',
			});

			await daemon.stop('test');
		} finally {
			vi.useRealTimers();
		}
	});
});
