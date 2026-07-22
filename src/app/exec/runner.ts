import crypto from 'node:crypto';
import path from 'node:path';
import type {ControllerCallbacks} from '../../core/controller/runtimeController';
import type {FeedEvent} from '../../core/feed/types';
import {createFeedMapper} from '../../core/feed/mapper';
import {
	type RuntimeDecision,
	type RuntimeEvent,
} from '../../core/runtime/types';
import {createWorkflowRunner} from '../../core/workflows/workflowRunner';
import type {TurnContinuation} from '../../core/runtime/process';
import {
	createSessionStore,
	sessionsDir,
	type SessionStore,
} from '../../infra/sessions';
import {resolveHarnessAdapter} from '../../harnesses/registry';
import type {TokenUsage} from '../../shared/types/headerMetrics';
import {createRuntime} from '../runtime/createRuntime';
import {
	createRelayPermissionCallback,
	createRelayQuestionCallback,
} from '../channels/relayAdapter';
import {startSessionBridge} from '../channels/sessionBridgeLifecycle';
import {
	createPairedFeedPublisher,
	type FeedSink,
} from '../dashboard/pairedFeedPublisher';
import {
	attachRuntimeEventLoop,
	startDashboardDecisionDrain,
	type DashboardDecisionDrain,
} from '../runtime/runtimeEventLoop';
import {findLastMappedAgentMessage, resolveFinalMessage} from './finalMessage';
import {createFailureLatch, exitCodeFromFailure} from './failureLatch';
import {createExecOutputWriter} from './output';
import type {
	ExecRunFailure,
	ExecRunOptions,
	ExecRunResult,
	ExecWorkflowFailureState,
} from './types';
import {EXEC_EXIT_CODE} from './types';

const NULL_TOKENS: TokenUsage = {
	input: null,
	output: null,
	cacheRead: null,
	cacheWrite: null,
	total: null,
	contextSize: null,
	contextWindowSize: null,
};

/**
 * Build a concise human-facing startup notice for active personal
 * capabilities — labeled "personal" to distinguish them from workflow plugins.
 * Returns null when nothing is active (caller stays silent). Prints name +
 * source layer ONLY; never command/args/env (MCP) or path (skills).
 */
function formatPersonalCapabilityNotice(summary: {
	mcpServers: ReadonlyArray<{name: string; sourceLayer: string}>;
	skills: ReadonlyArray<{name: string; sourceLayer: string}>;
}): string | null {
	const parts: string[] = [];
	if (summary.mcpServers.length > 0) {
		const list = summary.mcpServers
			.map(server => `${server.name} [${server.sourceLayer}]`)
			.join(', ');
		parts.push(`mcp servers: ${list}`);
	}
	if (summary.skills.length > 0) {
		const list = summary.skills
			.map(skill => `${skill.name} [${skill.sourceLayer}]`)
			.join(', ');
		parts.push(`skills: ${list}`);
	}
	if (parts.length === 0) return null;
	return `personal capabilities active — ${parts.join('; ')}`;
}

/**
 * Build a human-facing WARNING notice for personal capabilities shadowed by a
 * same-named workflow plugin (plugin wins, personal skipped). Returns null when
 * there are no conflicts. Prints name + source layer ONLY.
 */
function formatCapabilityConflictNotice(summary: {
	mcpServers: ReadonlyArray<{name: string; sourceLayer: string}>;
	skills: ReadonlyArray<{name: string; sourceLayer: string}>;
}): string | null {
	const parts: string[] = [];
	if (summary.mcpServers.length > 0) {
		const list = summary.mcpServers
			.map(server => `${server.name} [${server.sourceLayer}]`)
			.join(', ');
		parts.push(`mcp servers: ${list}`);
	}
	if (summary.skills.length > 0) {
		const list = summary.skills
			.map(skill => `${skill.name} [${skill.sourceLayer}]`)
			.join(', ');
		parts.push(`skills: ${list}`);
	}
	if (parts.length === 0) return null;
	return `personal capability conflicts — workflow plugin wins; shadowed: ${parts.join(
		'; ',
	)}`;
}

function workflowFailure(
	state: ExecWorkflowFailureState,
	message: string,
): ExecRunFailure {
	return {
		kind: 'workflow',
		state,
		message,
	};
}

