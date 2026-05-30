import {describe, it, expect} from 'vitest';
import {createTaskStateTracker} from './taskStateTracker';
import type {FeedEvent} from '../types';

function feedEvent(overrides: Partial<FeedEvent> = {}): FeedEvent {
	return {
		event_id: 'R1:E1',
		seq: 1,
		ts: 1000,
		session_id: 'cs-1',
		run_id: 'cs-1:R1',
		kind: 'tool.pre',
		level: 'info',
		actor_id: 'agent:root',
		title: '',
		data: {},
		...overrides,
	} as unknown as FeedEvent;
}

describe('taskStateTracker', () => {
	it('current() is empty before any source is applied', () => {
		const t = createTaskStateTracker();
		expect(t.current()).toEqual([]);
	});

	describe('applyToolPre', () => {
		it('replaces the root plan from a root-actor TodoWrite', () => {
			const t = createTaskStateTracker();
			t.applyToolPre({
				toolName: 'TodoWrite',
				actorId: 'agent:root',
				toolInput: {
					todos: [
						{content: 'Fix bug', status: 'in_progress'},
						{content: 'Add test', status: 'pending'},
					],
				},
			});
			expect(t.current()).toEqual([
				{content: 'Fix bug', status: 'in_progress'},
				{content: 'Add test', status: 'pending'},
			]);
		});

		it('ignores TodoWrite from a non-root actor', () => {
			const t = createTaskStateTracker();
			t.applyToolPre({
				toolName: 'TodoWrite',
				actorId: 'subagent:abc',
				toolInput: {todos: [{content: 'X', status: 'pending'}]},
			});
			expect(t.current()).toEqual([]);
		});

		it('updates lifecycle status from a TaskUpdate input', () => {
			const t = createTaskStateTracker();
			t.applyTaskCreatedEvent({task_id: '3', task_subject: 'Do thing'});
			t.applyToolPre({
				toolName: 'TaskUpdate',
				actorId: 'agent:root',
				toolInput: {taskId: '3', status: 'in_progress'},
			});
			expect(t.current()).toEqual([
				{
					taskId: '3',
					content: 'Do thing',
					status: 'in_progress',
					activeForm: undefined,
				},
			]);
		});
	});

	describe('applyToolPost', () => {
		it('creates a lifecycle task from a TaskCreate response', () => {
			const t = createTaskStateTracker();
			t.applyToolPost({
				toolName: 'TaskCreate',
				toolInput: {description: 'desc', activeForm: 'doing it'},
				toolResponse: {task: {id: '7', subject: 'Created task'}},
			});
			expect(t.current()).toEqual([
				{
					taskId: '7',
					content: 'Created task',
					status: 'pending',
					activeForm: 'doing it',
				},
			]);
		});

		it('updates lifecycle status from a TaskUpdate response statusChange', () => {
			const t = createTaskStateTracker();
			t.applyTaskCreatedEvent({task_id: '6', task_subject: 'Verify'});
			t.applyToolPost({
				toolName: 'TaskUpdate',
				toolInput: {taskId: '6'},
				toolResponse: {
					taskId: '6',
					statusChange: {from: 'in_progress', to: 'completed'},
				},
			});
			expect(t.current()).toEqual([
				{
					taskId: '6',
					content: 'Verify',
					status: 'completed',
					activeForm: undefined,
				},
			]);
		});
	});

	describe('applyPlanDelta', () => {
		it('maps Codex plan steps and reports a change', () => {
			const t = createTaskStateTracker();
			const changed = t.applyPlanDelta([
				{step: 'Search codebase', status: 'completed'},
				{step: 'Implement fix', status: 'inProgress'},
				{step: 'Run tests', status: 'pending'},
			]);
			expect(changed).toBe(true);
			expect(t.current()).toEqual([
				{content: 'Search codebase', status: 'completed'},
				{content: 'Implement fix', status: 'in_progress'},
				{content: 'Run tests', status: 'pending'},
			]);
		});

		it('reports no change when the plan is identical', () => {
			const t = createTaskStateTracker();
			const plan = [{step: 'Step 1', status: 'pending'}];
			expect(t.applyPlanDelta(plan)).toBe(true);
			expect(t.applyPlanDelta([{step: 'Step 1', status: 'pending'}])).toBe(
				false,
			);
		});

		it('reports no change for an empty or non-array plan', () => {
			const t = createTaskStateTracker();
			expect(t.applyPlanDelta([])).toBe(false);
			expect(t.applyPlanDelta(undefined)).toBe(false);
			expect(t.current()).toEqual([]);
		});
	});

	describe('lifecycle events', () => {
		it('adds a pending task from task.created and completes it from task.completed', () => {
			const t = createTaskStateTracker();
			t.applyTaskCreatedEvent({
				task_id: '2',
				task_subject: 'Fix XPath locator',
				task_description: 'Use drawer container',
			});
			expect(t.current()).toEqual([
				{
					taskId: '2',
					content: 'Fix XPath locator',
					status: 'pending',
					activeForm: 'Use drawer container',
				},
			]);
			t.applyTaskCompletedEvent({
				task_id: '2',
				task_subject: 'Fix XPath locator',
			});
			expect(t.current()).toEqual([
				{
					taskId: '2',
					content: 'Fix XPath locator',
					status: 'completed',
					activeForm: 'Use drawer container',
				},
			]);
		});
	});

	describe('current() ordering', () => {
		it('lists Codex plan items before Claude lifecycle tasks', () => {
			const t = createTaskStateTracker();
			t.applyPlanDelta([{step: 'Run tests', status: 'pending'}]);
			t.applyTaskCreatedEvent({
				task_id: '2',
				task_subject: 'Fix XPath locator',
			});
			expect(t.current()).toEqual([
				{content: 'Run tests', status: 'pending'},
				{
					taskId: '2',
					content: 'Fix XPath locator',
					status: 'pending',
					activeForm: undefined,
				},
			]);
		});
	});

	describe('restore', () => {
		it('restores the root plan from a TodoWrite feed event', () => {
			const t = createTaskStateTracker();
			t.restore([
				feedEvent({
					kind: 'tool.pre',
					actor_id: 'agent:root',
					data: {
						tool_name: 'TodoWrite',
						tool_input: {todos: [{content: 'Deploy', status: 'pending'}]},
					},
				}),
			]);
			expect(t.current()).toEqual([{content: 'Deploy', status: 'pending'}]);
		});

		it('restores lifecycle tasks from task.created + task.completed feed events', () => {
			const t = createTaskStateTracker();
			t.restore([
				feedEvent({
					kind: 'task.created',
					actor_id: 'system',
					data: {
						task_id: '2',
						task_subject: 'Fix XPath locator',
						task_description: 'Use drawer container',
					},
				}),
				feedEvent({
					kind: 'task.completed',
					actor_id: 'system',
					data: {task_id: '2', task_subject: 'Fix XPath locator'},
				}),
			]);
			expect(t.current()).toEqual([
				{
					taskId: '2',
					content: 'Fix XPath locator',
					status: 'completed',
					activeForm: 'Use drawer container',
				},
			]);
		});

		it('restores lifecycle status from a tool.post TaskUpdate feed event', () => {
			const t = createTaskStateTracker();
			t.restore([
				feedEvent({
					kind: 'task.created',
					actor_id: 'system',
					data: {
						task_id: '6',
						task_subject: 'Verify types',
						task_description: 'Run tsc',
					},
				}),
				feedEvent({
					kind: 'tool.post',
					actor_id: 'agent:root',
					data: {
						tool_name: 'TaskUpdate',
						tool_input: {taskId: '6', status: 'completed'},
						tool_response: {
							taskId: '6',
							statusChange: {from: 'in_progress', to: 'completed'},
						},
					},
				}),
			]);
			expect(t.current()).toEqual([
				{
					taskId: '6',
					content: 'Verify types',
					status: 'completed',
					activeForm: 'Run tsc',
				},
			]);
		});
	});
});
