import crypto from 'node:crypto';
import path from 'node:path';
import type {ControllerCallbacks} from '../../core/controller/runtimeController';
import type {FeedEvent} from '../../core/feed/types';
import {createFeedMapper} from '../../core/feed/mapper';
import {buildPhaseFeedEvent} from '../../core/feed/phaseFeedEvent';
import {buildSyntheticTaskEvent} from '../../core/feed/syntheticEvents';
import type {JournalTaskProjection} from '../../core/workflows/journalReader';
import {
	type Runtime,
	type RuntimeDecision,
	type RuntimeEvent,
} from '../../core/runtime/types';
import {createWorkflowRunner} from '../../core/workflows/workflowRunner';
import {
	deserializeRunMemory,
	type RunInterruption,
} from '../../core/workflows/runMachine';
import {
	buildUnattendedRules,
	matchRule,
	type HookRule,
} from '../../core/controller/rules';
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
import type {ExecRunOptions, ExecRunResult} from './types';
import {RUN_EXIT_CODE} from './types';
import {DEFAULT_PERMISSION_GRACE_MS} from '../../core/workflows/types';
import type {Interruption} from '@drisp/protocol';
import {
	deferredPermissionDecision,
	describeAnswer,
	describeCall,
	matchesParkedCall,
	summarizeToolInput,
} from './permissionHold';

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

/** The question text an `AskUserQuestion` carries, joined; '' when none. */
function extractQuestionText(event: RuntimeEvent): string {
	const data = event.data as Record<string, unknown>;
	const toolInput = data['tool_input'];
	const questions =
		typeof toolInput === 'object' && toolInput !== null
			? (toolInput as Record<string, unknown>)['questions']
			: undefined;
	if (!Array.isArray(questions)) return '';
	return questions
		.map(q =>
			typeof q === 'object' && q !== null
				? (q as Record<string, unknown>)['question']
				: undefined,
		)
		.filter((q): q is string => typeof q === 'string')
		.join(' | ');
}

/**
 * What an unattended Workflow Run does with an event only a person could
 * answer (#189): the Interruption that parks the Run, or null when the Turn
 * keeps going. A permission is answered inside the Turn when a rule other
 * than an ask rule matches it — under `autonomous` the preset's allow-all
 * policy is such a rule — so only an ask rule, a question, or a permission
 * left unclaimed under a holding preset interrupts. Previously every one of
 * these waited forever on a null-timeout decision; per ADR 0014 they park.
 */
