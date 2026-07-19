// src/feed/mapper.ts
//
// Orchestrator over five internal seams:
//   - RunLifecycle: session/run identity, sequence allocation, counters
//   - DecisionCorrelation: request_id → originating event indexes
//   - ToolCorrelation: tool_use_id → pre event + streamed delta state
//   - AgentMessageStream: assistant message buffering, dedup, transcript replay
//   - SubagentLifecycle: subagent actor-id formation, active stack (LIFO),
//     pending-description handoff, description registry, actor-registration effects
//
// Bookkeeping that didn't earn its own seam stays inline here:
//   - last task description, last root tasks (todo list)
//   - actor registry

import type {RuntimeEvent, RuntimeDecision} from '../runtime/types';
import type {RuntimeEventKind} from '../runtime/events';
import type {
	FeedEvent,
	FeedEventKind,
	FeedEventLevel,
	FeedEventCause,
} from './types';
import type {Session, Run, Actor} from './entities';
import type {MapperBootstrap} from './bootstrap';
import {type TodoItem} from './todo';
import {ActorRegistry} from './entities';
import {composeTitle} from './titleGen';
import {createTranscriptReader} from './transcript';
import {createRunLifecycle} from './internals/runLifecycle';
import {createDecisionCorrelation} from './internals/decisionCorrelation';
import {createToolCorrelation} from './internals/toolCorrelation';
import {createAgentMessageStream} from './internals/agentMessageStream';
import {createTaskStateTracker} from './internals/taskStateTracker';
import {readString} from './internals/projection';
import {createSubagentLifecycle} from './internals/subagentLifecycle';
import {createToolProjection} from './internals/toolProjection';
import {createNotificationProjection} from './internals/notificationProjection';
import {createDecisionProjection} from './internals/decisionProjection';
import {createSubagentProjection} from './internals/subagentProjection';
import {createFileConfigProjection} from './internals/fileConfigProjection';
import {createRunSessionProjection} from './internals/runSessionProjection';
import {createStatusProjection} from './internals/statusProjection';

export type FeedMapper = {
	mapEvent(event: RuntimeEvent): FeedEvent[];
	mapDecision(eventId: string, decision: RuntimeDecision): FeedEvent | null;
	getSession(): Session | null;
	getCurrentRun(): Run | null;
	getActors(): Actor[];
	getTasks(): TodoItem[];
	allocateSeq(): number;
};

const RUN_SESSION_EVENT_KINDS = new Set<RuntimeEventKind>([
	'session.start',
	'session.end',
	'user.prompt',
	'turn.start',
	'message.delta',
	'message.complete',
	'turn.complete',
	'plan.delta',
	'reasoning.delta',
	'usage.update',
]);

const TOOL_EVENT_KINDS = new Set<RuntimeEventKind>([
	'tool.delta',
	'tool.pre',
	'tool.post',
	'tool.failure',
]);

const DECISION_EVENT_KINDS = new Set<RuntimeEventKind>([
	'permission.request',
	'stop.request',
	'stop.failure',
	'permission.denied',
	'elicitation.request',
	'elicitation.result',
]);

const SUBAGENT_EVENT_KINDS = new Set<RuntimeEventKind>([
	'subagent.start',
	'subagent.stop',
]);

const FILE_CONFIG_EVENT_KINDS = new Set<RuntimeEventKind>([
	'compact.pre',
	'setup',
	'config.change',
	'compact.post',
	'cwd.changed',
	'file.changed',
	'instructions.loaded',
	'worktree.create',
	'worktree.remove',
]);

const STATUS_EVENT_KINDS = new Set<RuntimeEventKind>([
	'teammate.idle',
	'task.completed',
	'task.created',
]);

