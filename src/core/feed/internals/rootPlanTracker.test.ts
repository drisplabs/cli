import {describe, it, expect} from 'vitest';
import {createRootPlanTracker} from './rootPlanTracker';
import type {TodoItem} from '../todo';

const item = (content: string, status: TodoItem['status']): TodoItem => ({
	content,
	status,
});

describe('rootPlanTracker', () => {
	it('current() defaults to an empty array before any set', () => {
		const t = createRootPlanTracker();
		expect(t.current()).toEqual([]);
	});

	it('set replaces current()', () => {
		const t = createRootPlanTracker();
		t.set([item('a', 'pending')]);
		expect(t.current()).toEqual([item('a', 'pending')]);
		t.set([item('b', 'completed'), item('c', 'pending')]);
		expect(t.current()).toEqual([item('b', 'completed'), item('c', 'pending')]);
	});

	it('differs is false for identical arrays', () => {
		const t = createRootPlanTracker();
		t.set([item('a', 'pending'), item('b', 'in_progress')]);
		expect(t.differs([item('a', 'pending'), item('b', 'in_progress')])).toBe(
			false,
		);
	});

	it('differs is true when length changes', () => {
		const t = createRootPlanTracker();
		t.set([item('a', 'pending')]);
		expect(t.differs([item('a', 'pending'), item('b', 'pending')])).toBe(true);
		expect(t.differs([])).toBe(true);
	});

	it('differs is true when content changes at any index', () => {
		const t = createRootPlanTracker();
		t.set([item('a', 'pending'), item('b', 'pending')]);
		expect(t.differs([item('a', 'pending'), item('B', 'pending')])).toBe(true);
	});

	it('differs is true when status changes at any index', () => {
		const t = createRootPlanTracker();
		t.set([item('a', 'pending')]);
		expect(t.differs([item('a', 'completed')])).toBe(true);
	});

	it('differs ignores activeForm differences', () => {
		const t = createRootPlanTracker();
		t.set([{content: 'a', status: 'pending', activeForm: 'doing a'}]);
		expect(
			t.differs([{content: 'a', status: 'pending', activeForm: 'other'}]),
		).toBe(false);
	});

	it('initial differs against an empty input is false', () => {
		const t = createRootPlanTracker();
		expect(t.differs([])).toBe(false);
	});
});
