import {describe, it, expect, vi} from 'vitest';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {ChildProcess} from 'node:child_process';
import type {
	Runtime,
	RuntimeDecision,
	RuntimeDecisionHandler,
	RuntimeEvent,
	RuntimeEventHandler,
} from '../../core/runtime/types';
import type {FeedEvent} from '../../core/feed/types';
import {runExec} from './runner';
import {RUN_EXIT_CODE} from './types';
import {createSteerQueue, STEER_BLOCK_OPEN} from '../../core/workflows/steer';
import type {DashboardDecisionInboxRow} from '../dashboard/dashboardDecisionInbox';
import {
	createSessionStore,
	getLatestRunForSession,
	listAwaitingAttentionRuns,
} from '../../infra/sessions';
import {runRunsCommand} from '../entry/runsCommand';
import {
	serializeRunMemory,
	wakesFreshAfterHandover,
	type RunMemory,
} from '../../core/workflows/runMachine';

class MockRuntime implements Runtime {
	private eventHandlers = new Set<RuntimeEventHandler>();
	private decisionHandlers = new Set<RuntimeDecisionHandler>();
	private status: 'stopped' | 'running' = 'stopped';
	public decisions: Array<{eventId: string; decision: RuntimeDecision}> = [];

	start(): Promise<void> {
		this.status = 'running';
		return Promise.resolve();
	}

	stop(): void {
		this.status = 'stopped';
	}

	getStatus(): 'stopped' | 'running' {
		return this.status;
	}

	getLastError() {
		return null;
	}

	onEvent(handler: RuntimeEventHandler): () => void {
		this.eventHandlers.add(handler);
		return () => this.eventHandlers.delete(handler);
	}

	onDecision(handler: RuntimeDecisionHandler): () => void {
		this.decisionHandlers.add(handler);
		return () => this.decisionHandlers.delete(handler);
	}

	sendDecision(eventId: string, decision: RuntimeDecision): void {
		this.decisions.push({eventId, decision});
		for (const handler of this.decisionHandlers) {
			handler(eventId, decision);
		}
	}

	emit(event: RuntimeEvent): void {
		for (const handler of this.eventHandlers) {
			handler(event);
		}
	}
}

type SpawnArgs = Parameters<
	NonNullable<Parameters<typeof runExec>[0]['spawnProcess']>
>[0];

function makeRuntimeEvent(partial: Partial<RuntimeEvent>): RuntimeEvent {
	return {
		id: partial.id ?? 'evt-1',
		timestamp: partial.timestamp ?? Date.now(),
		kind: partial.kind ?? 'notification',
		data: partial.data ?? {},
		hookName: partial.hookName ?? 'Notification',
		sessionId: partial.sessionId ?? 'adapter-session',
		toolName: partial.toolName,
		toolUseId: partial.toolUseId,
		agentId: partial.agentId,
		agentType: partial.agentType,
		context: partial.context ?? {cwd: '/tmp', transcriptPath: '/tmp/t.jsonl'},
		interaction: partial.interaction ?? {expectsDecision: false},
		payload: partial.payload ?? {},
	};
}

function makeChildProcess(onKill?: () => void): ChildProcess {
	const child = new EventEmitter() as ChildProcess;
	child.kill = vi.fn().mockImplementation(() => {
		onKill?.();
		return true;
	});
	return child;
}

function createWriteCapture() {
	let value = '';
	return {
		writer: {
			write(chunk: string) {
				value += chunk;
			},
		},
		read: () => value,
	};
}

type ExecJsonlEvent = {type: string; data: Record<string, unknown>};

function parseJsonl(text: string): ExecJsonlEvent[] {
	return text
		.split('\n')
		.filter(line => line.trim().length > 0)
		.map(line => JSON.parse(line) as ExecJsonlEvent);
}

