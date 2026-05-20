import {describe, it, expect} from 'vitest';
import {createTaskLifecycleTracker} from './taskLifecycleTracker';

describe('taskLifecycleTracker', () => {
	it('tracks created tasks independently by task id as pending', () => {
		const t = createTaskLifecycleTracker();
		t.upsertCreated({
			taskId: '2',
			subject: 'Fix XPath locator in beneficiary.ts',
			description: 'Replace fixed div locator with drawer container',
		});

		expect(t.current()).toEqual([
			{
				taskId: '2',
				content: 'Fix XPath locator in beneficiary.ts',
				status: 'pending',
				activeForm: 'Replace fixed div locator with drawer container',
			},
		]);
	});

	it('marks created tasks completed by task id', () => {
		const t = createTaskLifecycleTracker();
		t.upsertCreated({taskId: '2', subject: 'Fix locator'});
		t.markCompleted({taskId: '2'});

		expect(t.current()).toEqual([
			{
				taskId: '2',
				content: 'Fix locator',
				status: 'completed',
				activeForm: undefined,
			},
		]);
	});

	it('records completed-only tasks when a subject is available', () => {
		const t = createTaskLifecycleTracker();
		t.markCompleted({taskId: '2', subject: 'Fix locator'});

		expect(t.current()).toEqual([
			{taskId: '2', content: 'Fix locator', status: 'completed'},
		]);
	});

	it('updates status for existing tasks', () => {
		const t = createTaskLifecycleTracker();
		t.upsertCreated({taskId: '2', subject: 'Fix locator'});
		t.updateStatus({taskId: '2', status: 'in_progress'});

		expect(t.current()).toEqual([
			{
				taskId: '2',
				content: 'Fix locator',
				status: 'in_progress',
				activeForm: undefined,
			},
		]);
	});

	it('does not reset status when create metadata arrives after an update', () => {
		const t = createTaskLifecycleTracker();
		t.upsertCreated({taskId: '2', subject: 'Fix locator'});
		t.updateStatus({taskId: '2', status: 'in_progress'});
		t.upsertCreated({
			taskId: '2',
			subject: 'Fix locator in beneficiary.ts',
			description: 'Use drawer container',
		});

		expect(t.current()).toEqual([
			{
				taskId: '2',
				content: 'Fix locator in beneficiary.ts',
				status: 'in_progress',
				activeForm: 'Use drawer container',
			},
		]);
	});
});
