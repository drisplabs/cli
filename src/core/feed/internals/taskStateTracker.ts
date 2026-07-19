// src/core/feed/internals/taskStateTracker.ts

import type {FeedEvent} from '../types';
import {type TodoItem, type TodoWriteInput} from '../todo';
import {readObject, readString} from './projection';

/**
 * Owns all Root-plan and task-lifecycle SOURCE INTERPRETATION for the
 * FeedMapper: how a TodoWrite input, a Codex plan delta, a TaskCreate/TaskUpdate
 * tool event, and a task.created/task.completed event each update the canonical
 * task list. Both live event projections and bootstrap restore drive the task
 * list through these methods, so the interpretation lives in exactly one place.
 *
 * The two underlying state arrays — the Codex/root plan and the Claude task
 * lifecycle — are private closure state here rather than separate leaves: each
 * had a single caller (this module) and an interface wider than its body, and
 * their invariants (plan-delta diff ignores activeForm; a re-create must not
 * reset an updated status) are only exercised through this interpretation.
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

function coerceTaskStatus(status: unknown): TodoItem['status'] | null {
	switch (status) {
		case 'pending':
		case 'in_progress':
		case 'completed':
		case 'failed':
			return status;
		default:
			return null;
	}
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
	// The canonical Codex/root plan (replaced wholesale by TodoWrite or a plan
	// delta) and the Claude task lifecycle (upserted per taskId).
	let rootPlanItems: TodoItem[] = [];
	let taskItems: TodoItem[] = [];

	/** True iff setting the root plan to `next` would observably change it
	 * (activeForm is intentionally not compared — matches the plan.delta diff). */
	function rootPlanDiffers(next: TodoItem[]): boolean {
		if (next.length !== rootPlanItems.length) return true;
		for (let i = 0; i < next.length; i++) {
			if (next[i]?.content !== rootPlanItems[i]?.content) return true;
			if (next[i]?.status !== rootPlanItems[i]?.status) return true;
		}
		return false;
	}

	function upsertCreatedTask(input: {
		taskId: string;
		subject: string;
		description?: string;
		activeForm?: string;
	}): void {
		const {taskId, subject, description, activeForm} = input;
		const task: TodoItem = {
			taskId,
			content: subject,
			status: 'pending',
			activeForm: activeForm ?? description,
		};
		const existingIndex = taskItems.findIndex(item => item.taskId === taskId);
		if (existingIndex === -1) {
			taskItems = [...taskItems, task];
			return;
		}
		// Re-create must not reset an updated status — keep the existing item's
		// status, refresh its content/activeForm.
		taskItems = taskItems.map((item, index) =>
			index === existingIndex
				? {
						...item,
						taskId,
						content: subject,
						activeForm: task.activeForm ?? item.activeForm,
					}
				: item,
		);
	}

	function markTaskCompleted(input: {taskId: string; subject?: string}): void {
		const {taskId, subject} = input;
		const existingIndex = taskItems.findIndex(item => item.taskId === taskId);
		if (existingIndex === -1) {
			if (!subject) return;
			taskItems = [
				...taskItems,
				{taskId, content: subject, status: 'completed'},
			];
			return;
		}
		taskItems = taskItems.map((item, index) =>
			index === existingIndex ? {...item, status: 'completed'} : item,
		);
	}

	function updateTaskStatus(input: {
		taskId: string;
		status: TodoItem['status'];
	}): void {
		const {taskId, status} = input;
		taskItems = taskItems.map(item =>
			item.taskId === taskId ? {...item, status} : item,
		);
	}

	function applyToolPre(input: {
		toolName: string;
		toolInput: Record<string, unknown>;
		actorId: string;
	}): void {
		const {toolName, toolInput, actorId} = input;
		if (toolName === 'TodoWrite' && actorId === 'agent:root') {
			rootPlanItems = extractTodoItems(toolInput);
		}
		if (toolName === 'TaskUpdate') {
			const taskId = readString(toolInput['taskId'], toolInput['task_id']);
			const status = coerceTaskStatus(toolInput['status']);
			if (taskId && status) {
				updateTaskStatus({taskId, status});
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
				upsertCreatedTask({
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
				updateTaskStatus({taskId, status});
			}
		}
	}

	function applyTaskCreatedEvent(data: Record<string, unknown>): void {
		const taskId = readString(data['task_id']);
		const subject = readString(data['task_subject']);
		const description = readString(data['task_description']);
		if (taskId && subject) {
			upsertCreatedTask({taskId, subject, description});
		}
	}

	function applyTaskCompletedEvent(data: Record<string, unknown>): void {
		const taskId = readString(data['task_id']);
		const subject = readString(data['task_subject']);
		if (taskId) {
			markTaskCompleted({taskId, subject});
		}
	}

	return {
		current() {
			return [...rootPlanItems, ...taskItems];
		},
		applyToolPre,
		applyToolPost,
		applyPlanDelta(planSteps) {
			if (!Array.isArray(planSteps) || planSteps.length === 0) return false;
			const next = planSteps.map((step: {step?: string; status?: string}) => ({
				content: typeof step.step === 'string' ? step.step : '',
				status: mapPlanStepStatus(step.status),
			}));
			if (!rootPlanDiffers(next)) return false;
			rootPlanItems = next;
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
