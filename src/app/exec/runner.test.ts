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
import type {SessionBridge} from '../channels/sessionBridge';
import {runExec} from './runner';
import {EXEC_EXIT_CODE} from './types';

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

type FakeBridge = Pick<
	SessionBridge,
	'relayPermission' | 'relayQuestion' | 'stop'
>;

function makeFakeBridge(overrides: Partial<FakeBridge> = {}): SessionBridge {
	const defaults: FakeBridge = {
		relayPermission: vi.fn().mockResolvedValue({
			channelRequestId: 'chan-1',
			result: {
				kind: 'verdict',
				channelId: 'telegram',
				behavior: 'allow',
			},
		}),
		relayQuestion: vi.fn().mockResolvedValue({
			channelRequestId: 'chan-q-1',
			result: {kind: 'no_relay'},
		}),
		stop: vi.fn().mockResolvedValue(undefined),
	};
	return {...defaults, ...overrides} as unknown as SessionBridge;
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
		expect(result.exitCode).toBe(EXEC_EXIT_CODE.SUCCESS);
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
		expect(result.exitCode).toBe(EXEC_EXIT_CODE.OUTPUT);
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
		expect(result.exitCode).toBe(EXEC_EXIT_CODE.OUTPUT);
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
		expect(result.exitCode).toBe(EXEC_EXIT_CODE.RUNTIME);
		expect(result.failure?.kind).toBe('process');
		expect(result.failure?.message).toBe('Execution cancelled.');
		expect(runtime.decisions.length).toBe(0);
	});

	it('times out waiting for a pending permission decision when no bridge is attached', async () => {
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
			expect(result.exitCode).toBe(EXEC_EXIT_CODE.TIMEOUT);
			expect(result.failure?.kind).toBe('timeout');
			expect(runtime.decisions.length).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('relays a permission request through the bridge and applies the verdict', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();
		const bridge = makeFakeBridge();

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();

			setImmediate(() => {
				runtime.emit(
					makeRuntimeEvent({
						id: 'perm-bridge',
						kind: 'permission.request',
						hookName: 'PermissionRequest',
						toolName: 'Bash',
						interaction: {expectsDecision: true},
						data: {tool_name: 'Bash', tool_input: {command: 'pwd'}},
					}),
				);
				setImmediate(() => {
					opts.onStdout?.(
						JSON.stringify({
							type: 'message',
							role: 'assistant',
							content: [{type: 'text', text: 'permission granted'}],
						}) + '\n',
					);
					opts.onExit?.(0);
				});
			});

			return child;
		};

		const result = await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			channels: ['telegram'],
			ephemeral: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess,
			bridgeFactory: () => Promise.resolve(bridge),
		});

		expect(result.success).toBe(true);
		expect(bridge.relayPermission).toHaveBeenCalledWith(
			expect.objectContaining({toolName: 'Bash'}),
		);
		expect(bridge.stop).toHaveBeenCalledTimes(1);
		expect(runtime.decisions).toContainEqual(
			expect.objectContaining({
				eventId: 'perm-bridge',
				decision: expect.objectContaining({
					intent: {kind: 'permission_allow'},
				}),
			}),
		);
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
			expect(result.exitCode).toBe(EXEC_EXIT_CODE.TIMEOUT);
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
		fs.writeFileSync(trackerPath, '<!-- DONE -->', 'utf-8');

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
			expect(result.exitCode).toBe(EXEC_EXIT_CODE.SUCCESS);
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
			expect(result.exitCode).toBe(EXEC_EXIT_CODE.SUCCESS);
			expect(result.failure).toBeUndefined();
			expect(stderr.read()).toContain('workflow run suspended');
			expect(stderr.read()).toContain(
				'agent declared WORKFLOW_BLOCKED: browser initialization failed',
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
				// AskUserQuestion arrives with no bridge attached — previously this
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
			expect(result.exitCode).toBe(EXEC_EXIT_CODE.SUCCESS);
			expect(result.failure).toBeUndefined();
			expect(stderr.read()).toContain('workflow run suspended');
			expect(stderr.read()).toContain('Deploy to prod or staging?');
		} finally {
			fs.rmSync(trackerPath, {force: true});
		}
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
			expect(result.exitCode).toBe(EXEC_EXIT_CODE.SUCCESS);
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
		expect(result.exitCode).toBe(EXEC_EXIT_CODE.RUNTIME);
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
		expect(result.exitCode).toBe(EXEC_EXIT_CODE.RUNTIME);
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
		expect(result.exitCode).toBe(EXEC_EXIT_CODE.RUNTIME);
		expect(result.failure?.kind).toBe('process');
		expect(result.failure?.message).toContain('runtime init failed');
	});
});
