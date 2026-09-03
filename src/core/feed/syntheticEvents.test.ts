import {describe, it, expect} from 'vitest';
import {buildSyntheticTaskEvent} from './syntheticEvents';
import {createFeedMapper} from './mapper';

describe('buildSyntheticTaskEvent', () => {
	it('builds a task.created RuntimeEvent carrying the given task data', () => {
		const event = buildSyntheticTaskEvent('task.created', 'cs-1', {
			task_id: 'first-unit',
			task_subject: 'First unit',
		});

		expect(event.kind).toBe('task.created');
		expect(event.sessionId).toBe('cs-1');
		expect(event.hookName).toBe('TaskCreated');
		expect(event.data).toEqual({
			task_id: 'first-unit',
			task_subject: 'First unit',
		});
		expect(event.interaction).toEqual({expectsDecision: false});
	});

	it('builds a task.completed RuntimeEvent with a distinct hook name', () => {
		const event = buildSyntheticTaskEvent('task.completed', 'cs-1', {
			task_id: 'first-unit',
			task_subject: 'First unit',
		});

		expect(event.kind).toBe('task.completed');
		expect(event.hookName).toBe('TaskCompleted');
	});

	it('gives every event a unique id', () => {
		const a = buildSyntheticTaskEvent('task.created', 'cs-1', {
			task_id: 't1',
			task_subject: 'Task one',
		});
		const b = buildSyntheticTaskEvent('task.created', 'cs-1', {
			task_id: 't1',
			task_subject: 'Task one',
		});

		expect(a.id).not.toBe(b.id);
	});

	it('mirrors the task data onto the payload alongside the hook envelope fields', () => {
		const event = buildSyntheticTaskEvent('task.created', 'cs-1', {
			task_id: 'first-unit',
			task_subject: 'First unit',
		});

		expect(event.payload).toMatchObject({
			hook_event_name: 'TaskCreated',
			session_id: 'cs-1',
			task_id: 'first-unit',
			task_subject: 'First unit',
		});
	});

	it('flows through FeedMapper.mapEvent exactly like a real tool-driven task event', () => {
		const mapper = createFeedMapper();

		mapper.mapEvent(
			buildSyntheticTaskEvent('task.created', 'cs-1', {
				task_id: 'first-unit',
				task_subject: 'First unit',
			}),
		);
		expect(mapper.getTasks()).toEqual([
			expect.objectContaining({taskId: 'first-unit', status: 'pending'}),
		]);

		mapper.mapEvent(
			buildSyntheticTaskEvent('task.completed', 'cs-1', {
				task_id: 'first-unit',
				task_subject: 'First unit',
			}),
		);
		expect(mapper.getTasks()).toEqual([
			expect.objectContaining({taskId: 'first-unit', status: 'completed'}),
		]);
	});
});