describe('runExec', () => {
	it('returns success and prints final message in human mode', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();

			setImmediate(() => {
				runtime.emit(
					makeRuntimeEvent({kind: 'session.start', hookName: 'SessionStart'}),
				);
				opts.onStdout?.(
					JSON.stringify({
						type: 'message',
						role: 'assistant',
						content: [{type: 'text', text: 'done message'}],
					}) + '\n',
				);
				opts.onExit?.(0);
			});

			return child;
		};

		const result = await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			ephemeral: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess,
		});

		expect(result.success).toBe(true);
		expect(result.exitCode).toBe(RUN_EXIT_CODE.SUCCESS);
		expect(result.finalMessage).toBe('done message');
		expect(stdout.read()).toContain('done message');
		expect(stderr.read()).not.toContain('error');
	});

	function makeQuietSpawn(runtime: MockRuntime) {
		return (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();
			setImmediate(() => {
				runtime.emit(
					makeRuntimeEvent({kind: 'session.start', hookName: 'SessionStart'}),
				);
				opts.onStdout?.(
					JSON.stringify({
						type: 'message',
						role: 'assistant',
						content: [{type: 'text', text: 'done'}],
					}) + '\n',
				);
				opts.onExit?.(0);
			});
			return child;
		};
	}

	it('emits personal capabilities in the exec.started JSON event', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			ephemeral: true,
			json: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess: makeQuietSpawn(runtime),
			personalCapabilities: {
				mcpServers: [{name: 'db', sourceLayer: 'project'}],
				skills: [{name: 'greet', sourceLayer: 'global'}],
			},
		});

		const startedLine = stdout
			.read()
			.split('\n')
			.filter(Boolean)
			.map(line => JSON.parse(line))
			.find(event => event.type === 'exec.started');
		expect(startedLine).toBeDefined();
		expect(startedLine.data.personalCapabilities).toEqual({
			mcpServers: [{name: 'db', sourceLayer: 'project'}],
			skills: [{name: 'greet', sourceLayer: 'global'}],
		});
	});

	it('emits empty personal capability arrays in exec.started when none configured', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			ephemeral: true,
			json: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess: makeQuietSpawn(runtime),
		});

		const startedLine = stdout
			.read()
			.split('\n')
			.filter(Boolean)
			.map(line => JSON.parse(line))
			.find(event => event.type === 'exec.started');
		expect(startedLine.data.personalCapabilities).toEqual({
			mcpServers: [],
			skills: [],
		});
	});

	it('prints a human-facing personal capabilities notice in non-json mode', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			ephemeral: true,
			json: false,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess: makeQuietSpawn(runtime),
			personalCapabilities: {
				mcpServers: [{name: 'db', sourceLayer: 'project'}],
				skills: [{name: 'greet', sourceLayer: 'global'}],
			},
		});

		const err = stderr.read();
		expect(err.toLowerCase()).toContain('personal');
		expect(err).toContain('db [project]');
		expect(err).toContain('greet [global]');
	});

	it('stays silent about personal capabilities when none are configured', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			ephemeral: true,
			json: false,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess: makeQuietSpawn(runtime),
		});

		expect(stderr.read().toLowerCase()).not.toContain('personal');
	});

	it('emits capability conflicts in the exec.started JSON event (AC5)', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			ephemeral: true,
			json: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess: makeQuietSpawn(runtime),
			capabilityConflicts: {
				mcpServers: [{name: 'shared-mcp', sourceLayer: 'global'}],
				skills: [{name: 'shared-skill', sourceLayer: 'project'}],
			},
		});

		const startedLine = stdout
			.read()
			.split('\n')
			.filter(Boolean)
			.map(line => JSON.parse(line))
			.find(event => event.type === 'exec.started');
		expect(startedLine.data.capabilityConflicts).toEqual({
			mcpServers: [{name: 'shared-mcp', sourceLayer: 'global'}],
			skills: [{name: 'shared-skill', sourceLayer: 'project'}],
		});
	});

	it('emits empty capability conflict arrays in exec.started when none (AC5 none)', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			ephemeral: true,
			json: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess: makeQuietSpawn(runtime),
		});

		const startedLine = stdout
			.read()
			.split('\n')
			.filter(Boolean)
			.map(line => JSON.parse(line))
			.find(event => event.type === 'exec.started');
		expect(startedLine.data.capabilityConflicts).toEqual({
			mcpServers: [],
			skills: [],
		});
	});

	it('prints a human-facing conflict warning notice in non-json mode (AC6)', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			ephemeral: true,
			json: false,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess: makeQuietSpawn(runtime),
			capabilityConflicts: {
				mcpServers: [{name: 'shared-mcp', sourceLayer: 'global'}],
				skills: [{name: 'shared-skill', sourceLayer: 'project'}],
			},
		});

		const err = stderr.read();
		expect(err.toLowerCase()).toContain('conflict');
		expect(err.toLowerCase()).toContain('workflow plugin');
		expect(err).toContain('shared-mcp [global]');
		expect(err).toContain('shared-skill [project]');
	});

	it('stays silent about conflicts when there are none (AC6 none)', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			ephemeral: true,
			json: false,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess: makeQuietSpawn(runtime),
		});

		expect(stderr.read().toLowerCase()).not.toContain('conflict');
	});

	it('publishes mapped feed events to the dashboard feed publisher', async () => {
		const runtime = new MockRuntime();
		const dashboardFeedPublisher = {
			publish: vi.fn(),
		};

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();
			setImmediate(() => {
				runtime.emit(
					makeRuntimeEvent({
						id: 'notice-1',
						kind: 'notification',
						hookName: 'Notification',
						data: {message: 'synced'},
					}),
				);
				opts.onExit?.(0);
			});
			return child;
		};

		await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			athenaSessionId: 'athena-1',
			isolationConfig: {},
			ephemeral: true,
			runtimeFactory: () => runtime,
			spawnProcess,
			dashboardFeedPublisher,
		});

		expect(dashboardFeedPublisher.publish).toHaveBeenCalledWith(
			expect.objectContaining({
				origin: 'local',
				athenaSessionId: 'athena-1',
				feedEvents: expect.arrayContaining([
					expect.objectContaining({
						kind: 'notification',
						data: {message: 'synced'},
					}),
				]),
			}),
		);
	});

	it('publishes pre-completion artifact manifest feed events', async () => {
		const runtime = new MockRuntime();
		const dashboardFeedPublisher = {
			publish: vi.fn(),
		};
		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();
			setImmediate(() => {
				opts.onStdout?.(
					JSON.stringify({
						type: 'message',
						role: 'assistant',
						content: [{type: 'text', text: 'done'}],
					}) + '\n',
				);
				opts.onExit?.(0);
			});
			return child;
		};

		const result = await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			athenaSessionId: 'athena-1',
			isolationConfig: {},
			ephemeral: true,
			runtimeFactory: () => runtime,
			spawnProcess,
			dashboardFeedPublisher,
			beforeTerminalCompletion: async ({result: hookResult}) => [
				{
					event_id: 'artifacts-1',
					seq: 99,
					ts: 100,
					session_id: hookResult.athenaSessionId ?? 'missing',
					run_id: 'run-1',
					kind: 'artifacts.manifest',
					level: 'info',
					actor_id: 'system',
					title: 'Artifacts manifest',
					data: {manifest: {entries: []}},
				},
			],
		});

		expect(result.success).toBe(true);
		expect(dashboardFeedPublisher.publish).toHaveBeenCalledWith(
			expect.objectContaining({
				origin: 'local',
				athenaSessionId: 'athena-1',
				feedEvents: [
					expect.objectContaining({
						kind: 'artifacts.manifest',
						data: {manifest: {entries: []}},
					}),
				],
			}),
		);
	});

	it('publishes pre-completion artifact manifests before terminal session feed events', async () => {
		const order: string[] = [];
		const runtime = Object.assign(new MockRuntime(), {
			sendPrompt: vi.fn(async () => {}),
			sendInterrupt: vi.fn(() => {
				order.push('kill');
			}),
		});
		const dashboardFeedPublisher = {
			publish: vi.fn(),
		};

		const result = await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'openai-codex',
			athenaSessionId: 'athena-1',
			isolationConfig: {},
			ephemeral: true,
			runtimeFactory: () => runtime,
			dashboardFeedPublisher,
			beforeTerminalCompletion: async ({result: hookResult}) => {
				order.push('artifact');
				return [
					{
						event_id: 'artifacts-1',
						seq: 99,
						ts: 100,
						session_id: hookResult.athenaSessionId ?? 'missing',
						run_id: 'run-1',
						kind: 'artifacts.manifest',
						level: 'info',
						actor_id: 'system',
						title: 'Artifacts manifest',
						data: {manifest: {entries: []}},
					},
				];
			},
		});

		expect(result.success).toBe(true);
		expect(order).toEqual(['artifact', 'kill']);
	});

	it('fails execution when pre-completion artifact upload fails', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();
		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();
			setImmediate(() => {
				opts.onStdout?.(
					JSON.stringify({
						type: 'message',
						role: 'assistant',
						content: [{type: 'text', text: 'done'}],
					}) + '\n',
				);
				opts.onExit?.(0);
			});
			return child;
		};

		const result = await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			ephemeral: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess,
			beforeTerminalCompletion: async () => {
				throw new Error('upload denied');
			},
		});

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(RUN_EXIT_CODE.OUTPUT);
		expect(result.failure?.message).toContain('upload denied');
		expect(stdout.read()).not.toContain('done');
		expect(stderr.read()).toContain('Artifact upload failed');
	});

	it('does not publish artifact manifests when writing the final message fails', async () => {
		const runtime = new MockRuntime();
		const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-output-'));
		const beforeTerminalCompletion = vi.fn(async () => []);
		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();
			setImmediate(() => {
				opts.onStdout?.(
					JSON.stringify({
						type: 'message',
						role: 'assistant',
						content: [{type: 'text', text: 'done'}],
					}) + '\n',
				);
				opts.onExit?.(0);
			});
			return child;
		};

		const result = await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			ephemeral: true,
			runtimeFactory: () => runtime,
			spawnProcess,
			outputLastMessagePath: outputDir,
			beforeTerminalCompletion,
		});

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(RUN_EXIT_CODE.OUTPUT);
		expect(result.failure?.message).toContain(
			'Failed writing --output-last-message',
		);
		expect(beforeTerminalCompletion).not.toHaveBeenCalled();
	});

	it('cancels via abort signal while a permission request is pending and returns runtime exit code', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		const abortController = new AbortController();

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess(() => {
				opts.onExit?.(null);
			});

			setImmediate(() => {
				runtime.emit(
					makeRuntimeEvent({
						id: 'perm-cancel',
						kind: 'permission.request',
						hookName: 'PermissionRequest',
						toolName: 'Bash',
						interaction: {expectsDecision: true},
						data: {tool_name: 'Bash'},
					}),
				);
				setImmediate(() => abortController.abort());
			});

			return child;
		};

		const result = await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			ephemeral: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess,
			signal: abortController.signal,
		});

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(RUN_EXIT_CODE.RUNTIME);
		expect(result.failure?.kind).toBe('process');
		expect(result.failure?.message).toBe('Execution cancelled.');
		expect(runtime.decisions.length).toBe(0);
	});

	it('times out waiting for a pending permission decision when no hub is attached', async () => {
		vi.useFakeTimers();
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess(() => {
				opts.onExit?.(null);
			});
			setImmediate(() => {
				runtime.emit(
					makeRuntimeEvent({
						id: 'perm-timeout',
						kind: 'permission.request',
						hookName: 'PermissionRequest',
						toolName: 'Bash',
						interaction: {expectsDecision: true},
						data: {tool_name: 'Bash'},
					}),
				);
			});
			return child;
		};

		try {
			const runPromise = runExec({
				prompt: 'hello',
				projectDir: '/tmp',
				harness: 'claude-code',
				isolationConfig: {},
				timeoutMs: 50,
				ephemeral: true,
				stdout: stdout.writer,
				stderr: stderr.writer,
				runtimeFactory: () => runtime,
				spawnProcess,
			});

			await vi.advanceTimersByTimeAsync(60);
			const result = await runPromise;

			expect(result.success).toBe(false);
			expect(result.exitCode).toBe(RUN_EXIT_CODE.TIMEOUT);
			expect(result.failure?.kind).toBe('timeout');
			expect(runtime.decisions.length).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('applies pending dashboard decisions for the active Athena session', async () => {
		const runtime = new MockRuntime();
		const dashboardDecisionInbox = {
			pendingForSession: vi.fn(() => [
				{
					id: 1,
					athenaSessionId: 'athena-1',
					requestId: 'req-dashboard',
					decision: {
						type: 'json' as const,
						source: 'user' as const,
						intent: {kind: 'permission_allow' as const},
					},
					receivedAt: 123,
				},
			]),
			markConsumed: vi.fn(),
			enqueue: vi.fn(),
			close: vi.fn(),
		};

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();
			setImmediate(() => {
				opts.onExit?.(0);
			});
			return child;
		};

		await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			athenaSessionId: 'athena-1',
			isolationConfig: {},
			ephemeral: true,
			runtimeFactory: () => runtime,
			spawnProcess,
			dashboardDecisionInbox,
			dashboardDecisionPollIntervalMs: 5,
		});

		expect(dashboardDecisionInbox.pendingForSession).toHaveBeenCalledWith({
			athenaSessionId: 'athena-1',
			limit: 25,
		});
		expect(runtime.decisions).toContainEqual({
			eventId: 'req-dashboard',
			decision: {
				type: 'json',
				source: 'user',
				intent: {kind: 'permission_allow'},
			},
		});
		expect(dashboardDecisionInbox.markConsumed).toHaveBeenCalledWith({id: 1});
	});

	it('returns timeout exit code when execution exceeds timeout', async () => {
		vi.useFakeTimers();
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess(() => {
				opts.onExit?.(null);
			});
			return child;
		};

		try {
			const runPromise = runExec({
				prompt: 'hello',
				projectDir: '/tmp',
				harness: 'claude-code',
				isolationConfig: {},
				timeoutMs: 10,
				ephemeral: true,
				stdout: stdout.writer,
				stderr: stderr.writer,
				runtimeFactory: () => runtime,
				spawnProcess,
			});

			await vi.advanceTimersByTimeAsync(20);
			const result = await runPromise;

			expect(result.success).toBe(false);
			expect(result.exitCode).toBe(RUN_EXIT_CODE.TIMEOUT);
			expect(result.failure?.kind).toBe('timeout');
			expect(stderr.read()).toContain('timed out');
		} finally {
			vi.useRealTimers();
		}
	});

	it('preserves the tracker file when a workflow loop reaches a terminal state', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();
		const projectDir = '/tmp/runner-terminal-project';
		const trackerPath = `${projectDir}/.athena/session-1.md`;
		fs.mkdirSync(`${projectDir}/.athena`, {recursive: true});
		fs.writeFileSync(trackerPath, '<!-- DONE -->', 'utf-8');

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();

			setImmediate(() => {
				opts.onStdout?.(
					JSON.stringify({
						type: 'message',
						role: 'assistant',
						content: [{type: 'text', text: 'done message'}],
					}) + '\n',
				);
				opts.onExit?.(0);
			});

			return child;
		};

		try {
			const result = await runExec({
				prompt: 'hello',
				projectDir,
				harness: 'claude-code',
				athenaSessionId: 'session-1',
				isolationConfig: {},
				ephemeral: true,
				stdout: stdout.writer,
				stderr: stderr.writer,
				runtimeFactory: () => runtime,
				spawnProcess,
				workflow: {
					name: 'test-loop',
					plugins: [],
					promptTemplate: '{input}',
					loop: {
						enabled: true,
						completionMarker: '<!-- DONE -->',
						maxIterations: 5,
						trackerPath: '.athena/{sessionId}.md',
					},
				},
			});

			expect(result.success).toBe(true);
			expect(fs.existsSync(trackerPath)).toBe(true);
		} finally {
			fs.rmSync(projectDir, {recursive: true, force: true});
		}
	});

	it('persists the vendor session id observed on hook events onto the workflow run', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();
		const projectDir = '/tmp/runner-vendor-id-project';
		const trackerPath = `${projectDir}/.athena/session-1.md`;
		fs.mkdirSync(`${projectDir}/.athena`, {recursive: true});
		// Seeded WITHOUT a Terminal Marker: a Run starting against an already
		// terminal Tracker has those markers demoted, since no Run inherits a
		// predecessor's verdict. The agent declares completion below instead.
		fs.writeFileSync(trackerPath, '# Tracker\n', 'utf-8');

		const {createSessionStore} = await import('../../infra/sessions');
		const snapshots: Array<{status: string; adapterSessionId?: string}> = [];

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();

			setImmediate(() => {
				// A hook event arrives carrying the vendor session id.
				runtime.emit(
					makeRuntimeEvent({
						id: 'evt-notif',
						kind: 'notification',
						sessionId: 'claude-sess-abc',
					}),
				);
				opts.onStdout?.(
					JSON.stringify({
						type: 'message',
						role: 'assistant',
						content: [{type: 'text', text: 'done message'}],
					}) + '\n',
				);
				fs.writeFileSync(trackerPath, '<!-- DONE -->', 'utf-8');
				opts.onExit?.(0);
			});

			return child;
		};

		try {
			const result = await runExec({
				prompt: 'hello',
				projectDir,
				harness: 'claude-code',
				athenaSessionId: 'session-1',
				isolationConfig: {},
				ephemeral: true,
				stdout: stdout.writer,
				stderr: stderr.writer,
				runtimeFactory: () => runtime,
				spawnProcess,
				sessionStoreFactory: opts => {
					const store = createSessionStore(opts);
					const originalPersistRun = store.persistRun.bind(store);
					return {
						...store,
						persistRun(snapshot) {
							snapshots.push({
								status: snapshot.status,
								adapterSessionId: snapshot.adapterSessionId,
							});
							originalPersistRun(snapshot);
						},
					};
				},
				workflow: {
					name: 'test-loop',
					plugins: [],
					promptTemplate: '{input}',
					loop: {
						enabled: true,
						completionMarker: '<!-- DONE -->',
						maxIterations: 5,
						trackerPath: '.athena/{sessionId}.md',
					},
				},
			});

			expect(result.success).toBe(true);
			const final = snapshots.at(-1);
			expect(final).toEqual({
				status: 'completed',
				adapterSessionId: 'claude-sess-abc',
			});
		} finally {
			fs.rmSync(projectDir, {recursive: true, force: true});
		}
	});

	it('orchestrates a Handover: blocks compaction, forks for the Handoff file, reseeds fresh', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-ho-'));
		const trackerDir = path.join(projectDir, '.athena', 'session-ho');
		fs.mkdirSync(trackerDir, {recursive: true});
		const trackerPath = path.join(trackerDir, 'tracker.md');
		// The Handoff chain starts at 001 (ADR 0014 §5).
		const handoffPath = path.join(trackerDir, 'handoff', '001.md');

		const spawns: SpawnArgs[] = [];
		const spawnProcess = vi.fn((opts: SpawnArgs): ChildProcess => {
			spawns.push(opts);
			const spawnIndex = spawns.length;
			const child = makeChildProcess(() => {
				// The exec runner kills the primary Turn to hand over.
				opts.onExit?.(143);
			});

			setImmediate(() => {
				if (spawnIndex === 1) {
					// Primary Turn: works, then crosses the token bound — the
					// harness announces compaction on this Agent Session.
					fs.writeFileSync(trackerPath, 'deep in work', 'utf-8');
					runtime.emit(
						makeRuntimeEvent({
							id: 'evt-precompact',
							kind: 'compact.pre',
							hookName: 'PreCompact',
							sessionId: 'claude-sess-primary',
							interaction: {
								expectsDecision: true,
								defaultTimeoutMs: 4000,
								canBlock: true,
							},
						}),
					);
					// The kill callback ends this turn via opts.onExit(143).
				} else if (spawnIndex === 2) {
					// The fork: writes the Handoff file and exits cleanly.
					fs.mkdirSync(path.dirname(handoffPath), {recursive: true});
					fs.writeFileSync(handoffPath, '# Handoff\nstate', 'utf-8');
					opts.onExit?.(0);
				} else {
					// Post-Handover fresh Turn: completes the workflow.
					fs.writeFileSync(trackerPath, '<!-- DONE -->', 'utf-8');
					opts.onStdout?.(
						JSON.stringify({
							type: 'message',
							role: 'assistant',
							content: [{type: 'text', text: 'done after handover'}],
						}) + '\n',
					);
					opts.onExit?.(0);
				}
			});

			return child;
		});

		try {
			const result = await runExec({
				prompt: 'big task',
				projectDir,
				harness: 'claude-code',
				athenaSessionId: 'session-ho',
				isolationConfig: {},
				ephemeral: true,
				stdout: stdout.writer,
				stderr: stderr.writer,
				runtimeFactory: () => runtime,
				spawnProcess,
				workflow: {
					name: 'test-loop',
					plugins: [],
					promptTemplate: '{input}',
					loop: {
						enabled: true,
						completionMarker: '<!-- DONE -->',
						maxIterations: 5,
						trackerPath: '.athena/{sessionId}/tracker.md',
					},
				},
			});

			expect(result.success).toBe(true);
			expect(result.exitCode).toBe(RUN_EXIT_CODE.SUCCESS);

			// The compaction was answered with a block decision.
			const blockDecision = runtime.decisions.find(
				d => d.eventId === 'evt-precompact',
			);
			expect(blockDecision?.decision.intent).toEqual({
				kind: 'compact_block',
				reason: expect.stringContaining('Handover'),
			});

			// Spawn 2 is the fork: resumes the primary session with --fork-session
			// (surfaced via isolation.forkSession) and invokes the handoff skill.
			expect(spawns).toHaveLength(3);
			expect(spawns[1]!.sessionId).toBe('claude-sess-primary');
			expect(
				(spawns[1]!.isolation as {forkSession?: boolean}).forkSession,
			).toBe(true);
			expect(spawns[1]!.prompt).toContain('handoff skill');

			// Spawn 3 is the fresh post-Handover Turn seeded with file + Tracker.
			expect(spawns[2]!.sessionId).toBeUndefined();
			expect(spawns[2]!.prompt).toContain('Handover occurred');
			expect(spawns[2]!.prompt).toContain(handoffPath);

			expect(stderr.read()).toContain('handover: context bound reached');
		} finally {
			fs.rmSync(projectDir, {recursive: true, force: true});
		}
	});

	describe('the Handover is budgeted and observable (ADR 0018 §4, §8, §9)', () => {
		type HandoverJsonlEvent = {
			type: string;
			data: {iteration?: number} & Record<string, unknown>;
		};

		function parseJsonl(text: string): HandoverJsonlEvent[] {
			return text
				.split('\n')
				.filter(line => line.trim().length > 0)
				.map(line => JSON.parse(line) as HandoverJsonlEvent);
		}

		function makeSessionsRoot(): string {
			return fs.mkdtempSync(path.join(os.tmpdir(), 'runner-ho-sessions-'));
		}

		function storeFactoryAt(sessionsRoot: string) {
			return (opts: {sessionId: string; projectDir: string}) =>
				createSessionStore({
					...opts,
					dbPath: path.join(sessionsRoot, opts.sessionId, 'session.db'),
				});
		}

		function memoryOf(overrides: Partial<RunMemory>): RunMemory {
			return {
				iteration: 1,
				nudgeStreak: 0,
				retryStreak: 0,
				lastJournalHash: null,
				lastStopPrompt: 'big task',
				lastStopContinuation: {mode: 'fresh'},
				pendingSteers: [],
				lastHandoffSizeBytes: null,
				parkedAfterHandover: false,
				...overrides,
			};
		}

		/**
		 * Spawn choreography for a Run whose first Turn hands over: spawn 1 is
		 * the primary Turn (crosses the bound, is killed), spawn 2 the fork
		 * (writes the Handoff file), spawn 3 — when the Run gets that far — the
		 * fresh post-Handover Turn, which completes the workflow.
		 */
		function handoverSpawns(
			runtime: MockRuntime,
			journalPath: string,
			handoffPath: string,
		) {
			const spawns: SpawnArgs[] = [];
			const spawnProcess = vi.fn((opts: SpawnArgs): ChildProcess => {
				spawns.push(opts);
				const spawnIndex = spawns.length;
				const child = makeChildProcess(() => {
					opts.onExit?.(143);
				});
				setImmediate(() => {
					if (spawnIndex === 1) {
						fs.writeFileSync(journalPath, 'deep in work', 'utf-8');
						// The primary Turn's stream: opening context, then the context
						// at the last call before the bound.
						opts.onStdout?.(
							JSON.stringify({
								type: 'assistant',
								message: {
									type: 'message',
									usage: {
										input_tokens: 70_000,
										output_tokens: 10,
										cache_read_input_tokens: 1_400,
									},
								},
							}) + '\n',
						);
						opts.onStdout?.(
							JSON.stringify({
								type: 'assistant',
								message: {
									type: 'message',
									usage: {
										input_tokens: 1_000,
										output_tokens: 10,
										cache_read_input_tokens: 99_000,
									},
								},
							}) + '\n',
						);
						// Two tool calls on this Agent Session before the bound.
						for (const id of ['evt-read-1', 'evt-read-2']) {
							runtime.emit(
								makeRuntimeEvent({
									id,
									kind: 'tool.pre',
									hookName: 'PreToolUse',
									toolName: 'Read',
									sessionId: 'claude-sess-primary',
									data: {tool_name: 'Read', tool_input: {file_path: 'x'}},
								}),
							);
						}
						runtime.emit(
							makeRuntimeEvent({
								id: 'evt-precompact',
								kind: 'compact.pre',
								hookName: 'PreCompact',
								sessionId: 'claude-sess-primary',
								interaction: {
									expectsDecision: true,
									defaultTimeoutMs: 4000,
									canBlock: true,
								},
							}),
						);
					} else if (spawnIndex === 2) {
						fs.mkdirSync(path.dirname(handoffPath), {recursive: true});
						fs.writeFileSync(handoffPath, '# Handoff\nstate', 'utf-8');
						opts.onExit?.(0);
					} else {
						fs.writeFileSync(journalPath, '<!-- DONE -->', 'utf-8');
						opts.onStdout?.(
							JSON.stringify({
								type: 'message',
								role: 'assistant',
								content: [{type: 'text', text: 'done after handover'}],
							}) + '\n',
						);
						opts.onExit?.(0);
					}
				});
				return child;
			});
			return {spawns, spawnProcess};
		}

		it('run.handover carries the iteration it interrupted, and iteration.complete follows the reseed', async () => {
			const runtime = new MockRuntime();
			const stdout = createWriteCapture();
			const stderr = createWriteCapture();
			const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-ho-'));
			const dossier = path.join(projectDir, '.athena', 'session-ho');
			fs.mkdirSync(dossier, {recursive: true});
			const journalPath = path.join(dossier, 'journal.md');
			const handoffPath = path.join(dossier, 'handoff', '001.md');
			const {spawns, spawnProcess} = handoverSpawns(
				runtime,
				journalPath,
				handoffPath,
			);

			try {
				const result = await runExec({
					prompt: 'big task',
					projectDir,
					harness: 'claude-code',
					athenaSessionId: 'session-ho',
					isolationConfig: {},
					ephemeral: true,
					json: true,
					stdout: stdout.writer,
					stderr: stderr.writer,
					runtimeFactory: () => runtime,
					spawnProcess,
					workflow: {
						name: 'test-loop',
						plugins: [],
						promptTemplate: '{input}',
						loop: {
							enabled: true,
							completionMarker: '<!-- DONE -->',
							maxIterations: 5,
							journalPath: '.athena/{sessionId}/journal.md',
						},
					},
				});

				expect(result.success).toBe(true);
				expect(spawns).toHaveLength(3);
				const events = parseJsonl(stdout.read());
				expect(events.find(e => e.type === 'run.handover')?.data).toEqual({
					adapterSessionId: 'claude-sess-primary',
					iteration: 1,
				});
				// The Handover row reports the iteration boundary like a Nudge does:
				// Turn 1 was interrupted, Turn 2 is the fresh post-Handover Turn.
				const completes = events.filter(e => e.type === 'iteration.complete');
				expect(completes.map(e => e.data.iteration)).toEqual([2]);
				// Cumulative tokens ride every iteration boundary (#215).
				expect(completes[0]!.data.tokens).toEqual(
					expect.objectContaining({input: 71_000, output: 20}),
				);
				// The completed Handover, measured (ADR 0018 §8, #213).
				expect(
					events.find(e => e.type === 'run.handover.completed')?.data,
				).toEqual({
					iteration: 1,
					handoffPath,
					handoffSizeBytes: Buffer.byteLength('# Handoff\nstate', 'utf-8'),
					handoffSimilarity: null,
					handoverStreak: 0,
					openingContextTokens: 71_400,
					lastContextTokens: 100_000,
					toolCalls: 2,
					tokens: expect.objectContaining({input: 71_000, output: 20}),
				});
			} finally {
				fs.rmSync(projectDir, {recursive: true, force: true});
			}
		});

		it('parks at the iteration ceiling after a Handover with the Handoff written, marked to wake fresh', async () => {
			const runtime = new MockRuntime();
			const stdout = createWriteCapture();
			const stderr = createWriteCapture();
			const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-ho-'));
			const sessionsRoot = makeSessionsRoot();
			const dossier = path.join(projectDir, '.athena', 'session-ho');
			fs.mkdirSync(dossier, {recursive: true});
			const journalPath = path.join(dossier, 'journal.md');
			const handoffPath = path.join(dossier, 'handoff', '001.md');
			const {spawns, spawnProcess} = handoverSpawns(
				runtime,
				journalPath,
				handoffPath,
			);

			try {
				const result = await runExec({
					prompt: 'big task',
					projectDir,
					harness: 'claude-code',
					athenaSessionId: 'session-ho',
					isolationConfig: {},
					ephemeral: true,
					json: true,
					stdout: stdout.writer,
					stderr: stderr.writer,
					runtimeFactory: () => runtime,
					spawnProcess,
					sessionStoreFactory: storeFactoryAt(sessionsRoot),
					workflow: {
						name: 'test-loop',
						plugins: [],
						promptTemplate: '{input}',
						loop: {
							enabled: true,
							completionMarker: '<!-- DONE -->',
							// Turn 1 is the ceiling: the Handover row must apply it.
							maxIterations: 1,
							journalPath: '.athena/{sessionId}/journal.md',
						},
					},
				});

				// A suspend, not a failure: exit 0, the Run is parked for a person.
				expect(result.success).toBe(true);
				expect(result.exitCode).toBe(RUN_EXIT_CODE.SUCCESS);
				// Primary Turn + fork only — no fresh Turn was seeded past the ceiling.
				expect(spawns).toHaveLength(2);
				// Fork first, then park: the Handoff is on disk for the wake.
				expect(fs.existsSync(handoffPath)).toBe(true);
				const events = parseJsonl(stdout.read());
				expect(
					events.find(e => e.type === 'run.suspended')?.data,
				).toMatchObject({
					status: 'awaiting_attention',
					stopReason:
						'iteration ceiling reached: 1 iteration (maxIterations) used without a terminal marker',
				});
				expect(events.some(e => e.type === 'iteration.complete')).toBe(false);

				const parked = getLatestRunForSession('session-ho', sessionsRoot);
				expect(parked?.status).toBe('awaiting_attention');
				expect(parked?.stopReason).toContain('iteration ceiling reached: 1');
				// The marking the wake honours (ADR 0018 §9).
				expect(wakesFreshAfterHandover(parked?.runMemoryJson)).toBe(true);
			} finally {
				fs.rmSync(projectDir, {recursive: true, force: true});
				fs.rmSync(sessionsRoot, {recursive: true, force: true});
			}
		});

		function seedParkedRun(
			sessionsRoot: string,
			projectDir: string,
			memory: RunMemory,
			stopReason: string,
		): void {
			const seed = createSessionStore({
				sessionId: 'session-ho',
				projectDir,
				dbPath: path.join(sessionsRoot, 'session-ho', 'session.db'),
			});
			seed.persistRun({
				runId: 'run-parked',
				sessionId: 'session-ho',
				workflowName: 'test-loop',
				iteration: memory.iteration,
				maxIterations: 5,
				status: 'awaiting_attention',
				stopReason,
				adapterSessionId: 'claude-sess-bound',
				runMemoryJson: serializeRunMemory(memory),
			});
			seed.close();
		}

		function completingSpawn(journalPath: string) {
			const spawns: SpawnArgs[] = [];
			const spawnProcess = vi.fn((opts: SpawnArgs): ChildProcess => {
				spawns.push(opts);
				const child = makeChildProcess();
				setImmediate(() => {
					fs.writeFileSync(journalPath, 'resumed\n<!-- DONE -->', 'utf-8');
					opts.onStdout?.(
						JSON.stringify({
							type: 'message',
							role: 'assistant',
							content: [{type: 'text', text: 'finished'}],
						}) + '\n',
					);
					opts.onExit?.(0);
				});
				return child;
			});
			return {spawns, spawnProcess};
		}

		async function wakeParkedRun(input: {
			memory: RunMemory;
			stopReason: string;
		}): Promise<{spawns: SpawnArgs[]; journalPath: string; dossier: string}> {
			const runtime = new MockRuntime();
			const stdout = createWriteCapture();
			const stderr = createWriteCapture();
			const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-ho-'));
			const sessionsRoot = makeSessionsRoot();
			const dossier = path.join(projectDir, '.athena', 'session-ho');
			fs.mkdirSync(path.join(dossier, 'handoff'), {recursive: true});
			const journalPath = path.join(dossier, 'journal.md');
			fs.writeFileSync(journalPath, 'parked at the bound', 'utf-8');
			// The chain retains two; the newest is the one a fresh wake must read.
			fs.writeFileSync(path.join(dossier, 'handoff', '001.md'), 'old', 'utf-8');
			fs.writeFileSync(path.join(dossier, 'handoff', '002.md'), 'new', 'utf-8');
			seedParkedRun(sessionsRoot, projectDir, input.memory, input.stopReason);
			const {spawns, spawnProcess} = completingSpawn(journalPath);

			try {
				const result = await runExec({
					prompt: 'carry on',
					projectDir,
					harness: 'claude-code',
					athenaSessionId: 'session-ho',
					resumeRunId: 'run-parked',
					// A caller that did not honour the marking still hands over the
					// bound session; the Runner must not resume it.
					adapterResumeSessionId: 'claude-sess-bound',
					isolationConfig: {},
					ephemeral: true,
					json: true,
					stdout: stdout.writer,
					stderr: stderr.writer,
					runtimeFactory: () => runtime,
					spawnProcess,
					sessionStoreFactory: storeFactoryAt(sessionsRoot),
					workflow: {
						name: 'test-loop',
						plugins: [],
						promptTemplate: '{input}',
						loop: {
							enabled: true,
							completionMarker: '<!-- DONE -->',
							maxIterations: 5,
							journalPath: '.athena/{sessionId}/journal.md',
						},
					},
				});
				expect(result.success).toBe(true);
				expect(spawns).toHaveLength(1);
				return {spawns, journalPath, dossier};
			} finally {
				fs.rmSync(projectDir, {recursive: true, force: true});
				fs.rmSync(sessionsRoot, {recursive: true, force: true});
			}
		}

		it('wakes a Run parked after a Handover into a fresh Agent Session that reads the newest Handoff and the journal', async () => {
			const {spawns, dossier} = await wakeParkedRun({
				memory: memoryOf({iteration: 1, parkedAfterHandover: true}),
				stopReason:
					'iteration ceiling reached: 1 iteration (maxIterations) used without a terminal marker',
			});
			const wake = spawns[0]!;
			expect(wake.sessionId).toBeUndefined();
			expect(wake.prompt).toContain('carry on');
			expect(wake.prompt).toContain(path.join(dossier, 'handoff', '002.md'));
			expect(wake.prompt).not.toContain(path.join('handoff', '001.md'));
			expect(wake.prompt).toContain('.athena/session-ho/journal.md');
		});

		it('wakes a Run parked on any other row by resuming its Agent Session, naming no Handoff', async () => {
			const {spawns} = await wakeParkedRun({
				memory: memoryOf({iteration: 2, parkedAfterHandover: false}),
				stopReason:
					'nudge cap reached: 3 nudges (nudgeCap) without journal progress or a terminal marker',
			});
			const wake = spawns[0]!;
			expect(wake.sessionId).toBe('claude-sess-bound');
			expect(wake.prompt).toContain('carry on');
			expect(wake.prompt).not.toContain('handoff/');
		});
	});

	describe('the Turn-1 baseline headroom warning (ADR 0018 §6, #216)', () => {
		/** A single completing Turn whose stream opens at `openingContext` tokens. */
		function completingTurn(journalPath: string, openingContext: number) {
			return (opts: SpawnArgs): ChildProcess => {
				const child = makeChildProcess();
				setImmediate(() => {
					opts.onStdout?.(
						JSON.stringify({
							type: 'assistant',
							message: {
								type: 'message',
								usage: {
									input_tokens: openingContext - 1_000,
									output_tokens: 10,
									cache_read_input_tokens: 1_000,
								},
							},
						}) + '\n',
					);
					opts.onStdout?.(
						JSON.stringify({
							type: 'assistant',
							message: {
								type: 'message',
								usage: {
									input_tokens: 500,
									output_tokens: 10,
									cache_read_input_tokens: openingContext + 4_500,
								},
							},
						}) + '\n',
					);
					fs.writeFileSync(journalPath, 'done\n<!-- DONE -->', 'utf-8');
					opts.onStdout?.(
						JSON.stringify({
							type: 'message',
							role: 'assistant',
							content: [{type: 'text', text: 'finished'}],
						}) + '\n',
					);
					opts.onExit?.(0);
				});
				return child;
			};
		}

		async function runTurnOne(input: {
			openingContext: number;
			json: boolean;
			maxTurnTokenCount?: number;
		}) {
			const runtime = new MockRuntime();
			const stdout = createWriteCapture();
			const stderr = createWriteCapture();
			const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-hr-'));
			const dossier = path.join(projectDir, '.athena', 'session-hr');
			fs.mkdirSync(dossier, {recursive: true});
			const journalPath = path.join(dossier, 'journal.md');
			try {
				const result = await runExec({
					prompt: 'small task',
					projectDir,
					harness: 'claude-code',
					athenaSessionId: 'session-hr',
					isolationConfig: {},
					ephemeral: true,
					json: input.json,
					stdout: stdout.writer,
					stderr: stderr.writer,
					runtimeFactory: () => runtime,
					spawnProcess: completingTurn(journalPath, input.openingContext),
					workflow: {
						name: 'test-loop',
						plugins: [],
						promptTemplate: '{input}',
						loop: {
							enabled: true,
							completionMarker: '<!-- DONE -->',
							maxIterations: 5,
							journalPath: '.athena/{sessionId}/journal.md',
							...(input.maxTurnTokenCount !== undefined
								? {maxTurnTokenCount: input.maxTurnTokenCount}
								: {}),
						},
					},
				});
				expect(result.success).toBe(true);
				return {stdout: stdout.read(), stderr: stderr.read()};
			} finally {
				fs.rmSync(projectDir, {recursive: true, force: true});
			}
		}

		it('warns on exec.warning when Turn 1 opens above half the bound, naming the opening context, the bound and the likely working room', async () => {
			const {stdout} = await runTurnOne({openingContext: 71_400, json: true});
			const warning = parseJsonl(stdout).find(
				e =>
					e.type === 'exec.warning' &&
					String(e.data.message).includes('baseline context'),
			);
			expect(warning).toBeDefined();
			const message = String(warning!.data.message);
			expect(message).toContain('~71k');
			expect(message).toContain('~130k');
			expect(message).toContain('loop.maxTurnTokenCount');
			expect(message).toContain('working room');
			expect(message).toContain('below the bound');
			expect(message).toContain('MCP servers and skills');
		});

		it('measures against the configured bound', async () => {
			const {stdout} = await runTurnOne({
				openingContext: 60_000,
				json: true,
				maxTurnTokenCount: 105_000,
			});
			const message = String(
				parseJsonl(stdout).find(
					e =>
						e.type === 'exec.warning' &&
						String(e.data.message).includes('baseline context'),
				)?.data.message,
			);
			expect(message).toContain('~60k');
			expect(message).toContain('~105k');
		});

		it('stays silent when Turn 1 opens below half the bound', async () => {
			const {stdout, stderr} = await runTurnOne({
				openingContext: 20_000,
				json: true,
			});
			expect(
				parseJsonl(stdout).some(
					e =>
						e.type === 'exec.warning' &&
						String(e.data.message).includes('baseline context'),
				),
			).toBe(false);
			expect(stderr).not.toContain('baseline context');
		});

		it('prints a notice in human mode', async () => {
			const {stderr} = await runTurnOne({openingContext: 71_400, json: false});
			expect(stderr).toContain('baseline context is ~71k');
		});
	});

	it('suspends after running all iterations without completion (awaiting_attention)', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-test-'));
		const trackerPath = path.join(projectDir, 'tracker.md');

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();

			setImmediate(() => {
				// Simulate the agent replacing the skeleton with real content but
				// never writing the completion marker, so the loop runs to its
				// iteration cap.
				fs.writeFileSync(trackerPath, 'work in progress', 'utf-8');
				opts.onStdout?.(
					JSON.stringify({
						type: 'message',
						role: 'assistant',
						content: [{type: 'text', text: 'done message'}],
					}) + '\n',
				);
				opts.onExit?.(0);
			});

			return child;
		};

		try {
			const result = await runExec({
				prompt: 'hello',
				projectDir,
				harness: 'claude-code',
				isolationConfig: {},
				ephemeral: true,
				stdout: stdout.writer,
				stderr: stderr.writer,
				runtimeFactory: () => runtime,
				spawnProcess,
				workflow: {
					name: 'test-loop',
					plugins: [],
					promptTemplate: '{input}',
					loop: {
						enabled: true,
						completionMarker: '<!-- DONE -->',
						maxIterations: 5,
						trackerPath: 'tracker.md',
					},
				},
			});

			expect(result.success).toBe(true);
			expect(result.exitCode).toBe(RUN_EXIT_CODE.SUCCESS);
			expect(result.failure).toBeUndefined();
			expect(stderr.read()).toContain('workflow run suspended');
			expect(stderr.read()).toContain('iteration ceiling');
		} finally {
			fs.rmSync(projectDir, {recursive: true, force: true});
		}
	});

	it('suspends without failure when a looped workflow declares a block (awaiting_attention)', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();
		const trackerPath = '/tmp/runner-blocked-tracker.md';

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();

			setImmediate(() => {
				fs.writeFileSync(
					trackerPath,
					'<!-- E2E_BLOCKED: browser initialization failed -->',
					'utf-8',
				);
				opts.onStdout?.(
					JSON.stringify({
						type: 'message',
						role: 'assistant',
						content: [{type: 'text', text: 'blocked'}],
					}) + '\n',
				);
				opts.onExit?.(0);
			});

			return child;
		};

		try {
			const result = await runExec({
				prompt: 'hello',
				projectDir: '/tmp',
				harness: 'claude-code',
				isolationConfig: {},
				ephemeral: true,
				stdout: stdout.writer,
				stderr: stderr.writer,
				runtimeFactory: () => runtime,
				spawnProcess,
				workflow: {
					name: 'test-loop',
					plugins: [],
					promptTemplate: '{input}',
					loop: {
						enabled: true,
						completionMarker: '<!-- DONE -->',
						blockedMarker: '<!-- E2E_BLOCKED',
						maxIterations: 5,
						trackerPath: 'runner-blocked-tracker.md',
					},
				},
			});

			// A declared block suspends the Run (ADR 0014): no failure latch,
			// no failure exit code — contrast the old terminal `blocked`.
			expect(result.success).toBe(true);
			expect(result.exitCode).toBe(RUN_EXIT_CODE.SUCCESS);
			expect(result.failure).toBeUndefined();
			expect(stderr.read()).toContain('workflow run suspended');
			expect(stderr.read()).toContain(
				'agent declared NEEDS_HUMAN: browser initialization failed',
			);
		} finally {
			fs.rmSync(trackerPath, {force: true});
		}
	});

	it('converts an unanswerable AskUserQuestion into awaiting_attention instead of hanging', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();
		const trackerPath = '/tmp/runner-question-tracker.md';

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess(() => {
				// The exec runner interrupts the Turn to suspend; the harness
				// process dies with a non-zero exit.
				opts.onExit?.(143);
			});

			setImmediate(() => {
				fs.writeFileSync(trackerPath, 'still working', 'utf-8');
				// AskUserQuestion arrives with no hub attached — previously this
				// waited forever on the null-timeout decision.
				runtime.emit(
					makeRuntimeEvent({
						id: 'evt-question',
						kind: 'tool.pre',
						hookName: 'PreToolUse',
						toolName: 'AskUserQuestion',
						data: {
							tool_name: 'AskUserQuestion',
							tool_input: {
								questions: [{question: 'Deploy to prod or staging?'}],
							},
						},
						interaction: {
							expectsDecision: true,
							defaultTimeoutMs: null,
							canBlock: true,
						},
					}),
				);
			});

			return child;
		};

		try {
			const result = await runExec({
				prompt: 'hello',
				projectDir: '/tmp',
				harness: 'claude-code',
				isolationConfig: {},
				ephemeral: true,
				stdout: stdout.writer,
				stderr: stderr.writer,
				runtimeFactory: () => runtime,
				spawnProcess,
				workflow: {
					name: 'test-loop',
					plugins: [],
					promptTemplate: '{input}',
					loop: {
						enabled: true,
						completionMarker: '<!-- DONE -->',
						maxIterations: 5,
						trackerPath: 'runner-question-tracker.md',
					},
				},
			});

			expect(result.success).toBe(true);
			expect(result.exitCode).toBe(RUN_EXIT_CODE.SUCCESS);
			expect(result.failure).toBeUndefined();
			expect(stderr.read()).toContain('workflow run suspended');
			expect(stderr.read()).toContain('Deploy to prod or staging?');
		} finally {
			fs.rmSync(trackerPath, {force: true});
		}
	});

	it('converts an unanswerable sandbox approval request into awaiting_attention instead of hanging', async () => {
		// Codex under a restrictive sandbox asks for file-change approval via a
		// permission.request event with the tool name (not 'user_input').
		// Observed live: a headless codex workflow run hung forever on the
		// null-timeout decision. Degrade, never hang (ADR 0014).
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();
		const trackerPath = '/tmp/runner-approval-tracker.md';

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess(() => {
				opts.onExit?.(143);
			});

			setImmediate(() => {
				fs.writeFileSync(trackerPath, 'still working', 'utf-8');
				runtime.emit(
					makeRuntimeEvent({
						id: 'evt-approval',
						kind: 'permission.request',
						hookName: 'item/fileChange/requestApproval',
						toolName: 'Edit',
						data: {
							tool_name: 'Edit',
							tool_input: {reason: null, grantRoot: null},
						},
						interaction: {
							expectsDecision: true,
							defaultTimeoutMs: null,
							canBlock: true,
						},
					}),
				);
			});

			return child;
		};

		try {
			const result = await runExec({
				prompt: 'hello',
				projectDir: '/tmp',
				harness: 'claude-code',
				isolationConfig: {},
				ephemeral: true,
				stdout: stdout.writer,
				stderr: stderr.writer,
				runtimeFactory: () => runtime,
				spawnProcess,
				workflow: {
					name: 'test-loop',
					plugins: [],
					promptTemplate: '{input}',
					loop: {
						enabled: true,
						completionMarker: '<!-- DONE -->',
						maxIterations: 5,
						trackerPath: 'runner-approval-tracker.md',
					},
				},
			});

			expect(result.success).toBe(true);
			expect(result.exitCode).toBe(RUN_EXIT_CODE.SUCCESS);
			expect(result.failure).toBeUndefined();
			expect(stderr.read()).toContain('workflow run suspended');
			// No hub attached: the approval is deferred at once and the Run
			// parks on it (#190) instead of hanging.
			expect(stderr.read()).toContain('permission request (Edit)');
			expect(stderr.read()).toContain('deferred');
		} finally {
			fs.rmSync(trackerPath, {force: true});
		}
	});

	describe('autonomous preset: completes with no human; only an ask rule or NEEDS_HUMAN parks (#189)', () => {
		const LOOP = {
			enabled: true,
			completionMarker: '<!-- WORKFLOW_COMPLETE -->',
			maxIterations: 5,
			journalPath: '.athena/{sessionId}/journal.md',
		};

		function makeProject(): {projectDir: string; journalPath: string} {
			const projectDir = fs.mkdtempSync(
				path.join(os.tmpdir(), 'runner-autonomous-'),
			);
			return {
				projectDir,
				journalPath: path.join(
					projectDir,
					'.athena',
					'session-1',
					'journal.md',
				),
			};
		}

		function permissionRequest(toolName: string): RuntimeEvent {
			return makeRuntimeEvent({
				id: `perm-${toolName}`,
				kind: 'permission.request',
				hookName: 'PermissionRequest',
				toolName,
				data: {tool_name: toolName, tool_input: {command: 'git push'}},
				interaction: {
					expectsDecision: true,
					defaultTimeoutMs: null,
					canBlock: true,
				},
			});
		}

		it('auto-answers an unclaimed permission and runs a workflow to WORKFLOW_COMPLETE with no stdin and no hub', async () => {
			const runtime = new MockRuntime();
			const stdout = createWriteCapture();
			const stderr = createWriteCapture();
			const {projectDir, journalPath} = makeProject();
			let killed = false;

			const spawnProcess = (opts: SpawnArgs): ChildProcess => {
				const child = makeChildProcess(() => {
					killed = true;
					opts.onExit?.(143);
				});
				setImmediate(() => {
					runtime.emit(
						makeRuntimeEvent({kind: 'session.start', hookName: 'SessionStart'}),
					);
					// The agent hits a permission prompt mid-Turn. With nobody
					// attached, the preset's policy answers it synchronously...
					runtime.emit(permissionRequest('Bash'));
					// ...so the Turn is still alive and finishes the work.
					fs.writeFileSync(
						journalPath,
						'# Task: done\n\n<!-- WORKFLOW_COMPLETE -->\n',
						'utf-8',
					);
					opts.onStdout?.(
						JSON.stringify({
							type: 'message',
							role: 'assistant',
							content: [{type: 'text', text: 'all done'}],
						}) + '\n',
					);
					opts.onExit?.(0);
				});
				return child;
			};

			try {
				const result = await runExec({
					prompt: 'ship it',
					projectDir,
					harness: 'claude-code',
					athenaSessionId: 'session-1',
					isolationConfig: {preset: 'autonomous'},
					ephemeral: true,
					stdout: stdout.writer,
					stderr: stderr.writer,
					runtimeFactory: () => runtime,
					spawnProcess,
					workflow: {
						name: 'default',
						plugins: [],
						promptTemplate: '{input}',
						loop: LOOP,
					},
				});

				expect(result.success).toBe(true);
				expect(result.exitCode).toBe(RUN_EXIT_CODE.SUCCESS);
				expect(result.finalMessage).toBe('all done');
				expect(killed).toBe(false);
				expect(runtime.decisions).toEqual([
					{
						eventId: 'perm-Bash',
						decision: expect.objectContaining({
							source: 'rule',
							intent: {kind: 'permission_allow'},
						}),
					},
				]);
				expect(stderr.read()).not.toContain('workflow run suspended');
			} finally {
				fs.rmSync(projectDir, {recursive: true, force: true});
			}
		});

		it('an ask rule firing parks the Run as needs-human, and drisp runs shows it Parked with the rule named', async () => {
			const runtime = new MockRuntime();
			const stdout = createWriteCapture();
			const stderr = createWriteCapture();
			const {projectDir, journalPath} = makeProject();
			const sessionsRoot = fs.mkdtempSync(
				path.join(os.tmpdir(), 'runner-sessions-'),
			);

			const spawnProcess = (opts: SpawnArgs): ChildProcess => {
				const child = makeChildProcess(() => {
					opts.onExit?.(143);
				});
				setImmediate(() => {
					runtime.emit(
						makeRuntimeEvent({kind: 'session.start', hookName: 'SessionStart'}),
					);
					fs.writeFileSync(journalPath, '# Task: in progress\n', 'utf-8');
					runtime.emit(permissionRequest('Bash'));
				});
				return child;
			};

			try {
				const result = await runExec({
					prompt: 'ship it',
					projectDir,
					harness: 'claude-code',
					athenaSessionId: 'session-1',
					isolationConfig: {preset: 'autonomous'},
					stdout: stdout.writer,
					stderr: stderr.writer,
					runtimeFactory: () => runtime,
					spawnProcess,
					sessionStoreFactory: opts =>
						createSessionStore({
							...opts,
							dbPath: path.join(sessionsRoot, opts.sessionId, 'session.db'),
						}),
					workflow: {
						name: 'default',
						plugins: [],
						promptTemplate: '{input}',
						loop: LOOP,
						askRules: ['Bash'],
					},
				});

				// Parked, not failed: the preset's policy never answered on the
				// human's behalf, and the Run remains resumable. With no hub
				// attached the claimed permission is deferred at once (#190): the
				// call is refused as "deferred" and the Turn ends.
				expect(result.success).toBe(true);
				expect(result.exitCode).toBe(RUN_EXIT_CODE.SUCCESS);
				expect(result.failure).toBeUndefined();
				expect(runtime.decisions).toEqual([
					{
						eventId: 'perm-Bash',
						decision: expect.objectContaining({
							source: 'timeout',
							intent: expect.objectContaining({
								kind: 'permission_deny',
								reason: expect.stringContaining('deferred'),
							}),
						}),
					},
				]);
				expect(stderr.read()).toContain('workflow run suspended');
				expect(stderr.read()).toContain(
					'ask rule "Bash" fired on Bash deferred immediately (no hub attached to answer): git push',
				);

				// The inbox reads the persisted Run back: it names the rule and
				// carries the deferred request as the pending question.
				const parked = listAwaitingAttentionRuns(undefined, sessionsRoot);
				expect(parked).toHaveLength(1);
				expect(parked[0]).toMatchObject({
					athenaSessionId: 'session-1',
					workflowName: 'default',
					stopReason: expect.stringContaining('ask rule "Bash" fired on Bash'),
					interruption: {
						kind: 'question',
						requestId: 'perm-Bash',
						question: 'Bash: git push',
					},
				});
				const lines: string[] = [];
				runRunsCommand({
					json: false,
					log: line => lines.push(line),
					listRunsFn: () => parked,
				});
				const inbox = lines.join('\n');
				expect(inbox).toContain('default — Parked, awaiting attention');
				expect(inbox).toContain('reason:  ask rule "Bash" fired on Bash');
				expect(inbox).toContain('question: Bash: git push');
				expect(inbox).toContain('request:  perm-Bash');
				expect(inbox).toContain(
					'drisp run --continue=session-1 --answer=allow',
				);
			} finally {
				fs.rmSync(projectDir, {recursive: true, force: true});
				fs.rmSync(sessionsRoot, {recursive: true, force: true});
			}
		});

		it('a Turn ending in NEEDS_HUMAN parks the Run the same way under autonomous', async () => {
			const runtime = new MockRuntime();
			const stdout = createWriteCapture();
			const stderr = createWriteCapture();
			const {projectDir, journalPath} = makeProject();

			const spawnProcess = (opts: SpawnArgs): ChildProcess => {
				const child = makeChildProcess();
				setImmediate(() => {
					runtime.emit(
						makeRuntimeEvent({kind: 'session.start', hookName: 'SessionStart'}),
					);
					runtime.emit(permissionRequest('Bash'));
					fs.writeFileSync(
						journalPath,
						'# Task\n\n<!-- NEEDS_HUMAN: which registry do I publish to? -->\n',
						'utf-8',
					);
					opts.onExit?.(0);
				});
				return child;
			};

			try {
				const result = await runExec({
					prompt: 'publish',
					projectDir,
					harness: 'claude-code',
					athenaSessionId: 'session-1',
					isolationConfig: {preset: 'autonomous'},
					ephemeral: true,
					stdout: stdout.writer,
					stderr: stderr.writer,
					runtimeFactory: () => runtime,
					spawnProcess,
					workflow: {
						name: 'default',
						plugins: [],
						promptTemplate: '{input}',
						loop: LOOP,
					},
				});

				expect(result.success).toBe(true);
				expect(result.failure).toBeUndefined();
				// The permission was auto-answered; only the marker parked the Run.
				expect(runtime.decisions).toHaveLength(1);
				expect(stderr.read()).toContain('workflow run suspended');
				expect(stderr.read()).toContain(
					'agent declared NEEDS_HUMAN: which registry do I publish to?',
				);
			} finally {
				fs.rmSync(projectDir, {recursive: true, force: true});
			}
		});

		it('guarded has no answer-all policy: an unclaimed permission still parks, pointing at autonomous', async () => {
			const runtime = new MockRuntime();
			const stdout = createWriteCapture();
			const stderr = createWriteCapture();
			const {projectDir, journalPath} = makeProject();

			const spawnProcess = (opts: SpawnArgs): ChildProcess => {
				const child = makeChildProcess(() => {
					opts.onExit?.(143);
				});
				setImmediate(() => {
					fs.writeFileSync(journalPath, '# Task: in progress\n', 'utf-8');
					runtime.emit(permissionRequest('Bash'));
				});
				return child;
			};

			try {
				const result = await runExec({
					prompt: 'ship it',
					projectDir,
					harness: 'claude-code',
					athenaSessionId: 'session-1',
					isolationConfig: {preset: 'guarded'},
					ephemeral: true,
					stdout: stdout.writer,
					stderr: stderr.writer,
					runtimeFactory: () => runtime,
					spawnProcess,
					workflow: {
						name: 'default',
						plugins: [],
						promptTemplate: '{input}',
						loop: LOOP,
					},
				});

				expect(result.success).toBe(true);
				// No hub attached: deferred at once rather than held (#190).
				expect(runtime.decisions).toEqual([
					{
						eventId: 'perm-Bash',
						decision: expect.objectContaining({
							intent: expect.objectContaining({kind: 'permission_deny'}),
						}),
					},
				]);
				expect(stderr.read()).toContain('workflow run suspended');
				expect(stderr.read()).toContain(
					'permission request (Bash) deferred immediately (no hub attached to answer): git push',
				);
				expect(stderr.read()).toContain('--isolation autonomous');
			} finally {
				fs.rmSync(projectDir, {recursive: true, force: true});
			}
		});

		describe('hold, then park, then replay (#190)', () => {
			const ALLOW: RuntimeDecision = {
				type: 'json',
				source: 'user',
				intent: {kind: 'permission_allow'},
			};

			/** An in-memory stand-in for the daemon's durable decision inbox. */
			function makeInbox(rows: DashboardDecisionInboxRow[] = []) {
				const consumed = new Set<number>();
				return {
					rows,
					consumed,
					pendingForSession: () => rows.filter(row => !consumed.has(row.id)),
					markConsumed: ({id}: {id: number}) => {
						consumed.add(id);
					},
				};
			}

			type JsonlEvent = {
				type: string;
				data: {
					stopReason?: string;
					interruption?: unknown;
					requestId?: string;
					[key: string]: unknown;
				};
			};

			function jsonl(text: string): JsonlEvent[] {
				return text
					.split('\n')
					.filter(line => line.trim().length > 0)
					.map(line => JSON.parse(line) as JsonlEvent);
			}

			function makeSessionsRoot(): string {
				return fs.mkdtempSync(path.join(os.tmpdir(), 'runner-sessions-'));
			}

			function storeFactoryAt(sessionsRoot: string) {
				return (opts: {sessionId: string; projectDir: string}) =>
					createSessionStore({
						...opts,
						dbPath: path.join(sessionsRoot, opts.sessionId, 'session.db'),
					});
			}

			/** Seed a session whose latest Run parked on a deferred Bash permission. */
			function seedParkedRun(sessionsRoot: string, projectDir: string): void {
				const message =
					'permission request (Bash) unanswered within the grace window (60s); deferred: git push — wake with --answer=allow|deny, or rerun with --isolation autonomous';
				const seed = createSessionStore({
					sessionId: 'session-1',
					projectDir,
					dbPath: path.join(sessionsRoot, 'session-1', 'session.db'),
				});
				seed.persistRun({
					runId: 'run-parked',
					sessionId: 'session-1',
					workflowName: 'default',
					iteration: 1,
					maxIterations: 5,
					status: 'awaiting_attention',
					stopReason: message,
					interruption: {
						kind: 'question',
						message,
						requestId: 'req-old',
						question: 'Bash: git push',
					},
				});
				seed.close();
			}

			function completeOnDecision(
				runtime: MockRuntime,
				opts: SpawnArgs,
				journalPath: string,
				eventId: string,
			): void {
				runtime.onDecision(decidedId => {
					if (decidedId !== eventId) return;
					fs.writeFileSync(
						journalPath,
						'# Task: done\n\n<!-- WORKFLOW_COMPLETE -->\n',
						'utf-8',
					);
					opts.onStdout?.(
						JSON.stringify({
							type: 'message',
							role: 'assistant',
							content: [{type: 'text', text: 'pushed'}],
						}) + '\n',
					);
					opts.onExit?.(0);
				});
			}

			it('holds an unclaimed permission for the grace window while a hub is attached, then defers it and parks on the request', async () => {
				const runtime = new MockRuntime();
				const stdout = createWriteCapture();
				const stderr = createWriteCapture();
				const {projectDir, journalPath} = makeProject();
				const sessionsRoot = makeSessionsRoot();
				const startedAt = Date.now();
				let killedAt: number | null = null;

				const spawnProcess = (opts: SpawnArgs): ChildProcess => {
					const child = makeChildProcess(() => {
						killedAt = Date.now();
						opts.onExit?.(143);
					});
					setImmediate(() => {
						fs.writeFileSync(journalPath, '# Task: in progress\n', 'utf-8');
						runtime.emit(permissionRequest('Bash'));
					});
					return child;
				};

				try {
					const result = await runExec({
						prompt: 'ship it',
						projectDir,
						harness: 'claude-code',
						athenaSessionId: 'session-1',
						isolationConfig: {preset: 'guarded'},
						json: true,
						stdout: stdout.writer,
						stderr: stderr.writer,
						runtimeFactory: () => runtime,
						spawnProcess,
						sessionStoreFactory: storeFactoryAt(sessionsRoot),
						dashboardDecisionInbox: makeInbox(),
						dashboardDecisionPollIntervalMs: 5,
						permissionGraceMs: 40,
						workflow: {
							name: 'default',
							plugins: [],
							promptTemplate: '{input}',
							loop: LOOP,
						},
					});

					expect(result.success).toBe(true);
					expect(result.failure).toBeUndefined();
					// Held: the Turn was not interrupted before the window elapsed.
					expect(killedAt).not.toBeNull();
					expect(killedAt! - startedAt).toBeGreaterThanOrEqual(40);
					// Deferred: the call was refused with a "deferred" result.
					expect(runtime.decisions).toEqual([
						{
							eventId: 'perm-Bash',
							decision: expect.objectContaining({
								source: 'timeout',
								intent: expect.objectContaining({
									kind: 'permission_deny',
									reason: expect.stringContaining('deferred'),
								}),
							}),
						},
					]);

					const events = jsonl(stdout.read());
					expect(
						events.find(e => e.type === 'permission.hold')?.data,
					).toMatchObject({
						requestId: 'perm-Bash',
						toolName: 'Bash',
						graceMs: 40,
					});
					expect(
						events.find(e => e.type === 'permission.deferred')?.data,
					).toMatchObject({requestId: 'perm-Bash', toolName: 'Bash'});
					const suspended = events.find(e => e.type === 'run.suspended');
					expect(suspended?.data).toMatchObject({
						status: 'awaiting_attention',
						interruption: {
							kind: 'question',
							requestId: 'perm-Bash',
							question: 'Bash: git push',
						},
					});
					expect(suspended?.data.stopReason).toContain(
						'unanswered within the grace window (40ms)',
					);

					// Parked: journal and run record both carry the question.
					const journal = fs.readFileSync(journalPath, 'utf-8');
					expect(journal).toContain('Needs human');
					expect(journal).toContain('perm-Bash');
					expect(journal).toContain('Bash: git push');
					const parked = listAwaitingAttentionRuns(undefined, sessionsRoot);
					expect(parked).toHaveLength(1);
					expect(parked[0]?.interruption).toMatchObject({
						kind: 'question',
						requestId: 'perm-Bash',
						question: 'Bash: git push',
					});
				} finally {
					fs.rmSync(projectDir, {recursive: true, force: true});
					fs.rmSync(sessionsRoot, {recursive: true, force: true});
				}
			});

			it('an answer arriving inside the grace window resolves the hold and the Turn simply continues', async () => {
				const runtime = new MockRuntime();
				const stdout = createWriteCapture();
				const stderr = createWriteCapture();
				const {projectDir, journalPath} = makeProject();
				const inbox = makeInbox();
				let killed = false;

				const spawnProcess = (opts: SpawnArgs): ChildProcess => {
					const child = makeChildProcess(() => {
						killed = true;
						opts.onExit?.(143);
					});
					completeOnDecision(runtime, opts, journalPath, 'perm-Bash');
					setImmediate(() => {
						runtime.emit(permissionRequest('Bash'));
						// The hub answers a moment later, well inside the window.
						setTimeout(() => {
							inbox.rows.push({
								id: 1,
								athenaSessionId: 'session-1',
								requestId: 'perm-Bash',
								decision: ALLOW,
								receivedAt: Date.now(),
							});
						}, 10);
					});
					return child;
				};

				try {
					const result = await runExec({
						prompt: 'ship it',
						projectDir,
						harness: 'claude-code',
						athenaSessionId: 'session-1',
						isolationConfig: {preset: 'guarded'},
						ephemeral: true,
						stdout: stdout.writer,
						stderr: stderr.writer,
						runtimeFactory: () => runtime,
						spawnProcess,
						dashboardDecisionInbox: inbox,
						dashboardDecisionPollIntervalMs: 5,
						permissionGraceMs: 5_000,
						workflow: {
							name: 'default',
							plugins: [],
							promptTemplate: '{input}',
							loop: LOOP,
						},
					});

					expect(result.success).toBe(true);
					expect(result.finalMessage).toBe('pushed');
					expect(killed).toBe(false);
					expect(runtime.decisions).toEqual([
						{eventId: 'perm-Bash', decision: ALLOW},
					]);
					expect(inbox.consumed.has(1)).toBe(true);
					expect(stderr.read()).not.toContain('workflow run suspended');
				} finally {
					fs.rmSync(projectDir, {recursive: true, force: true});
				}
			});

			it('on continue, an answer given on the command line is replayed into the re-issued call without a prompt', async () => {
				const runtime = new MockRuntime();
				const stdout = createWriteCapture();
				const stderr = createWriteCapture();
				const {projectDir, journalPath} = makeProject();
				const sessionsRoot = makeSessionsRoot();
				seedParkedRun(sessionsRoot, projectDir);
				let wakePrompt: string | undefined;

				const spawnProcess = (opts: SpawnArgs): ChildProcess => {
					wakePrompt = (opts as {prompt?: string}).prompt;
					const child = makeChildProcess(() => {
						opts.onExit?.(143);
					});
					completeOnDecision(runtime, opts, journalPath, 'perm-Bash-2');
					setImmediate(() => {
						// The agent re-issues the same call under a new request id.
						runtime.emit({...permissionRequest('Bash'), id: 'perm-Bash-2'});
					});
					return child;
				};

				try {
					const result = await runExec({
						prompt: 'go ahead',
						projectDir,
						harness: 'claude-code',
						athenaSessionId: 'session-1',
						resumeRunId: 'run-parked',
						isolationConfig: {preset: 'guarded'},
						json: true,
						stdout: stdout.writer,
						stderr: stderr.writer,
						runtimeFactory: () => runtime,
						spawnProcess,
						sessionStoreFactory: storeFactoryAt(sessionsRoot),
						dashboardDecisionInbox: makeInbox(),
						dashboardDecisionPollIntervalMs: 5,
						permissionGraceMs: 5_000,
						storedAnswer: ALLOW,
						workflow: {
							name: 'default',
							plugins: [],
							promptTemplate: '{input}',
							loop: LOOP,
						},
					});

					expect(result.success).toBe(true);
					expect(result.finalMessage).toBe('pushed');
					expect(runtime.decisions).toEqual([
						{eventId: 'perm-Bash-2', decision: ALLOW},
					]);
					const events = jsonl(stdout.read());
					expect(
						events.find(e => e.type === 'permission.replayed')?.data,
					).toMatchObject({
						requestId: 'perm-Bash-2',
						replayOf: 'req-old',
						toolName: 'Bash',
						source: 'local',
					});
					expect(events.some(e => e.type === 'permission.hold')).toBe(false);
					expect(events.some(e => e.type === 'run.suspended')).toBe(false);
					// The wake prompt asked for exactly that call to be re-issued.
					expect(wakePrompt).toContain('Re-issue that exact call');
					expect(wakePrompt).toContain('Bash: git push');
					// The Run went back to running and completed: nothing is parked.
					expect(listAwaitingAttentionRuns(undefined, sessionsRoot)).toEqual(
						[],
					);
				} finally {
					fs.rmSync(projectDir, {recursive: true, force: true});
					fs.rmSync(sessionsRoot, {recursive: true, force: true});
				}
			});

			it('on continue, a hub answer stored in the inbox for the parked request is replayed, never forwarded to the stale request id', async () => {
				const runtime = new MockRuntime();
				const stdout = createWriteCapture();
				const stderr = createWriteCapture();
				const {projectDir, journalPath} = makeProject();
				const sessionsRoot = makeSessionsRoot();
				seedParkedRun(sessionsRoot, projectDir);
				const inbox = makeInbox([
					{
						id: 9,
						athenaSessionId: 'session-1',
						requestId: 'req-old',
						decision: ALLOW,
						receivedAt: 1,
					},
				]);

				const spawnProcess = (opts: SpawnArgs): ChildProcess => {
					const child = makeChildProcess(() => {
						opts.onExit?.(143);
					});
					completeOnDecision(runtime, opts, journalPath, 'perm-Bash-2');
					setImmediate(() => {
						runtime.emit({...permissionRequest('Bash'), id: 'perm-Bash-2'});
					});
					return child;
				};

				try {
					const result = await runExec({
						prompt: 'go ahead',
						projectDir,
						harness: 'claude-code',
						athenaSessionId: 'session-1',
						resumeRunId: 'run-parked',
						isolationConfig: {preset: 'guarded'},
						json: true,
						stdout: stdout.writer,
						stderr: stderr.writer,
						runtimeFactory: () => runtime,
						spawnProcess,
						sessionStoreFactory: storeFactoryAt(sessionsRoot),
						dashboardDecisionInbox: inbox,
						dashboardDecisionPollIntervalMs: 5,
						permissionGraceMs: 5_000,
						workflow: {
							name: 'default',
							plugins: [],
							promptTemplate: '{input}',
							loop: LOOP,
						},
					});

					expect(result.success).toBe(true);
					// Only the re-issued request was answered; `req-old` never
					// reached the runtime.
					expect(runtime.decisions).toEqual([
						{eventId: 'perm-Bash-2', decision: ALLOW},
					]);
					expect(inbox.consumed.has(9)).toBe(true);
					expect(
						jsonl(stdout.read()).find(e => e.type === 'permission.replayed')
							?.data,
					).toMatchObject({replayOf: 'req-old', source: 'hub'});
				} finally {
					fs.rmSync(projectDir, {recursive: true, force: true});
					fs.rmSync(sessionsRoot, {recursive: true, force: true});
				}
			});

			it('on continue with no stored answer, the re-issued call is held again and the Run parks again on the new request', async () => {
				const runtime = new MockRuntime();
				const stdout = createWriteCapture();
				const stderr = createWriteCapture();
				const {projectDir, journalPath} = makeProject();
				const sessionsRoot = makeSessionsRoot();
				seedParkedRun(sessionsRoot, projectDir);

				const spawnProcess = (opts: SpawnArgs): ChildProcess => {
					const child = makeChildProcess(() => {
						opts.onExit?.(143);
					});
					setImmediate(() => {
						fs.writeFileSync(journalPath, '# Task: in progress\n', 'utf-8');
						runtime.emit({...permissionRequest('Bash'), id: 'perm-Bash-2'});
					});
					return child;
				};

				try {
					const result = await runExec({
						prompt: 'go ahead',
						projectDir,
						harness: 'claude-code',
						athenaSessionId: 'session-1',
						resumeRunId: 'run-parked',
						isolationConfig: {preset: 'guarded'},
						json: true,
						stdout: stdout.writer,
						stderr: stderr.writer,
						runtimeFactory: () => runtime,
						spawnProcess,
						sessionStoreFactory: storeFactoryAt(sessionsRoot),
						dashboardDecisionInbox: makeInbox(),
						dashboardDecisionPollIntervalMs: 5,
						permissionGraceMs: 30,
						workflow: {
							name: 'default',
							plugins: [],
							promptTemplate: '{input}',
							loop: LOOP,
						},
					});

					expect(result.success).toBe(true);
					expect(runtime.decisions).toEqual([
						{
							eventId: 'perm-Bash-2',
							decision: expect.objectContaining({
								intent: expect.objectContaining({kind: 'permission_deny'}),
							}),
						},
					]);
					const events = jsonl(stdout.read());
					expect(events.some(e => e.type === 'permission.hold')).toBe(true);
					expect(events.some(e => e.type === 'permission.replayed')).toBe(
						false,
					);
					expect(
						events.find(e => e.type === 'run.suspended')?.data.interruption,
					).toMatchObject({
						requestId: 'perm-Bash-2',
						question: 'Bash: git push',
					});
					expect(
						listAwaitingAttentionRuns(undefined, sessionsRoot)[0]?.interruption,
					).toMatchObject({requestId: 'perm-Bash-2'});
				} finally {
					fs.rmSync(projectDir, {recursive: true, force: true});
					fs.rmSync(sessionsRoot, {recursive: true, force: true});
				}
			});

			it('a stored answer is never replayed into a different call: the agent asking for something else is held', async () => {
				const runtime = new MockRuntime();
				const stdout = createWriteCapture();
				const stderr = createWriteCapture();
				const {projectDir, journalPath} = makeProject();
				const sessionsRoot = makeSessionsRoot();
				seedParkedRun(sessionsRoot, projectDir);

				const spawnProcess = (opts: SpawnArgs): ChildProcess => {
					const child = makeChildProcess(() => {
						opts.onExit?.(143);
					});
					setImmediate(() => {
						fs.writeFileSync(journalPath, '# Task: in progress\n', 'utf-8');
						runtime.emit(
							makeRuntimeEvent({
								id: 'perm-Bash-other',
								kind: 'permission.request',
								hookName: 'PermissionRequest',
								toolName: 'Bash',
								data: {
									tool_name: 'Bash',
									tool_input: {command: 'rm -rf build'},
								},
								interaction: {
									expectsDecision: true,
									defaultTimeoutMs: null,
									canBlock: true,
								},
							}),
						);
					});
					return child;
				};

				try {
					await runExec({
						prompt: 'go ahead',
						projectDir,
						harness: 'claude-code',
						athenaSessionId: 'session-1',
						resumeRunId: 'run-parked',
						isolationConfig: {preset: 'guarded'},
						json: true,
						stdout: stdout.writer,
						stderr: stderr.writer,
						runtimeFactory: () => runtime,
						spawnProcess,
						sessionStoreFactory: storeFactoryAt(sessionsRoot),
						dashboardDecisionInbox: makeInbox(),
						dashboardDecisionPollIntervalMs: 5,
						permissionGraceMs: 30,
						storedAnswer: ALLOW,
						workflow: {
							name: 'default',
							plugins: [],
							promptTemplate: '{input}',
							loop: LOOP,
						},
					});

					expect(runtime.decisions).toEqual([
						{
							eventId: 'perm-Bash-other',
							decision: expect.objectContaining({
								intent: expect.objectContaining({kind: 'permission_deny'}),
							}),
						},
					]);
					const events = jsonl(stdout.read());
					expect(events.some(e => e.type === 'permission.replayed')).toBe(
						false,
					);
					expect(
						events.find(e => e.type === 'run.suspended')?.data.interruption,
					).toMatchObject({
						requestId: 'perm-Bash-other',
						question: 'Bash: rm -rf build',
					});
				} finally {
					fs.rmSync(projectDir, {recursive: true, force: true});
					fs.rmSync(sessionsRoot, {recursive: true, force: true});
				}
			});
		});
	});

	it('suspends without failure when maxIterations is reached (awaiting_attention)', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();
		const trackerPath = '/tmp/runner-max-iterations-tracker.md';

		const spawnProcess = vi.fn((opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();

			setImmediate(() => {
				fs.writeFileSync(trackerPath, 'still running', 'utf-8');
				opts.onStdout?.(
					JSON.stringify({
						type: 'message',
						role: 'assistant',
						content: [{type: 'text', text: 'done message'}],
					}) + '\n',
				);
				opts.onExit?.(0);
			});

			return child;
		});

		try {
			const result = await runExec({
				prompt: 'hello',
				projectDir: '/tmp',
				harness: 'claude-code',
				isolationConfig: {},
				ephemeral: true,
				stdout: stdout.writer,
				stderr: stderr.writer,
				runtimeFactory: () => runtime,
				spawnProcess,
				workflow: {
					name: 'test-loop',
					plugins: [],
					promptTemplate: '{input}',
					loop: {
						enabled: true,
						completionMarker: '<!-- DONE -->',
						maxIterations: 1,
						trackerPath: 'runner-max-iterations-tracker.md',
					},
				},
			});

			// The runaway ceiling suspends the Run (ADR 0014): no failure latch,
			// no failure exit code — contrast the old terminal `exhausted`. The
			// notice names the tripped bound.
			expect(result.success).toBe(true);
			expect(result.exitCode).toBe(RUN_EXIT_CODE.SUCCESS);
			expect(result.failure).toBeUndefined();
			expect(stderr.read()).toContain('workflow run suspended');
			expect(stderr.read()).toContain('iteration ceiling');
			expect(spawnProcess).toHaveBeenCalledTimes(1);
		} finally {
			fs.rmSync(trackerPath, {force: true});
		}
	});

	it('surfaces stderr in failure message when process exits non-zero', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();

			setImmediate(() => {
				opts.onStderr?.('Authentication failed: invalid API key');
				opts.onStderr?.('Hook cancelled');
				opts.onExit?.(1);
			});

			return child;
		};

		const result = await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			ephemeral: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess,
		});

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(RUN_EXIT_CODE.RUNTIME);
		expect(result.failure?.message).toContain('exited with code 1');
		expect(result.failure?.message).toContain('Authentication failed');
	});

	it('returns runtime failure when session store initialization throws', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		const result = await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			ephemeral: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess: () => makeChildProcess(),
			sessionStoreFactory: () => {
				throw new Error('db init failed');
			},
		});

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(RUN_EXIT_CODE.RUNTIME);
		expect(result.failure?.kind).toBe('process');
		expect(result.failure?.message).toContain('db init failed');
	});

	it('returns runtime failure when runtime initialization throws', async () => {
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		const result = await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			ephemeral: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => {
				throw new Error('runtime init failed');
			},
			spawnProcess: () => makeChildProcess(),
		});

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(RUN_EXIT_CODE.RUNTIME);
		expect(result.failure?.kind).toBe('process');
		expect(result.failure?.message).toContain('runtime init failed');
	});

	it('queues a steer received mid-Turn and delivers it at the head of the next Turn (#191)', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-steer-'));
		const journalPath = path.join(projectDir, 'journal.md');
		const steerQueue = createSteerQueue();

		const spawns: SpawnArgs[] = [];
		const spawnProcess = vi.fn((opts: SpawnArgs): ChildProcess => {
			spawns.push(opts);
			const spawnIndex = spawns.length;
			const child = makeChildProcess();
			setImmediate(() => {
				if (spawnIndex === 1) {
					// The hub steers while Turn 1 is still running: it must wait.
					steerQueue.push({
						text: 'use the other branch',
						origin: 'hub',
						receivedAt: 4_242,
					});
					expect(spawns).toHaveLength(1);
					fs.writeFileSync(journalPath, 'turn 1 progress', 'utf-8');
				} else {
					fs.writeFileSync(journalPath, '<!-- DONE -->', 'utf-8');
				}
				opts.onExit?.(0);
			});
			return child;
		});

		try {
			const result = await runExec({
				prompt: 'hello',
				projectDir,
				harness: 'claude-code',
				isolationConfig: {},
				ephemeral: true,
				json: true,
				stdout: stdout.writer,
				stderr: stderr.writer,
				runtimeFactory: () => runtime,
				spawnProcess,
				steerQueue,
				workflow: {
					name: 'test-loop',
					plugins: [],
					promptTemplate: '{input}',
					loop: {
						enabled: true,
						completionMarker: '<!-- DONE -->',
						maxIterations: 5,
						journalPath: 'journal.md',
					},
				},
			});

			expect(result.success).toBe(true);
			expect(spawns).toHaveLength(2);
			expect(spawns[0]!.prompt).not.toContain('use the other branch');
			expect(spawns[1]!.prompt.startsWith(STEER_BLOCK_OPEN)).toBe(true);
			expect(spawns[1]!.prompt).toContain('via hub');
			expect(spawns[1]!.prompt).toContain('use the other branch');

			const events = stdout
				.read()
				.split('\n')
				.filter(line => line.length > 0)
				.map(line => JSON.parse(line) as {type: string; data: unknown});
			expect(events).toContainEqual(
				expect.objectContaining({
					type: 'run.steer.queued',
					data: {
						origin: 'hub',
						receivedAt: 4_242,
						text: 'use the other branch',
					},
				}),
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: 'run.steer',
					data: {
						iteration: 2,
						origin: 'hub',
						receivedAt: 4_242,
						text: 'use the other branch',
					},
				}),
			);
			const queuedIndex = events.findIndex(e => e.type === 'run.steer.queued');
			const deliveredIndex = events.findIndex(e => e.type === 'run.steer');
			expect(queuedIndex).toBeLessThan(deliveredIndex);
		} finally {
			fs.rmSync(projectDir, {recursive: true, force: true});
		}
	});

	it('delivers a steer queued before the Run starts at the head of the first Turn (#191)', async () => {
		const runtime = new MockRuntime();
		const stderr = createWriteCapture();
		const stdout = createWriteCapture();
		const steerQueue = createSteerQueue();
		steerQueue.push({text: 'be brief', origin: 'local', receivedAt: 1});

		const spawns: SpawnArgs[] = [];
		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			spawns.push(opts);
			const child = makeChildProcess();
			setImmediate(() => opts.onExit?.(0));
			return child;
		};

		const result = await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			ephemeral: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess,
			steerQueue,
		});

		expect(result.success).toBe(true);
		expect(spawns).toHaveLength(1);
		expect(spawns[0]!.prompt.startsWith(STEER_BLOCK_OPEN)).toBe(true);
		expect(spawns[0]!.prompt).toContain('via local');
		expect(spawns[0]!.prompt.endsWith('hello')).toBe(true);
		expect(stderr.read()).toContain('steer delivered into Turn 1 (via local)');
	});
});

