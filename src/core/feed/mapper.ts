// src/feed/mapper.ts
//
// Orchestrator over four internal seams:
//   - RunLifecycle: session/run identity, sequence allocation, counters
//   - DecisionCorrelation: request_id → originating event indexes
//   - ToolCorrelation: tool_use_id → pre event + streamed delta state
//   - AgentMessageStream: assistant message buffering, dedup, transcript replay
//
// Bookkeeping that didn't earn its own seam stays inline here:
//   - active subagent stack (LIFO), subagent descriptions, last task description
//   - last root tasks (todo list)
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
import {createRootPlanTracker} from './internals/rootPlanTracker';
import {
	coerceTaskStatus,
	createTaskLifecycleTracker,
} from './internals/taskLifecycleTracker';
import {createSubagentTracker} from './internals/subagentTracker';
import {readObject, readString} from './internals/projection';
import {
	createToolProjection,
	extractTodoItems,
} from './internals/toolProjection';
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
	const rootPlan = createRootPlanTracker();
	const taskLifecycle = createTaskLifecycleTracker();
	const subagents = createSubagentTracker();

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

	function replayTaskLifecycleToolEvent(e: FeedEvent): void {
		if (e.kind !== 'tool.pre' && e.kind !== 'tool.post') return;
		const data = e.data as {
			tool_name?: string;
			tool_input?: unknown;
			tool_response?: unknown;
		};
		const toolInput = readObject(data.tool_input);
		if (data.tool_name === 'TaskCreate' && e.kind === 'tool.post') {
			const response = readObject(data.tool_response);
			const task = readObject(response['task']);
			const taskId = readString(task['id'], task['task_id']);
			const subject = readString(task['subject'], toolInput['subject']);
			if (taskId && subject) {
				taskLifecycle.upsertCreated({
					taskId,
					subject,
					description: readString(toolInput['description']),
					activeForm: readString(toolInput['activeForm']),
				});
			}
		}
		if (data.tool_name === 'TaskUpdate') {
			const response = readObject(data.tool_response);
			const status = coerceTaskStatus(
				readObject(response['statusChange'])['to'] ?? toolInput['status'],
			);
			const taskId = readString(
				response['taskId'],
				response['task_id'],
				toolInput['taskId'],
				toolInput['task_id'],
			);
			if (taskId && status) {
				taskLifecycle.updateStatus({taskId, status});
			}
		}
	}

	if (bootstrap) {
		runLifecycle.restoreFrom(bootstrap);
		for (const e of bootstrap.feedEvents) {
			if (
				e.kind === 'tool.pre' &&
				e.actor_id === 'agent:root' &&
				(e.data as {tool_name?: string}).tool_name === 'TodoWrite'
			) {
				rootPlan.set(
					extractTodoItems((e.data as {tool_input?: unknown}).tool_input),
				);
			}
			replayTaskLifecycleToolEvent(e);
			if (e.kind === 'task.created') {
				const data = e.data as {
					task_id?: string;
					task_subject?: string;
					task_description?: string;
				};
				if (data.task_id && data.task_subject) {
					taskLifecycle.upsertCreated({
						taskId: data.task_id,
						subject: data.task_subject,
						description: data.task_description,
					});
				}
			}
			if (e.kind === 'task.completed') {
				const data = e.data as {task_id?: string; task_subject?: string};
				if (data.task_id) {
					taskLifecycle.markCompleted({
						taskId: data.task_id,
						subject: data.task_subject,
					});
				}
			}
		}
	}

	// Run boundary (closeRunIntoEvent / beginRun) is owned by RunLifecycle; the
	// projections below receive bound references rather than local choreography.
	const ensureRunArray = runLifecycle.beginRun;
	const closeRunIntoEvent = runLifecycle.closeRunIntoEvent;

	function resolveToolActor(): string {
		return subagents.peek() ?? 'agent:root';
	}

	const toolProjection = createToolProjection({
		ensureRunArray,
		makeEvent,
		runLifecycle,
		toolCorrelation,
		rootPlan,
		taskLifecycle,
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
		runLifecycle,
		actors,
		subagents,
	});

	const fileConfigProjection = createFileConfigProjection({
		ensureRunArray,
		makeEvent,
	});

	const statusProjection = createStatusProjection({
		ensureRunArray,
		makeEvent,
		taskLifecycle,
	});

	const currentScope = (): 'root' | 'subagent' => subagents.currentScope();

	const runSessionProjection = createRunSessionProjection({
		ensureRunArray,
		makeEvent,
		closeRunIntoEvent,
		runLifecycle,
		agentMessageStream,
		rootPlan,
		resolveToolActor,
		currentScope,
	});

	function mapEvent(event: RuntimeEvent): FeedEvent[] {
		const d = event.data as Record<string, unknown>;
		const eventKind = event.kind;
		const results: FeedEvent[] = [];

		// Fallback: emit agent.message from last_assistant_message when transcript yields nothing
		function emitFallbackMessage(
			parentKind: FeedEventKind,
			actorId: string,
			scope: 'root' | 'subagent',
		): void {
			if (results.some(r => r.kind === 'agent.message')) return;
			const msg = readString(d['last_assistant_message']);
			if (!msg) return;
			const parentEvt = results.find(r => r.kind === parentKind);
			const ev = agentMessageStream.emit({
				runtimeEvent: event,
				actorId,
				scope,
				message: msg,
				source: 'hook',
				cause: parentEvt ? {parent_event_id: parentEvt.event_id} : undefined,
			});
			if (ev) results.push(ev);
		}

		// Extract new assistant messages from transcript BEFORE processing the
		// hook event so that agent.message gets a lower seq than tool.pre etc.
		// Skip stop events — they use last_assistant_message to avoid flush-timing dupes.
		const transcriptPath = event.context.transcriptPath;
		const isStopEvent =
			eventKind === 'stop.request' || eventKind === 'subagent.stop';
		if (transcriptPath && !isStopEvent) {
			results.push(
				...agentMessageStream.emitTranscriptMessages(
					transcriptPath,
					event,
					resolveToolActor(),
					currentScope(),
				),
			);
		}

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

		// Stop events: use last_assistant_message directly (always available in payload).
		// Drain the transcript to advance the byte offset and prevent the next event
		// from re-emitting the same text.
		if (eventKind === 'stop.request') {
			if (transcriptPath) agentMessageStream.drainTranscript(transcriptPath);
			emitFallbackMessage('stop.request', 'agent:root', 'root');
		}
		if (eventKind === 'subagent.stop') {
			const agentId = readString(d['agent_id']) ?? 'unknown';
			if (transcriptPath) agentMessageStream.drainTranscript(transcriptPath);
			emitFallbackMessage('subagent.stop', `subagent:${agentId}`, 'subagent');
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
		getTasks: () => [...rootPlan.current(), ...taskLifecycle.current()],
		allocateSeq: () => runLifecycle.allocateSeq(),
	};
}