function classifyUnattendedEvent(
	event: RuntimeEvent,
	rules: HookRule[],
): RunInterruption | null {
	const data = event.data as Record<string, unknown>;
	const toolName =
		event.toolName ??
		(typeof data['tool_name'] === 'string' ? data['tool_name'] : undefined);

	if (event.kind === 'permission.request' && toolName !== 'user_input') {
		// ANY permission request, not just Codex's 'user_input': a sandbox
		// approval (e.g. item/fileChange/requestApproval under a read-only
		// sandbox) is equally unanswerable unattended — observed live hanging a
		// headless codex workflow run forever on the null-timeout decision.
		const rule = toolName ? matchRule(rules, toolName) : undefined;
		if (rule?.action === 'ask') {
			return {kind: 'ask_rule', rule: rule.toolName, toolName: toolName!};
		}
		if (rule) return null;
		return {kind: 'unclaimed_permission', toolName: toolName ?? 'unknown tool'};
	}

	if (
		(event.kind === 'tool.pre' && toolName === 'AskUserQuestion') ||
		(event.kind === 'permission.request' && toolName === 'user_input') ||
		event.kind === 'elicitation.request'
	) {
		return {kind: 'question', question: extractQuestionText(event)};
	}

	return null;
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
		exitCode: RUN_EXIT_CODE.RUNTIME,
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

	// Unattended rules (#189): the Workflow's ask rules first, then the
	// isolation preset's policy for whatever they leave unclaimed. Only
	// `autonomous` has one (allow, within the tools the preset grants);
	// under `guarded` / `standard` nothing is seeded, so with no hub attached
	// an unclaimed permission holds until timeoutMs (or abort) — see README
	// "Permissions with no hub" — or, in a Workflow Run, parks the Run.
	const rules: HookRule[] = buildUnattendedRules({
		preset: options.isolationConfig.preset,
		askRules: options.workflow?.askRules,
	});

	let runtimeStarted = false;
	let cumulativeTokens: TokenUsage = {...NULL_TOKENS};
	let streamFinalMessage: string | null = null;
	let mappedFinalMessage: string | null = null;
	let adapterSessionId: string | null = null;
	let activeRunId: string | null = null;
	// The Iteration of the Turn in flight, as the Runner names it on each
	// `startTurn` — what `run.handover` reports as the iteration it
	// interrupted (ADR 0018 §8); the exec runner holds no `RunMemory` itself.
	let currentIteration = 0;
	let beforeTerminalCompletionRan = false;
	let unsubscribeSteers: (() => void) | undefined;
	// Set when a Turn is interrupted to park the Run (#189): an ask rule fired,
	// the agent asked a question no attached human can answer, or a permission
	// went unclaimed under a holding preset. The reducer names the reason.
	let interruption: RunInterruption | null = null;

	// Hold, then park, then replay (#190). A permission request no rule
	// answers is held for the grace window so an attached hub can answer it;
	// with no hub there is nobody to wait for, so the window is zero. When it
	// elapses the call is refused as "deferred" and the Turn ends, parking the
	// Run on the request. On continue, an answer stored since — from the hub's
	// inbox or `--answer` — is replayed into the re-issued call.
	const dashboardDecisionInbox = options.dashboardDecisionInbox;
	const permissionGraceMs = dashboardDecisionInbox
		? Math.max(0, options.permissionGraceMs ?? DEFAULT_PERMISSION_GRACE_MS)
		: 0;
	let hold: {
		eventId: string;
		interruption: RunInterruption;
		timer: ReturnType<typeof setTimeout> | null;
	} | null = null;
	// A decision to send once the event that triggered it has been ingested —
	// the runtime-event loop ingests before it hands the event on, and a
	// decision sent earlier would reach the feed before its request.
	let afterIngest: (() => void) | null = null;

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

	// The Interruption the Run being woken parked on, when it is a deferred
	// permission (#190): what the wake prompt asks the agent to re-issue, and
	// what a stored answer is matched against.
	const parkedInterruption: Interruption | undefined = options.resumeRunId
		? store.getLatestRun()?.interruption
		: undefined;
	const parkedRequestId =
		parkedInterruption?.kind === 'question'
			? parkedInterruption.requestId
			: undefined;
	// The answer stored for that request, if any: given locally on the command
	// line, else the hub's `answer` waiting in the inbox (left there, and out
	// of the drain, until it is replayed).
	let storedAnswer: {
		decision: RuntimeDecision;
		source: 'local' | 'hub';
		consume: () => void;
	} | null = null;
	if (parkedRequestId !== undefined) {
		if (options.storedAnswer) {
			storedAnswer = {
				decision: options.storedAnswer,
				source: 'local',
				consume: () => {},
			};
		} else if (dashboardDecisionInbox) {
			const row = dashboardDecisionInbox
				.pendingForSession({athenaSessionId, limit: 25})
				.find(pending => pending.requestId === parkedRequestId);
			if (row) {
				storedAnswer = {
					decision: row.decision,
					source: 'hub',
					consume: () => dashboardDecisionInbox.markConsumed({id: row.id}),
				};
			}
		}
	}

	let runtime: Runtime;
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

	// Handover state (ADR 0014 §5). A compact.pre on the Run's Agent Session
	// blocks vendor compaction and interrupts the Turn; the workflow runner
	// then forks, distills, and reseeds. While the fork writes the Handoff
	// file its compactions stay blocked too; a failed Handover marks the
	// session degraded so vendor compaction proceeds unhindered.
	let handoverRequest: {handle: string} | null = null;
	let handoverForkInProgress = false;
	const handoverDegradedSessions = new Set<string>();
	const interceptCompaction = (event: RuntimeEvent): string | null => {
		const handle = event.sessionId;
		if (!handle) return null;
		if (handoverDegradedSessions.has(handle)) return null;
		if (handoverForkInProgress) {
			return 'Handover fork in progress — compaction stays blocked while the Handoff file is written.';
		}
		if (handoverRequest === null) {
			handoverRequest = {handle};
			output.notice(
				`handover: context bound reached — forking session ${handle} to write a Handoff file`,
			);
			output.emitJsonEvent('run.handover', {
				adapterSessionId: handle,
				iteration: currentIteration,
			});
			void sessionController.kill();
		}
		return 'Handover in progress — Athena forks the conversation instead of compacting.';
	};

	const controllerCallbacks: ControllerCallbacks = {
		getRules: () => rules,
		// No UI queue in exec; with no hub attached, the runtime never
		// receives a decision and the request holds until timeoutMs (or abort).
		// A Workflow Run parks instead — see `classifyUnattendedEvent` above.
		enqueuePermission: () => {},
		enqueueQuestion: () => {},
		// Handover interception is Claude-only for now: the fork transition
		// rides --fork-session, which Codex has no equivalent for. Non-workflow
		// sessions never intercept — vendor compaction proceeds unchanged.
		...(options.harness === 'claude-code' && options.workflow?.loop?.enabled
			? {interceptCompaction}
			: {}),
		...(options.signal ? {signal: options.signal} : {}),
	};

	const linkedAdapterSessions = new Set<string>();

	function clearHold(): void {
		if (hold?.timer) clearTimeout(hold.timer);
		hold = null;
	}

	/**
	 * The grace window elapsed with no answer: refuse the call as deferred,
	 * remember the request on the Interruption, and end the Turn so the Run
	 * parks. The reducer turns the Interruption into the park sentence and the
	 * wire-shaped `question` an `answer` can address.
	 */
	function deferHeldPermission(): void {
		const held = hold;
		if (!held) return;
		hold = null;
		interruption = held.interruption;
		const toolName =
			held.interruption.kind === 'question'
				? 'question'
				: held.interruption.toolName;
		runtime.sendDecision(
			held.eventId,
			deferredPermissionDecision({toolName, graceMs: permissionGraceMs}),
		);
		output.emitJsonEvent('permission.deferred', {
			requestId: held.eventId,
			toolName,
			graceMs: permissionGraceMs,
		});
		void sessionController.kill();
	}

	/**
	 * A permission an ask rule claimed or no rule answered (#190): replay the
	 * stored answer if this is the call the Run parked on, else hold it for the
	 * grace window. Returns what to do once the event is ingested.
	 */
	function holdOrReplay(
		runtimeEvent: RuntimeEvent,
		next: Extract<RunInterruption, {kind: 'ask_rule' | 'unclaimed_permission'}>,
	): () => void {
		const inputSummary = summarizeToolInput(runtimeEvent);
		const call = describeCall(next.toolName, inputSummary);

		if (
			storedAnswer &&
			matchesParkedCall(parkedInterruption, next.toolName, inputSummary)
		) {
			const answer = storedAnswer;
			storedAnswer = null;
			const replayOf = parkedInterruption.requestId;
			return () => {
				runtime.sendDecision(runtimeEvent.id, answer.decision);
				answer.consume();
				output.notice(
					`replayed the stored ${answer.source} answer (${describeAnswer(answer.decision)}) into the re-issued call ${call}`,
				);
				output.emitJsonEvent('permission.replayed', {
					requestId: runtimeEvent.id,
					replayOf,
					toolName: next.toolName,
					source: answer.source,
					decision: answer.decision,
				});
			};
		}

		hold = {
			eventId: runtimeEvent.id,
			interruption: {
				...next,
				permission: {
					requestId: runtimeEvent.id,
					inputSummary,
					graceMs: permissionGraceMs,
				},
			},
			timer: null,
		};
		if (permissionGraceMs > 0) {
			hold.timer = setTimeout(deferHeldPermission, permissionGraceMs);
			output.notice(
				`holding the ${next.toolName} permission request for ${Math.round(permissionGraceMs / 1000)}s awaiting an answer: ${inputSummary}`,
			);
			output.emitJsonEvent('permission.hold', {
				requestId: runtimeEvent.id,
				toolName: next.toolName,
				graceMs: permissionGraceMs,
			});
			return () => {};
		}
		return deferHeldPermission;
	}

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
			exitCode: RUN_EXIT_CODE.SUCCESS,
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

			// Needs a person (ADR 0014, #189): with no hub attached, nobody can
			// answer — waiting on the null-timeout decision would hang the Run
			// forever. Interrupt the Turn; the runner parks the Run in
			// `awaiting_attention` with the reason preserved. Permissions a rule
			// answers (the autonomous policy, a deny) never get here.
			if (
				options.workflow?.loop?.enabled &&
				interruption === null &&
				hold === null
			) {
				const next = classifyUnattendedEvent(runtimeEvent, rules);
				if (next?.kind === 'question') {
					interruption = next;
					void sessionController.kill();
				} else if (next) {
					afterIngest = holdOrReplay(runtimeEvent, next);
				}
			}

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
			// The permission event is ingested; a replayed answer or an
			// immediate deferral can now follow it.
			const pending = afterIngest;
			afterIngest = null;
			pending?.();
		},
		onDecisionReceived: (eventId: string, decision: RuntimeDecision) => {
			// An answer for the held request arrived inside the grace window
			// (the hub's inbox drain, or a rule): the hold is over and the Turn
			// simply continues.
			if (hold?.eventId === eventId) clearHold();
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
				// The answer stored for the parked request is replayed into the
				// re-issued call, not forwarded to a request id that is gone.
				...(parkedRequestId !== undefined
					? {shouldForward: row => row.requestId !== parkedRequestId}
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

		// Waking a suspended Run (ADR 0016 §2/§6): rehydrate its persisted
		// `RunMemory` and stop reason from the session DB rather than letting
		// `createWorkflowRunner` restart the Run's budgets from zero. This
		// session's store is scoped to `athenaSessionId`, so `getLatestRun()`
		// names the very Run `resumeRunId` points at — guarded defensively in
		// case a future caller ever passes a foreign run id.
		let resumedRunMemory;
		let resumedStopReason;
		if (options.resumeRunId) {
			const resumedRun = store.getLatestRun();
			if (resumedRun?.id === options.resumeRunId) {
				resumedRunMemory =
					deserializeRunMemory(resumedRun.runMemoryJson) ?? undefined;
				resumedStopReason = resumedRun.stopReason;
			}
		}

		const handle = createWorkflowRunner({
			sessionId: athenaSessionId,
			projectDir: options.projectDir,
			harness: options.harness,
			workflow,
			prompt: options.prompt,
			initialContinuation: nextContinuation,
			resumeRunId: options.resumeRunId,
			parkedInterruption,
			// Runner-level notices (e.g. a deprecated marker spelling, #185) reach
			// both the human stderr stream and the JSONL contract.
			onWarning: message => {
				output.warn(message);
				output.emitJsonEvent('exec.warning', {message});
			},
			// The Run moved to a new workflow step (#192): one `phase` FeedEvent
			// into the local feed and the paired feed, and one `run.phase` JSONL
			// event. The phase is not a RuntimeEvent, so it never crosses the
			// FeedMapper; it borrows the mapper's current Session / Feed Run and
			// a mapper-allocated seq so it sorts into the timeline it belongs to.
			onPhaseChange: phase => {
				const sessionId =
					mapper.getSession()?.session_id ??
					adapterSessionId ??
					athenaSessionId;
				const feedEvent = buildPhaseFeedEvent({
					phase,
					sessionId,
					runId: mapper.getCurrentRun()?.run_id ?? `${sessionId}:R0`,
					seq: mapper.allocateSeq(),
					ts: now(),
				});
				safePersist(
					store,
					() => store.recordFeedEvents([feedEvent]),
					message => output.warn(message),
					'recordFeedEvents failed',
				);
				publishFeedEvents([feedEvent]);
				output.emitJsonEvent('run.phase', phase);
			},
			resumedRunMemory,
			resumedStopReason,
			startTurn: async turnInput => {
				currentIteration = turnInput.iteration;
				const turnResult = await sessionController.startTurn({
					prompt: turnInput.prompt,
					continuation: turnInput.continuation,
					configOverride: turnInput.configOverride,
					onStderrLine: message => output.log(message),
				});
				// A Turn that ended on its own while a request was held leaves
				// nothing to defer.
				clearHold();

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
			checkInterruption: () => interruption,
			currentAdapterSessionId,
			handover: {
				takeRequest: () => {
					const request = handoverRequest;
					handoverRequest = null;
					return request;
				},
				onForkStateChange: forking => {
					handoverForkInProgress = forking;
				},
				onDegraded: handle => {
					handoverDegradedSessions.add(handle);
					output.warn(
						`handover failed for session ${handle} — falling back to normal vendor compaction`,
					);
					output.emitJsonEvent('run.handover.degraded', {
						adapterSessionId: handle,
					});
				},
			},
			abortCurrentTurn: () => void sessionController.kill(),
			onIterationComplete: runSnapshot => {
				output.emitJsonEvent('iteration.complete', {
					iteration: runSnapshot.iteration,
					status: runSnapshot.status,
				});
			},
			// A delivered Steer (#191) is reported per Turn it went into; the
			// Runner has already recorded it in the Journal by this point.
			onSteerDelivered: steers => {
				for (const steer of steers) {
					output.notice(
						`steer delivered into Turn ${steer.iteration} (via ${steer.origin}): ${steer.text}`,
					);
					output.emitJsonEvent('run.steer', {
						iteration: steer.iteration,
						origin: steer.origin,
						receivedAt: steer.receivedAt,
						text: steer.text,
					});
				}
			},
			// Task-tool projection (ADR 0015 §7): the Journal's `## Units` table +
			// unit-record frontmatter, diffed against what the Feed already knows
			// and reconciled through the same `task.created`/`task.completed`
			// path a live TodoWrite/TaskCreate/TaskUpdate call would take.
			projectTasks: (tasks: JournalTaskProjection[]) => {
				const known = new Map(
					mapper
						.getTasks()
						.filter(task => task.taskId)
						.map(task => [task.taskId!, task] as const),
				);
				const newEvents: FeedEvent[] = [];
				for (const task of tasks) {
					const existing = known.get(task.taskId);
					if (!existing) {
						newEvents.push(
							...mapper.mapEvent(
								buildSyntheticTaskEvent('task.created', athenaSessionId, {
									task_id: task.taskId,
									task_subject: task.content,
								}),
							),
						);
					}
					if (task.status === 'completed' && existing?.status !== 'completed') {
						newEvents.push(
							...mapper.mapEvent(
								buildSyntheticTaskEvent('task.completed', athenaSessionId, {
									task_id: task.taskId,
									task_subject: task.content,
								}),
							),
						);
					}
				}
				if (newEvents.length > 0) {
					safePersist(
						store,
						() => store.recordFeedEvents(newEvents),
						message => output.warn(message),
						'recordFeedEvents failed',
					);
				}
			},
		});

		activeRunId = handle.runId;

		// Steers reach the Runner through the queue's single subscriber; ones
		// that arrived before this point are flushed here, in order. A Steer is
		// queued, never injected — it heads the next Turn's prompt (#191).
		unsubscribeSteers = options.steerQueue?.subscribe(steer => {
			if (handle.steer(steer)) {
				output.notice(
					`steer queued for the next Turn (via ${steer.origin}): ${steer.text}`,
				);
				output.emitJsonEvent('run.steer.queued', {
					origin: steer.origin,
					receivedAt: steer.receivedAt,
					text: steer.text,
				});
				return;
			}
			output.warn(
				`steer ignored — the workflow run has already ended (via ${steer.origin}): ${steer.text}`,
			);
		});

		const runResult = await handle.result;

		// Accumulate tokens from the runner result
		cumulativeTokens = runResult.tokens;

		// Map runner terminal status to exec failure if applicable.
		// External failures (from runtime event handler) take precedence — check !latch.hasFailure() first.
		if (!latch.hasFailure()) {
			if (runResult.status === 'awaiting_attention') {
				// Suspended, not failed (ADR 0014): the Run waits on a human and
				// remains resumable — a declared block, an unanswerable question,
				// or a tripped bound (the stopReason names which). No failure
				// latch — contrast the old terminal `blocked`/`exhausted`, which
				// registered one. Those statuses are no longer emitted.
				const reason = runResult.stopReason ?? 'awaiting attention';
				output.notice(`workflow run suspended — ${reason}`);
				output.emitJsonEvent('run.suspended', {
					runId: runResult.runId,
					status: 'awaiting_attention',
					stopReason: runResult.stopReason ?? null,
					// The structured Interruption when the Run parked on one (#190);
					// the hub's `needs_human` carries it as-is.
					interruption: runResult.interruption ?? null,
				});
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
		clearHold();
		dashboardDecisionDrain?.stop();
		unsubscribeSteers?.();
		await writeLastMessageBeforeTerminalCompletion();
		await runBeforeTerminalCompletion();
		await sessionController.kill();
		runtimeEventLoop.stop();
		if (runtimeStarted) {
			runtime.stop();
		}
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
	const success = exitCode === RUN_EXIT_CODE.SUCCESS;
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