export function createFeedMapper(bootstrap?: MapperBootstrap): FeedMapper {
	// Run boundary collaborators. The resetPerRunState thunk and the (hoisted)
	// makeEvent are wired into RunLifecycle so it owns the close → reset → open →
	// emit choreography; the thunk closes over collaborators declared below but is
	// only invoked at run-rollover time, never during construction.
	const runLifecycle = createRunLifecycle({
		makeEvent,
		resetPerRunState: () => {
			toolCorrelation.resetForNewRun();
			decisionCorrelation.resetForNewRun();
			agentMessageStream.resetForNewRun();
			subagents.clear();
		},
	});
	const decisionCorrelation = createDecisionCorrelation();
	const toolCorrelation = createToolCorrelation();
	const transcriptReader = createTranscriptReader();
	const actors = new ActorRegistry();
	const taskState = createTaskStateTracker();
	const subagents = createSubagentLifecycle({actors, runLifecycle});

	function makeEvent(
		kind: FeedEventKind,
		level: FeedEventLevel,
		actorId: string,
		data: unknown,
		runtimeEvent: RuntimeEvent,
		cause?: Partial<FeedEventCause>,
	): FeedEvent {
		const s = runLifecycle.allocateSeq();
		const runId = runLifecycle.getRunId();
		const eventId = `${runId}:E${s}`;

		const baseCause: FeedEventCause = {
			hook_request_id: runtimeEvent.id,
			transcript_path: runtimeEvent.context.transcriptPath,
			...cause,
		};

		const fe = {
			event_id: eventId,
			seq: s,
			ts: runtimeEvent.timestamp,
			session_id: runtimeEvent.sessionId,
			run_id: runId,
			prompt_id: runtimeEvent.promptId,
			kind,
			level,
			actor_id: actorId,
			cause: baseCause,
			title: '',
			display: runtimeEvent.display,
			raw: runtimeEvent.payload,
			data,
		} as FeedEvent;

		fe.title = composeTitle(fe, runtimeEvent);

		if (
			runtimeEvent.interaction.expectsDecision ||
			kind === 'permission.request' ||
			kind === 'stop.request'
		) {
			decisionCorrelation.recordRequest(runtimeEvent.id, eventId, kind);
		}

		return fe;
	}

	const agentMessageStream = createAgentMessageStream(
		makeEvent,
		transcriptReader,
	);

	if (bootstrap) {
		runLifecycle.restoreFrom(bootstrap);
		taskState.restore(bootstrap.feedEvents);
	}

	// Run boundary (closeRunIntoEvent / beginRun) is owned by RunLifecycle; the
	// projections below receive bound references rather than local choreography.
	const ensureRunArray = runLifecycle.beginRun;
	const closeRunIntoEvent = runLifecycle.closeRunIntoEvent;

	function resolveToolActor(): string {
		return subagents.currentActor();
	}

	const toolProjection = createToolProjection({
		ensureRunArray,
		makeEvent,
		runLifecycle,
		toolCorrelation,
		taskState,
		subagents,
		resolveToolActor,
	});

	const notificationProjection = createNotificationProjection({
		ensureRunArray,
		makeEvent,
		decisionCorrelation,
	});

	const decisionProjection = createDecisionProjection({
		ensureRunArray,
		makeEvent,
		runLifecycle,
		decisionCorrelation,
	});

	const subagentProjection = createSubagentProjection({
		ensureRunArray,
		makeEvent,
		subagents,
	});

	const fileConfigProjection = createFileConfigProjection({
		ensureRunArray,
		makeEvent,
	});

	const statusProjection = createStatusProjection({
		ensureRunArray,
		makeEvent,
		taskState,
	});

	const currentScope = (): 'root' | 'subagent' => subagents.currentScope();

	const runSessionProjection = createRunSessionProjection({
		ensureRunArray,
		makeEvent,
		closeRunIntoEvent,
		runLifecycle,
		agentMessageStream,
		taskState,
		resolveToolActor,
		currentScope,
	});

	function mapEvent(event: RuntimeEvent): FeedEvent[] {
		const d = event.data as Record<string, unknown>;
		const eventKind = event.kind;
		const results: FeedEvent[] = [];

		// AgentMessageStream owns the transcript-before-event replay timing (and
		// the rule that stop events drain + fall back instead of replaying).
		results.push(
			...agentMessageStream.replayBeforeEvent(
				event,
				resolveToolActor(),
				currentScope(),
			),
		);

		if (RUN_SESSION_EVENT_KINDS.has(eventKind)) {
			results.push(...runSessionProjection.mapRunSessionEvent(event, d));
		} else if (TOOL_EVENT_KINDS.has(eventKind)) {
			results.push(...toolProjection.mapToolEvent(event, d));
		} else if (DECISION_EVENT_KINDS.has(eventKind)) {
			results.push(...decisionProjection.mapRequestEvent(event, d));
		} else if (SUBAGENT_EVENT_KINDS.has(eventKind)) {
			results.push(...subagentProjection.mapSubagentEvent(event, d));
		} else if (eventKind === 'notification') {
			results.push(...notificationProjection.mapNotification(event, d));
		} else if (FILE_CONFIG_EVENT_KINDS.has(eventKind)) {
			results.push(...fileConfigProjection.mapFileConfigEvent(event, d));
		} else if (STATUS_EVENT_KINDS.has(eventKind)) {
			results.push(...statusProjection.mapStatusEvent(event, d));
		} else if (eventKind === 'unknown') {
			results.push(...ensureRunArray(event));
			const unknownEvt = makeEvent(
				'unknown.hook',
				'debug',
				'system',
				{
					hook_event_name:
						readString(
							d['source_event_name'],
							d['hook_event_name'],
							event.hookName,
						) ?? 'unknown',
					payload: d.payload ?? null,
				} satisfies import('./types').UnknownHookData,
				event,
			);
			unknownEvt.ui = {collapsed_default: true};
			results.push(unknownEvt);
		}

		// Stop events: AgentMessageStream drains the transcript and falls back to
		// last_assistant_message (deduped against any agent.message already emitted).
		if (eventKind === 'stop.request') {
			results.push(
				...agentMessageStream.emitStopFallback(event, {
					actorId: 'agent:root',
					scope: 'root',
					parentKind: 'stop.request',
					priorResults: results,
				}),
			);
		}
		if (eventKind === 'subagent.stop') {
			const agentId = readString(d['agent_id']) ?? 'unknown';
			results.push(
				...agentMessageStream.emitStopFallback(event, {
					actorId: subagents.actorIdFor(agentId),
					scope: 'subagent',
					parentKind: 'subagent.stop',
					priorResults: results,
				}),
			);
		}

		return results;
	}

	function mapDecision(
		requestId: string,
		decision: RuntimeDecision,
	): FeedEvent | null {
		return decisionProjection.mapDecision(requestId, decision);
	}

	return {
		mapEvent,
		mapDecision,
		getSession: () => runLifecycle.getSession(),
		getCurrentRun: () => runLifecycle.getCurrentRun(),
		getActors: () => actors.all(),
		getTasks: () => taskState.current(),
		allocateSeq: () => runLifecycle.allocateSeq(),
	};
}
