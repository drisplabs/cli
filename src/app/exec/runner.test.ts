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
import {runExec} from './runner';
import {RUN_EXIT_CODE} from './types';
import {createSteerQueue, STEER_BLOCK_OPEN} from '../../core/workflows/steer';
import {
	createSessionStore,
	listAwaitingAttentionRuns,
} from '../../infra/sessions';
import {runRunsCommand} from '../entry/runsCommand';

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
			expect(stderr.read()).toContain('approval');
			expect(stderr.read()).toContain('Edit');
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
				// human's behalf, and the Run remains resumable.
				expect(result.success).toBe(true);
				expect(result.exitCode).toBe(RUN_EXIT_CODE.SUCCESS);
				expect(result.failure).toBeUndefined();
				expect(runtime.decisions).toEqual([]);
				expect(stderr.read()).toContain('workflow run suspended');
				expect(stderr.read()).toContain(
					'ask rule "Bash" fired on Bash — needs a human',
				);

				// The inbox reads the persisted Run back and names the rule.
				const parked = listAwaitingAttentionRuns(undefined, sessionsRoot);
				expect(parked).toHaveLength(1);
				expect(parked[0]).toMatchObject({
					athenaSessionId: 'session-1',
					workflowName: 'default',
					stopReason: 'ask rule "Bash" fired on Bash — needs a human',
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
				expect(inbox).toContain('drisp run --continue=session-1');
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
				expect(runtime.decisions).toEqual([]);
				expect(stderr.read()).toContain('workflow run suspended');
				expect(stderr.read()).toContain('sandbox approval (Bash)');
				expect(stderr.read()).toContain('--isolation autonomous');
			} finally {
				fs.rmSync(projectDir, {recursive: true, force: true});
			}
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
