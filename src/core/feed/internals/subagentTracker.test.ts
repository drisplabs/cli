import {describe, it, expect} from 'vitest';
import {createSubagentTracker} from './subagentTracker';

describe('subagentTracker', () => {
	describe('active LIFO', () => {
		it('peek is undefined when empty; currentScope is root', () => {
			const t = createSubagentTracker();
			expect(t.peek()).toBeUndefined();
			expect(t.currentScope()).toBe('root');
		});

		it('pushActor advances peek; currentScope becomes subagent', () => {
			const t = createSubagentTracker();
			t.pushActor('subagent:a');
			expect(t.peek()).toBe('subagent:a');
			expect(t.currentScope()).toBe('subagent');
			t.pushActor('subagent:b');
			expect(t.peek()).toBe('subagent:b');
		});

		it('popActor removes the last occurrence of actorId', () => {
			const t = createSubagentTracker();
			t.pushActor('subagent:a');
			t.pushActor('subagent:b');
			t.pushActor('subagent:a');
			t.popActor('subagent:a');
			expect(t.peek()).toBe('subagent:b');
		});

		it('popActor is a no-op when actorId is not present', () => {
			const t = createSubagentTracker();
			t.pushActor('subagent:a');
			t.popActor('subagent:missing');
			expect(t.peek()).toBe('subagent:a');
		});

		it('clear empties the stack but preserves descriptions and pending', () => {
			const t = createSubagentTracker();
			t.pushActor('subagent:a');
			t.setDescription('a', 'task A');
			t.recordPendingDescription('coming up');
			t.clear();
			expect(t.peek()).toBeUndefined();
			expect(t.currentScope()).toBe('root');
			expect(t.description('a')).toBe('task A');
			expect(t.consumePendingDescription()).toBe('coming up');
		});
	});

	describe('pending description handoff', () => {
		it('consume returns undefined when nothing was recorded', () => {
			const t = createSubagentTracker();
			expect(t.consumePendingDescription()).toBeUndefined();
		});

		it('consume returns the recorded value and then clears it', () => {
			const t = createSubagentTracker();
			t.recordPendingDescription('do the thing');
			expect(t.consumePendingDescription()).toBe('do the thing');
			expect(t.consumePendingDescription()).toBeUndefined();
		});

		it('a second record overwrites an unconsumed value', () => {
			const t = createSubagentTracker();
			t.recordPendingDescription('first');
			t.recordPendingDescription('second');
			expect(t.consumePendingDescription()).toBe('second');
		});

		it('clearPendingDescription drops an unconsumed value without consuming', () => {
			const t = createSubagentTracker();
			t.recordPendingDescription('do not use');
			t.clearPendingDescription();
			expect(t.consumePendingDescription()).toBeUndefined();
		});
	});

	describe('per-agent description registry', () => {
		it('returns undefined for unknown agent', () => {
			const t = createSubagentTracker();
			expect(t.description('agent-x')).toBeUndefined();
		});

		it('roundtrips set and read', () => {
			const t = createSubagentTracker();
			t.setDescription('agent-x', 'find the bug');
			expect(t.description('agent-x')).toBe('find the bug');
		});

		it('overwrites on repeated set', () => {
			const t = createSubagentTracker();
			t.setDescription('agent-x', 'one');
			t.setDescription('agent-x', 'two');
			expect(t.description('agent-x')).toBe('two');
		});
	});
});