describe('runExec phase events', () => {
	function journalWith(block: string[], ...tail: string[]): string {
		return [
			'# Journal',
			'## Status',
			'Working.',
			'<!-- TURN_PROTOCOL',
			...block,
			'-->',
			...tail,
		].join('\n');
	}

	it('publishes a phase FeedEvent locally and to the paired feed, and a run.phase JSONL event, once per change of step', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();
		const dashboardFeedPublisher = {publish: vi.fn()};
		const projectDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'athena-exec-phase-'),
		);
		const journalPath = path.join(
			projectDir,
			'.athena',
			'athena-1',
			'journal.md',
		);
		let turns = 0;

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();
			turns += 1;
			const turn = turns;
			setImmediate(() => {
				runtime.emit(
					makeRuntimeEvent({
						id: `evt-${turn}`,
						kind: 'session.start',
						hookName: 'SessionStart',
					}),
				);
				fs.mkdirSync(path.dirname(journalPath), {recursive: true});
				fs.writeFileSync(
					journalPath,
					turn === 1
						? journalWith(['step: Orient', 'step_index: 1', 'step_total: 2'])
						: journalWith(
								['step: Build', 'step_index: 2', 'step_total: 2'],
								'<!-- WORKFLOW_COMPLETE -->',
							),
					'utf-8',
				);
				opts.onStdout?.(
					JSON.stringify({
						type: 'message',
						role: 'assistant',
						content: [{type: 'text', text: 'done'}],
					}) + '\n',
				);
				opts.onExit?.(0);
			});
			return child;
		};

		try {
			const result = await runExec({
				prompt: 'hello',
				projectDir,
				harness: 'claude-code',
				athenaSessionId: 'athena-1',
				isolationConfig: {},
				ephemeral: true,
				json: true,
				stdout: stdout.writer,
				stderr: stderr.writer,
				runtimeFactory: () => runtime,
				spawnProcess,
				dashboardFeedPublisher,
				workflow: {
					name: 'wf',
					plugins: [],
					promptTemplate: '{input}',
					loop: {enabled: true, maxIterations: 5},
				},
			});

			expect(result.success).toBe(true);
			expect(turns).toBe(2);

			const published = dashboardFeedPublisher.publish.mock.calls.flatMap(
				([input]) =>
					(input.feedEvents as FeedEvent[]).filter(e => e.kind === 'phase'),
			);
			expect(published.map(e => e.data)).toEqual([
				{
					runId: expect.any(String),
					turn: 1,
					step: 'Orient',
					stepIndex: 1,
					stepTotal: 2,
				},
				{
					runId: expect.any(String),
					turn: 2,
					step: 'Build',
					stepIndex: 2,
					stepTotal: 2,
				},
			]);
			expect(published[0]!.title).toBe('Step 1/2: Orient');
			expect(published[0]!.session_id).toBe('adapter-session');
			expect(published[0]!.run_id).toMatch(/^adapter-session:R\d+$/);

			const phaseLines = stdout
				.read()
				.split('\n')
				.filter(Boolean)
				.map(line => JSON.parse(line))
				.filter(event => event.type === 'run.phase');
			expect(phaseLines.map(event => event.data.step)).toEqual([
				'Orient',
				'Build',
			]);
		} finally {
			fs.rmSync(projectDir, {recursive: true, force: true});
		}
	});
});
