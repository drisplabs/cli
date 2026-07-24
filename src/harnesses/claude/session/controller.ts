import type {ChildProcess} from 'node:child_process';
import {spawnClaude} from '../process/spawn';
import type {IsolationConfig, IsolationPreset} from '../config/isolation';
import {createTokenAccumulator} from '../process/tokenAccumulator';
import {createAssistantMessageAccumulator} from './assistantMessageAccumulator';
import {
	mergeIsolation,
	resolveClaudeSessionId,
	resolveWorkflowSpawnEnv,
} from './turnConfig';
import type {
	CreateSessionControllerInput,
	SessionController,
	SessionControllerTurnResult,
} from '../../contracts/session';
import type {ClaudeRuntime} from '../runtime';

export function createClaudeSessionController(
	input: CreateSessionControllerInput,
): SessionController {
	const spawnProcess =
		(input.spawnProcess as typeof spawnClaude | undefined) ?? spawnClaude;
	const processConfig = input.processConfig as
		| IsolationConfig
		| IsolationPreset
		| undefined;
	const runtime = input.runtime as ClaudeRuntime | null | undefined;
	const supportsStdoutFeed = typeof runtime?.feedStdout === 'function';
	const supportsTransportDiagnostics =
		typeof runtime?.beginTurn === 'function' &&
		typeof runtime.getTransportStats === 'function';
	let activeChild: ChildProcess | null = null;
	let activeTurnPromise: Promise<SessionControllerTurnResult> | null = null;

	return {
		startTurn({
			prompt,
			continuation,
			configOverride,
			onStderrLine,
		}): Promise<SessionControllerTurnResult> {
			const tokenAccumulator = createTokenAccumulator();
			const messageAccumulator = createAssistantMessageAccumulator();
			let lastStderr = '';
			if (supportsTransportDiagnostics) {
				runtime.beginTurn();
			}

			const turnPromise = new Promise<SessionControllerTurnResult>(resolve => {
				let settled = false;
				const finalize = (exitCode: number | null, error: Error | null) => {
					if (settled) return;
					settled = true;
					tokenAccumulator.flush();
					messageAccumulator.flush();
					activeChild = null;
					activeTurnPromise = null;
					resolve({
						exitCode,
						error,
						tokens: tokenAccumulator.getUsage(),
						streamMessage: messageAccumulator.getLastMessage(),
						lastStderr,
						diagnostics: supportsTransportDiagnostics
							? {transport: runtime.getTransportStats()}
							: undefined,
					});
				};

				try {
					activeChild = spawnProcess({
						prompt,
						projectDir: input.projectDir,
						instanceId: input.instanceId,
						sessionId: resolveClaudeSessionId(continuation),
						isolation: mergeIsolation(
							processConfig,
							input.pluginMcpConfig,
							configOverride as Partial<IsolationConfig> | undefined,
						),
						env: resolveWorkflowSpawnEnv(input.workflow),
						onStdout: (data: string) => {
							tokenAccumulator.feed(data);
							messageAccumulator.feed(data);
							if (supportsStdoutFeed) {
								runtime.feedStdout(data);
							}
						},
						onStderr: (data: string) => {
							const trimmed = data.trim();
							if (!lastStderr) {
								lastStderr = trimmed;
							}
							if (!input.verbose) return;
							onStderrLine?.(trimmed);
						},
						onExit: code => finalize(code, null),
						onError: error => finalize(null, error),
					});
				} catch (error) {
					finalize(
						null,
						error instanceof Error ? error : new Error(String(error)),
					);
				}
			});
			activeTurnPromise = turnPromise;
			return turnPromise;
		},

		interrupt(): void {
			activeChild?.kill('SIGINT');
		},

		async kill(): Promise<void> {
			if (!activeChild) return;
			try {
				activeChild.kill();
				await activeTurnPromise?.catch(() => {});
			} catch {
				// Best effort.
			} finally {
				activeChild = null;
			}
		},
	};
}