function buildEarlyFailureResult(input: {
	now: () => number;
	startTs: number;
	athenaSessionId: string;
	ephemeral: boolean | undefined;
	message: string;
}): ExecRunResult {
	return {
		success: false,
		exitCode: EXEC_EXIT_CODE.RUNTIME,
		athenaSessionId: input.ephemeral ? null : input.athenaSessionId,
		adapterSessionId: null,
		finalMessage: null,
		tokens: {...NULL_TOKENS},
		durationMs: Math.max(0, input.now() - input.startTs),
		failure: {kind: 'process', message: input.message},
	};
}

function safePersist(
	store: SessionStore | undefined,
	action: () => void,
	onError: (message: string) => void,
	errorLabel: string,
): void {
	if (!store) return;
	try {
		action();
	} catch (error) {
		store.markDegraded(
			`${errorLabel}: ${error instanceof Error ? error.message : String(error)}`,
		);
		onError(
			`${errorLabel}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export async function runExec(options: ExecRunOptions): Promise<ExecRunResult> {
	const now = options.now ?? Date.now;
	const startTs = now();
	const verbose = options.verbose ?? false;
	const json = options.json ?? false;
	const instanceId = options.instanceId ?? process.pid;
	const runtimeFactory = options.runtimeFactory ?? createRuntime;
	const sessionStoreFactory = options.sessionStoreFactory ?? createSessionStore;
	const athenaSessionId = options.athenaSessionId ?? crypto.randomUUID();
	// Execution only needs to publish FeedEvents (a FeedSink). An injected sink
	// is owned by the caller (the runtime daemon owns its transport lifecycle);
	// when none is injected we create — and therefore must close — our own
	// durable publisher, used here purely as a sink.
	const ownedFeedPublisher = options.dashboardFeedPublisher
		? null
		: createPairedFeedPublisher();
	const dashboardFeedPublisher: FeedSink =
		options.dashboardFeedPublisher ?? ownedFeedPublisher!;
	const dashboardOrigin = options.dashboardOrigin ?? 'local';

	const output = createExecOutputWriter({
		json,
		verbose,
		stdout: options.stdout ?? process.stdout,
		stderr: options.stderr ?? process.stderr,
		now,
	});

	// Exec does not pre-seed rules from isolation defaults; channel relay (or
	// the absence of one) governs approvals.
	const rules: import('../../core/controller/rules').HookRule[] = [];

	let runtimeStarted = false;
	let cumulativeTokens: TokenUsage = {...NULL_TOKENS};
	let streamFinalMessage: string | null = null;
	let mappedFinalMessage: string | null = null;
	let adapterSessionId: string | null = null;
	let activeRunId: string | null = null;
	let beforeTerminalCompletionRan = false;

	let store: SessionStore;
	try {
		store = sessionStoreFactory({
			sessionId: athenaSessionId,
			projectDir: options.projectDir,
			dbPath: options.ephemeral
				? ':memory:'
				: path.join(sessionsDir(), athenaSessionId, 'session.db'),
		});
	} catch (error) {
		const message = `Failed to initialize session store: ${
			error instanceof Error ? error.message : String(error)
		}`;
		output.error(message);
		output.emitJsonEvent('exec.error', {kind: 'process', message});
		return buildEarlyFailureResult({
			now,
			startTs,
			athenaSessionId,
			ephemeral: options.ephemeral,
			message,
		});
	}
	const mapperBootstrap = store.toBootstrap();
	const mapper = createFeedMapper(mapperBootstrap);
	mappedFinalMessage = findLastMappedAgentMessage(
		mapperBootstrap?.feedEvents ?? [],
	);

	let runtime;
	try {
		runtime = runtimeFactory({
			harness: options.harness,
			projectDir: options.projectDir,
			instanceId,
			workflow: options.workflow,
		});
	} catch (error) {
		const message = `Failed to initialize runtime: ${
			error instanceof Error ? error.message : String(error)
		}`;
		store.close();
		output.error(message);
		output.emitJsonEvent('exec.error', {kind: 'process', message});
		return buildEarlyFailureResult({
			now,
			startTs,
			athenaSessionId,
			ephemeral: options.ephemeral,
			message,
		});
	}
	const harnessAdapter = resolveHarnessAdapter(options.harness);
	const sessionController = harnessAdapter.createSessionController({
		projectDir: options.projectDir,
		instanceId,
		processConfig: options.isolationConfig,
		pluginMcpConfig: options.pluginMcpConfig,
		verbose,
		workflow: options.workflow,
		workflowPlan: options.workflowPlan,
		ephemeral: options.ephemeral,
		runtime,
		spawnProcess: options.spawnProcess as
			| ((options: unknown) => import('node:child_process').ChildProcess)
			| undefined,
	});

	const latch = createFailureLatch(next => {
		output.error(next.message);
		output.emitJsonEvent('exec.error', {
			kind: next.kind,
			message: next.message,
		});
		void sessionController.kill();
	});

	const abortListener = (): void => {
		latch.register({kind: 'process', message: 'Execution cancelled.'});
	};
	if (options.signal?.aborted) {
		abortListener();
	} else {
		options.signal?.addEventListener('abort', abortListener, {once: true});
	}

	const currentAdapterSessionId = (): string | null => adapterSessionId;

	const bridgeFactory = options.bridgeFactory ?? startSessionBridge;
	const bridge =
		options.channels && options.channels.length > 0
			? await bridgeFactory({
					runtimeId: athenaSessionId,
					defaultAgentId: 'main',
					...(options.signal ? {signal: options.signal} : {}),
				})
			: null;

	const controllerCallbacks: ControllerCallbacks = {
		getRules: () => rules,
		// No UI queue in exec; with no bridge attached, the runtime never
		// receives a decision and the request blocks until timeoutMs (or abort).
		enqueuePermission: () => {},
		enqueueQuestion: () => {},
		...(bridge
			? {
					relayPermission: createRelayPermissionCallback(bridge, runtime),
					relayQuestion: createRelayQuestionCallback(bridge, runtime),
				}
			: {}),
		...(options.signal ? {signal: options.signal} : {}),
	};

	const dashboardDecisionInbox = options.dashboardDecisionInbox;

	const linkedAdapterSessions = new Set<string>();

	function publishFeedEvents(feedEvents: readonly FeedEvent[]): void {
		if (feedEvents.length === 0) return;
		dashboardFeedPublisher.publish({
			origin: dashboardOrigin,
			athenaSessionId,
			feedEvents,
		});
	}

	const runBeforeTerminalCompletion = async (): Promise<void> => {
		if (
			beforeTerminalCompletionRan ||
			latch.hasFailure() ||
			!options.beforeTerminalCompletion
		) {
			return;
		}
		beforeTerminalCompletionRan = true;
		const resolved = resolveFinalMessage({
			streamMessage: streamFinalMessage,
			mappedMessage: mappedFinalMessage,
		});
		const provisionalResult: ExecRunResult = {
			success: true,
			exitCode: EXEC_EXIT_CODE.SUCCESS,
			athenaSessionId: options.ephemeral ? null : athenaSessionId,
			adapterSessionId,
			finalMessage: resolved.message,
			tokens: cumulativeTokens,
			durationMs: Math.max(0, now() - startTs),
		};
		try {
			const feedEvents = await options.beforeTerminalCompletion({
				result: provisionalResult,
				runId: activeRunId,
			});
			if (feedEvents && feedEvents.length > 0) {
				publishFeedEvents(feedEvents);
			}
		} catch (error) {
			latch.register({
				kind: 'output',
				message: `Artifact upload failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			});
		}
	};

	const writeLastMessageBeforeTerminalCompletion = async (): Promise<void> => {
		if (latch.hasFailure() || !options.outputLastMessagePath) return;
		const resolved = resolveFinalMessage({
			streamMessage: streamFinalMessage,
			mappedMessage: mappedFinalMessage,
		});
		try {
			await output.writeLastMessage(
				options.outputLastMessagePath,
				resolved.message,
			);
		} catch (error) {
			latch.register({
				kind: 'output',
				message: `Failed writing --output-last-message: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	};

	// Headless adapter over the shared runtime-event loop: the loop owns the
	// subscribe → ingest → sendDecision → publish assembly; exec injects only its
	// JSONL emission, adapter-session linking, and final-message tracking.
	const runtimeEventLoop = attachRuntimeEventLoop({
		runtime,
		ingest: {
			mapper,
			store,
			controllerCallbacks,
			onPersistFailure: message => output.warn(message),
		},
		onEventReceived: (runtimeEvent: RuntimeEvent) => {
			adapterSessionId = runtimeEvent.sessionId;

			// Link new adapter sessions to the active workflow run
			if (
				runtimeEvent.sessionId &&
				activeRunId &&
				!linkedAdapterSessions.has(runtimeEvent.sessionId)
			) {
				linkedAdapterSessions.add(runtimeEvent.sessionId);
				safePersist(
					store,
					() => store.linkAdapterSession(runtimeEvent.sessionId!, activeRunId!),
					message => output.warn(message),
					'linkAdapterSession failed',
				);
			}

			output.emitJsonEvent('runtime.event', {
				id: runtimeEvent.id,
				kind: runtimeEvent.kind,
				hookName: runtimeEvent.hookName,
				sessionId: runtimeEvent.sessionId,
				toolName: runtimeEvent.toolName ?? null,
				data: runtimeEvent.data,
			});
		},
		skipEvent: () => latch.hasFailure(),
		emitEventFeed: feedEvents => {
			for (const event of feedEvents) {
				if (event.kind === 'agent.message') {
					mappedFinalMessage = event.data.message;
				}
			}
			publishFeedEvents(feedEvents);
		},
		onDecisionReceived: (eventId: string, decision: RuntimeDecision) => {
			output.emitJsonEvent('runtime.decision', {
				eventId,
				decision,
			});
		},
		emitDecisionFeed: feedEvent => {
			if (feedEvent) {
				publishFeedEvents([feedEvent]);
			}
		},
	});

	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	let dashboardDecisionDrain: DashboardDecisionDrain | undefined;
	if (typeof options.timeoutMs === 'number' && options.timeoutMs > 0) {
		timeoutTimer = setTimeout(() => {
			latch.register({
				kind: 'timeout',
				message: `Execution timed out after ${options.timeoutMs}ms.`,
			});
		}, options.timeoutMs);
	}

	const personalCapabilities = options.personalCapabilities ?? {
		mcpServers: [],
		skills: [],
	};
	const capabilityConflicts = options.capabilityConflicts ?? {
		mcpServers: [],
		skills: [],
	};

	output.emitJsonEvent('exec.started', {
		projectDir: options.projectDir,
		harness: options.harness,
		athenaSessionId: options.ephemeral ? null : athenaSessionId,
		personalCapabilities,
		capabilityConflicts,
	});

	const personalCapabilityNotice =
		formatPersonalCapabilityNotice(personalCapabilities);
	if (personalCapabilityNotice) {
		output.notice(personalCapabilityNotice);
	}

	const capabilityConflictNotice =
		formatCapabilityConflictNotice(capabilityConflicts);
	if (capabilityConflictNotice) {
		output.notice(capabilityConflictNotice);
	}

	try {
		await runtime.start();
		runtimeStarted = true;
		output.emitJsonEvent('runtime.started', {
			status: runtime.getStatus(),
		});
		if (dashboardDecisionInbox) {
			dashboardDecisionDrain = startDashboardDecisionDrain({
				runtime,
				inbox: dashboardDecisionInbox,
				athenaSessionId,
				...(options.dashboardDecisionPollIntervalMs !== undefined
					? {pollIntervalMs: options.dashboardDecisionPollIntervalMs}
					: {}),
				onError: error =>
					output.warn(
						`dashboard decision failed: ${
							error instanceof Error ? error.message : String(error)
						}`,
					),
				configureTimer: timer => timer.unref(),
			});
		}

		const workflow = options.workflow;

		output.emitJsonEvent('run.started', {
			workflow: workflow?.name ?? null,
			loopEnabled: workflow?.loop?.enabled ?? false,
		});

		const nextContinuation: TurnContinuation = options.adapterResumeSessionId
			? {mode: 'resume', handle: options.adapterResumeSessionId}
			: {mode: 'fresh'};

		const handle = createWorkflowRunner({
			sessionId: athenaSessionId,
			projectDir: options.projectDir,
			harness: options.harness,
			workflow,
			prompt: options.prompt,
			initialContinuation: nextContinuation,
			startTurn: async turnInput => {
				const turnResult = await sessionController.startTurn({
					prompt: turnInput.prompt,
					continuation: turnInput.continuation,
					configOverride: turnInput.configOverride,
					onStderrLine: message => output.log(message),
				});

				if (turnResult.streamMessage) {
					streamFinalMessage = turnResult.streamMessage;
				}

				const sessionIdForTokens = currentAdapterSessionId();
				if (sessionIdForTokens !== null) {
					safePersist(
						store,
						() => store.recordTokens(sessionIdForTokens, turnResult.tokens),
						message => output.warn(message),
						'recordTokens failed',
					);
				}

				return turnResult;
			},
			persistRunState: runSnapshot => {
				safePersist(
					store,
					() => store.persistRun(runSnapshot),
					message => output.warn(message),
					'persistRun failed',
				);
			},
			abortCurrentTurn: () => void sessionController.kill(),
			onIterationComplete: runSnapshot => {
				output.emitJsonEvent('iteration.complete', {
					iteration: runSnapshot.iteration,
					status: runSnapshot.status,
				});
			},
		});

		activeRunId = handle.runId;

		const runResult = await handle.result;

		// Accumulate tokens from the runner result
		cumulativeTokens = runResult.tokens;

		// Map runner terminal status to exec failure if applicable.
		// External failures (from runtime event handler) take precedence — check !latch.hasFailure() first.
		if (!latch.hasFailure()) {
			if (runResult.status === 'blocked') {
				latch.register(
					workflowFailure(
						'blocked',
						runResult.stopReason
							? `Workflow blocked: ${runResult.stopReason}`
							: 'Workflow blocked.',
					),
				);
			} else if (runResult.status === 'exhausted') {
				latch.register(
					workflowFailure(
						'exhausted',
						`Workflow reached the maximum of ${workflow?.loop?.maxIterations ?? 0} iterations.`,
					),
				);
			} else if (runResult.status === 'failed') {
				latch.register({
					kind: 'process',
					message: runResult.stopReason ?? 'Workflow run failed.',
				});
			}
		}
	} catch (error) {
		latch.register({
			kind: 'process',
			message: error instanceof Error ? error.message : String(error),
		});
	} finally {
		options.signal?.removeEventListener('abort', abortListener);
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
		}
		dashboardDecisionDrain?.stop();
		await writeLastMessageBeforeTerminalCompletion();
		await runBeforeTerminalCompletion();
		await sessionController.kill();
		runtimeEventLoop.stop();
		if (runtimeStarted) {
			runtime.stop();
		}
		await bridge?.stop();
		store.close();
		ownedFeedPublisher?.close();
	}

	const resolvedFinalMessage = resolveFinalMessage({
		streamMessage: streamFinalMessage,
		mappedMessage: mappedFinalMessage,
	});
	if (resolvedFinalMessage.source === 'empty' && !latch.hasFailure()) {
		const warning =
			'No assistant message found in stream or hook events; writing empty output.';
		output.warn(warning);
		output.emitJsonEvent('exec.warning', {message: warning});
	}

	const failure = latch.current();
	const exitCode = exitCodeFromFailure(failure);
	const success = exitCode === EXEC_EXIT_CODE.SUCCESS;
	const finalMessage = success ? resolvedFinalMessage.message : null;
	if (success && finalMessage !== null) {
		output.printFinalMessage(finalMessage);
	}

	const durationMs = Math.max(0, now() - startTs);
	const result: ExecRunResult = {
		success,
		exitCode,
		athenaSessionId: options.ephemeral ? null : athenaSessionId,
		adapterSessionId,
		finalMessage,
		tokens: cumulativeTokens,
		durationMs,
		...(failure ? {failure} : {}),
	};

	output.emitJsonEvent('exec.completed', {
		success: result.success,
		exitCode: result.exitCode,
		athenaSessionId: result.athenaSessionId,
		adapterSessionId: result.adapterSessionId,
		finalMessage: result.finalMessage,
		tokens: result.tokens,
		durationMs: result.durationMs,
		harnessExitCode: null,
	});

	return result;
}
