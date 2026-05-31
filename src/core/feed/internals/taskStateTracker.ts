// src/core/feed/internals/taskStateTracker.ts

import type {FeedEvent} from '../types';
import {type TodoItem, type TodoWriteInput} from '../todo';
import {createRootPlanTracker} from './rootPlanTracker';
import {
	coerceTaskStatus,
	createTaskLifecycleTracker,
} from './taskLifecycleTracker';
import {readObject, readString} from './projection';

/**
 * Owns all Root-plan and task-lifecycle SOURCE INTERPRETATION for the
 * FeedMapper: how a TodoWrite input, a Codex plan delta, a TaskCreate/TaskUpdate
 * tool event, and a task.created/task.completed event each update the canonical
 * task list. Both live event projections and bootstrap restore drive the task
 * list through these methods, so the interpretation lives in exactly one place.
 *
 * State is delegated to two pure trackers (rootPlanTracker for the Codex plan,
 * taskLifecycleTracker for Claude tasks); this module concentrates the
 * interpretation and restore behavior on top of them.
 */
export type TaskStateTracker = {
	/** Combined task list: Codex plan items first, then Claude lifecycle tasks. */
	current(): TodoItem[];
	/** Interpret a tool.pre event (TodoWrite plan replace, TaskUpdate status). */
	applyToolPre(input: {
		toolName: string;
		toolInput: Record<string, unknown>;
		actorId: string;
	}): void;
	/** Interpret a tool.post event (TaskCreate, TaskUpdate status). */
	applyToolPost(input: {
		toolName: string;
		toolInput: Record<string, unknown>;
		toolResponse: unknown;
	}): void;
	/** Interpret a Codex plan delta; returns true iff the plan changed. */
	applyPlanDelta(planSteps: unknown): boolean;
	/** Interpret a task.created event payload. */
	applyTaskCreatedEvent(data: Record<string, unknown>): void;
	/** Interpret a task.completed event payload. */
	applyTaskCompletedEvent(data: Record<string, unknown>): void;
	/** Restore plan + task lifecycle state by replaying stored feed events. */
	restore(feedEvents: readonly FeedEvent[]): void;
};

export function extractTodoItems(toolInput: unknown): TodoItem[] {
	const input = toolInput as TodoWriteInput | undefined;
	return Array.isArray(input?.todos) ? input.todos : [];
}

function mapPlanStepStatus(status: string | undefined): TodoItem['status'] {
	switch (status) {
		case 'inProgress':
			return 'in_progress';
		case 'completed':
			return 'completed';
		case undefined:
		default:
			return 'pending';
	}
}

export function createTaskStateTracker(): TaskStateTracker {
	const rootPlan = createRootPlanTracker();
	const taskLifecycle = createTaskLifecycleTracker();

	function applyToolPre(input: {
		toolName: string;
		toolInput: Record<string, unknown>;
		actorId: string;
	}): void {
		const {toolName, toolInput, actorId} = input;
		if (toolName === 'TodoWrite' && actorId === 'agent:root') {
			rootPlan.set(extractTodoItems(toolInput));
		}
		if (toolName === 'TaskUpdate') {
			const taskId = readString(toolInput['taskId'], toolInput['task_id']);
			const status = coerceTaskStatus(toolInput['status']);
			if (taskId && status) {
				taskLifecycle.updateStatus({taskId, status});
			}
		}
	}

	function applyToolPost(input: {
		toolName: string;
		toolInput: Record<string, unknown>;
		toolResponse: unknown;
	}): void {
		const {toolName, toolInput, toolResponse} = input;
		if (toolName === 'TaskCreate') {
			const response = readObject(toolResponse);
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
		if (toolName === 'TaskUpdate') {
			const response = readObject(toolResponse);
			const taskId = readString(
				response['taskId'],
				response['task_id'],
				toolInput['taskId'],
				toolInput['task_id'],
			);
			const status = coerceTaskStatus(
				readObject(response['statusChange'])['to'] ?? toolInput['status'],
			);
			if (taskId && status) {
				taskLifecycle.updateStatus({taskId, status});
			}
		}
	}

	function applyTaskCreatedEvent(data: Record<string, unknown>): void {
		const taskId = readString(data['task_id']);
		const subject = readString(data['task_subject']);
		const description = readString(data['task_description']);
		if (taskId && subject) {
			taskLifecycle.upsertCreated({taskId, subject, description});
		}
	}

	function applyTaskCompletedEvent(data: Record<string, unknown>): void {
		const taskId = readString(data['task_id']);
		const subject = readString(data['task_subject']);
		if (taskId) {
			taskLifecycle.markCompleted({taskId, subject});
		}
	}

	return {
		current() {
			return [...rootPlan.current(), ...taskLifecycle.current()];
		},
		applyToolPre,
		applyToolPost,
		applyPlanDelta(planSteps) {
			if (!Array.isArray(planSteps) || planSteps.length === 0) return false;
			const next = planSteps.map((step: {step?: string; status?: string}) => ({
				content: typeof step.step === 'string' ? step.step : '',
				status: mapPlanStepStatus(step.status),
			}));
			if (!rootPlan.differs(next)) return false;
			rootPlan.set(next);
			return true;
		},
		applyTaskCreatedEvent,
		applyTaskCompletedEvent,
		restore(feedEvents) {
			for (const e of feedEvents) {
				if (e.kind === 'tool.pre') {
					const data = e.data as {
						tool_name?: string;
						tool_input?: unknown;
					};
					applyToolPre({
						toolName: data.tool_name ?? '',
						toolInput: readObject(data.tool_input),
						actorId: e.actor_id,
					});
				} else if (e.kind === 'tool.post') {
					const data = e.data as {
						tool_name?: string;
						tool_input?: unknown;
						tool_response?: unknown;
					};
					applyToolPost({
						toolName: data.tool_name ?? '',
						toolInput: readObject(data.tool_input),
						toolResponse: data.tool_response,
					});
				} else if (e.kind === 'task.created') {
					applyTaskCreatedEvent(e.data as Record<string, unknown>);
				} else if (e.kind === 'task.completed') {
					applyTaskCompletedEvent(e.data as Record<string, unknown>);
				}
			}
		},
	};
}
