import {describe, it, expect, vi} from 'vitest';
import {ActorRegistry} from '../entities';
import {createRunLifecycle} from './runLifecycle';
import {createSubagentLifecycle} from './subagentLifecycle';

function setup() {
	const actors = new ActorRegistry();
	// SubagentLifecycle only reads/writes the current Run; it never emits feed
	// events, so the boundary's makeEvent is a never-called stub.
	const runLifecycle = createRunLifecycle({
		makeEvent: vi.fn() as never,
		resetPerRunState: vi.fn(),
	});
	runLifecycle.openNewRun(0, 'session-1', 'user', undefined);
	const subagents = createSubagentLifecycle({actors, runLifecycle});
	return {actors, runLifecycle, subagents};
}

describe('subagentLifecycle', () => {
	describe('actorIdFor', () => {
		it('forms the subagent actor id from an agent id', () => {
			const {subagents} = setup();
			expect(subagents.actorIdFor('agent-1')).toBe('subagent:agent-1');
		});
	});

	describe('observeToolInput (pending description handoff)', () => {
		it('records a pending description from a subagent-spawning tool input', () => {
			const {subagents} = setup();
			subagents.observeToolInput('Task', {description: 'do the thing'});
			const start = subagents.startSubagent({
				agentId: 'a1',
				agentType: 'general',
			});
			expect(start.description).toBe('do the thing');
		});

		it('clears pending on a subagent tool input WITHOUT a description (AC3)', () => {
			const {subagents} = setup();
			subagents.observeToolInput('Task', {description: 'stale'});
			subagents.observeToolInput('Agent', {}); // no description → clears
			const start = subagents.startSubagent({
				agentId: 'a1',
				agentType: 'general',
			});
			expect(start.description).toBeUndefined();
		});

		it('ignores non-subagent tool inputs', () => {
			const {subagents} = setup();
			subagents.observeToolInput('Bash', {description: 'not a subagent'});
			const start = subagents.startSubagent({
				agentId: 'a1',
				agentType: 'general',
			});
			expect(start.description).toBeUndefined();
		});

		it('a second observed description overwrites an unconsumed one', () => {
			const {subagents} = setup();
			subagents.observeToolInput('Task', {description: 'first'});
			subagents.observeToolInput('Task', {description: 'second'});
			expect(
				subagents.startSubagent({agentId: 'a1', agentType: 't'}).description,
			).toBe('second');
		});
	});

	describe('startSubagent', () => {
		it('registers the actor, records run membership, and emits from agent:root', () => {
			const {actors, runLifecycle, subagents} = setup();
			const start = subagents.startSubagent({
				agentId: 'a1',
				agentType: 'general',
			});
			expect(start.actorId).toBe('agent:root');
			expect(actors.get('subagent:a1')?.kind).toBe('subagent');
			expect(runLifecycle.getCurrentRun()?.actors.subagent_ids).toContain('a1');
			expect(subagents.currentScope()).toBe('subagent');
			expect(subagents.currentActor()).toBe('subagent:a1');
		});

		it('consumes the pending description and clears it (AC3)', () => {
			const {subagents} = setup();
			subagents.observeToolInput('Task', {description: 'first'});
			expect(
				subagents.startSubagent({agentId: 'a1', agentType: 't'}).description,
			).toBe('first');
			// pending was cleared on consume → next start has no description
			expect(
				subagents.startSubagent({agentId: 'a2', agentType: 't'}).description,
			).toBeUndefined();
		});

		it('falls back to the provided prompt when no pending description (missing description)', () => {
			const {subagents} = setup();
			const start = subagents.startSubagent({
				agentId: 'a1',
				agentType: 't',
				fallbackDescription: 'prompt text',
			});
			expect(start.description).toBe('prompt text');
		});

		it('nests subagents LIFO — currentActor tracks the innermost', () => {
			const {subagents} = setup();
			subagents.startSubagent({agentId: 'outer', agentType: 't'});
			subagents.startSubagent({agentId: 'inner', agentType: 't'});
			expect(subagents.currentActor()).toBe('subagent:inner');
			subagents.stopSubagent('inner');
			expect(subagents.currentActor()).toBe('subagent:outer');
		});

		it('stop removes only the LAST occurrence of a repeated agent id', () => {
			const {subagents} = setup();
			subagents.startSubagent({agentId: 'a1', agentType: 't'});
			subagents.startSubagent({agentId: 'a1', agentType: 't'});
			subagents.stopSubagent('a1');
			// One 'subagent:a1' remains on the active stack.
			expect(subagents.currentActor()).toBe('subagent:a1');
			expect(subagents.currentScope()).toBe('subagent');
		});
	});

	describe('stopSubagent', () => {
		it('pops the stack and returns the subagent actor + registry description', () => {
			const {subagents} = setup();
			subagents.observeToolInput('Task', {description: 'the description'});
			subagents.startSubagent({agentId: 'a1', agentType: 't'});
			const stop = subagents.stopSubagent('a1');
			expect(stop.actorId).toBe('subagent:a1');
			expect(stop.description).toBe('the description');
			expect(subagents.currentScope()).toBe('root');
		});

		it('handles stop without a prior start (AC4) — no throw, unknown actor', () => {
			const {subagents} = setup();
			const stop = subagents.stopSubagent(undefined);
			expect(stop.actorId).toBe('subagent:unknown');
			expect(stop.description).toBeUndefined();
			expect(subagents.currentScope()).toBe('root');
		});

		it('handles stop for an agent that never started — pops nothing, no description', () => {
			const {subagents} = setup();
			const stop = subagents.stopSubagent('ghost');
			expect(stop.actorId).toBe('subagent:ghost');
			expect(stop.description).toBeUndefined();
		});
	});

	describe('clear (resume / new-Run boundary, AC4)', () => {
		it('resets the active stack only; descriptions and pending survive', () => {
			const {subagents} = setup();
			subagents.observeToolInput('Task', {
				description: 'pending across boundary',
			});
			subagents.startSubagent({agentId: 'a1', agentType: 't'});
			// boundary
			subagents.clear();
			expect(subagents.currentScope()).toBe('root');
			// the prior subagent's description registry entry survives clear()
			expect(subagents.stopSubagent('a1').description).toBe(
				'pending across boundary',
			);
		});
	});
});
