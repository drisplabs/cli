import {describe, it, expect, vi} from 'vitest';
import {createRunLifecycle, type RunLifecycle} from './runLifecycle';
import type {RuntimeEvent} from '../../runtime/types';
import type {MapperBootstrap} from '../bootstrap';
import type {FeedEvent} from '../types';

function makeFeedEvent(overrides: Partial<FeedEvent> = {}): FeedEvent {
	return {
		event_id: 'cs-1:R1:E1',
		seq: 1,
		ts: 1000,
		session_id: 'cs-1',
		run_id: 'cs-1:R1',
		kind: 'tool.pre',
		level: 'info',
		actor_id: 'agent:root',
		title: '',
		data: {tool_name: 'Bash'},
		...overrides,
	} as unknown as FeedEvent;
}

function makeRuntimeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
	return {
		id: 'hook-1',
		timestamp: 1000,
		sessionId: 'cs-1',
		...overrides,
	} as unknown as RuntimeEvent;
}

/**
 * Builds a RunLifecycle wired with a test boundary: a stub makeEvent that mirrors
 * the real one (event_id/seq/run_id derived from the lifecycle) and a spyable
 * resetPerRunState. The stub reads the lifecycle through `ref` (populated right
 * after construction); makeEvent is only invoked at call time, never during
 * construction.
 */
function setup(opts: {resetPerRunState?: () => void} = {}) {
	const ref: {rl: RunLifecycle | null} = {rl: null};
	const resetPerRunState = opts.resetPerRunState ?? vi.fn();
	const makeEvent = vi.fn(
		(
			kind: FeedEvent['kind'],
			level: FeedEvent['level'],
			actorId: string,
			data: unknown,
			runtimeEvent: RuntimeEvent,
		): FeedEvent => {
			const seq = ref.rl!.allocateSeq();
			const runId = ref.rl!.getRunId();
			return {
				event_id: `${runId}:E${seq}`,
				seq,
				ts: runtimeEvent.timestamp,
				session_id: runtimeEvent.sessionId,
				run_id: runId,
				kind,
				level,
				actor_id: actorId,
				title: '',
				data,
			} as unknown as FeedEvent;
		},
	);
	const rl = createRunLifecycle({makeEvent, resetPerRunState});
	ref.rl = rl;
	return {rl, makeEvent, resetPerRunState};
}

describe('runLifecycle', () => {
	it('starts with no session and no run', () => {
		const {rl} = setup();
		expect(rl.getSession()).toBeNull();
		expect(rl.getCurrentRun()).toBeNull();
	});

	it('allocateSeq is monotonic', () => {
		const {rl} = setup();
		expect(rl.allocateSeq()).toBe(1);
		expect(rl.allocateSeq()).toBe(2);
		expect(rl.allocateSeq()).toBe(3);
	});

	it('getRunId before any run uses unknown:R0', () => {
		const {rl} = setup();
		expect(rl.getRunId()).toBe('unknown:R0');
	});

	it('setSession + openNewRun produces session-scoped run_id with increasing R index', () => {
		const {rl} = setup();
		rl.setSession({session_id: 'cs-1', started_at: 100});
		rl.openNewRun(200, 'cs-1', 'user_prompt_submit', 'hello');
		expect(rl.getRunId()).toBe('cs-1:R1');
		rl.closeRun(300, 'completed');
		rl.openNewRun(400, 'cs-1', 'user_prompt_submit', 'hi');
		expect(rl.getRunId()).toBe('cs-1:R2');
	});

	it('closeRun returns the closed run with its final status, then clears currentRun', () => {
		const {rl} = setup();
		rl.setSession({session_id: 'cs-1', started_at: 100});
		rl.openNewRun(200, 'cs-1', 'user_prompt_submit', undefined);
		const closed = rl.closeRun(300, 'failed');
		expect(closed?.status).toBe('failed');
		expect(closed?.ended_at).toBe(300);
		expect(rl.getCurrentRun()).toBeNull();
	});

	it('closeRun with no current run returns null', () => {
		const {rl} = setup();
		expect(rl.closeRun(100, 'completed')).toBeNull();
	});

	it('incrementCounter only mutates when there is a current run (no-op otherwise)', () => {
		const {rl} = setup();
		rl.incrementCounter('tool_uses');
		expect(rl.getCurrentRun()).toBeNull();
		rl.setSession({session_id: 'cs-1', started_at: 100});
		rl.openNewRun(200, 'cs-1', 'user_prompt_submit', undefined);
		rl.incrementCounter('tool_uses');
		rl.incrementCounter('tool_uses');
		rl.incrementCounter('permission_requests');
		expect(rl.getCurrentRun()?.counters).toEqual({
			tool_uses: 2,
			tool_failures: 0,
			permission_requests: 1,
			blocks: 0,
		});
	});

	it('endSession sets ended_at on the current session', () => {
		const {rl} = setup();
		rl.setSession({session_id: 'cs-1', started_at: 100});
		rl.endSession(500);
		expect(rl.getSession()?.ended_at).toBe(500);
	});

	describe('closeRunIntoEvent', () => {
		it('returns null when there is no current run', () => {
			const {rl, makeEvent} = setup();
			expect(rl.closeRunIntoEvent(makeRuntimeEvent(), 'completed')).toBeNull();
			expect(makeEvent).not.toHaveBeenCalled();
		});

		it('closes the run and emits a run.end event carrying the final counters', () => {
			const {rl} = setup();
			rl.setSession({session_id: 'cs-1', started_at: 100});
			rl.openNewRun(200, 'cs-1', 'user_prompt_submit', undefined);
			rl.incrementCounter('tool_uses');
			const evt = rl.closeRunIntoEvent(
				makeRuntimeEvent({timestamp: 300}),
				'completed',
			);
			expect(evt?.kind).toBe('run.end');
			expect(evt?.data).toEqual({
				status: 'completed',
				counters: {
					tool_uses: 1,
					tool_failures: 0,
					permission_requests: 0,
					blocks: 0,
				},
			});
			expect(rl.getCurrentRun()).toBeNull();
		});
	});

	describe('beginRun (run boundary ownership)', () => {
		it('emits only run.start when no run is currently open', () => {
			const {rl, resetPerRunState} = setup();
			rl.setSession({session_id: 'cs-1', started_at: 100});
			const events = rl.beginRun(
				makeRuntimeEvent({timestamp: 200}),
				'user_prompt_submit',
				'hello',
			);
			expect(events.map(e => e.kind)).toEqual(['run.start']);
			expect(events[0]?.run_id).toBe('cs-1:R1');
			expect(events[0]?.data).toEqual({
				trigger: {type: 'user_prompt_submit', prompt_preview: 'hello'},
			});
			expect(rl.getCurrentRun()?.status).toBe('running');
			expect(resetPerRunState).toHaveBeenCalledTimes(1);
		});

		it('closes the current run then opens the next, emitting run.end before run.start', () => {
			const {rl} = setup();
			rl.setSession({session_id: 'cs-1', started_at: 100});
			rl.beginRun(
				makeRuntimeEvent({timestamp: 200}),
				'user_prompt_submit',
				'a',
			);
			rl.incrementCounter('tool_uses');
			const events = rl.beginRun(
				makeRuntimeEvent({timestamp: 300}),
				'user_prompt_submit',
				'b',
			);
			expect(events.map(e => e.kind)).toEqual(['run.end', 'run.start']);
			expect(events[0]?.run_id).toBe('cs-1:R1');
			expect(events[0]?.data).toMatchObject({
				status: 'completed',
				counters: {tool_uses: 1},
			});
			expect(events[1]?.run_id).toBe('cs-1:R2');
			expect(events[1]?.data).toEqual({
				trigger: {type: 'user_prompt_submit', prompt_preview: 'b'},
			});
		});

		it('resets per-run state exactly once between closing and opening', () => {
			const order: string[] = [];
			const {rl} = setup({
				resetPerRunState: () => order.push('reset'),
			});
			rl.setSession({session_id: 'cs-1', started_at: 100});
			rl.beginRun(
				makeRuntimeEvent({timestamp: 200}),
				'user_prompt_submit',
				'a',
			);
			expect(order).toEqual(['reset']);
			rl.beginRun(makeRuntimeEvent({timestamp: 300}), 'resume');
			expect(order).toEqual(['reset', 'reset']);
		});

		it('is a no-op for an implicit (other) trigger while a run is already open', () => {
			const {rl, resetPerRunState, makeEvent} = setup();
			rl.setSession({session_id: 'cs-1', started_at: 100});
			rl.beginRun(
				makeRuntimeEvent({timestamp: 200}),
				'user_prompt_submit',
				'a',
			);
			resetPerRunState.mockClear?.();
			makeEvent.mockClear();
			const events = rl.beginRun(makeRuntimeEvent({timestamp: 300}));
			expect(events).toEqual([]);
			expect(makeEvent).not.toHaveBeenCalled();
		});

		it('still rolls over on an explicit context trigger that re-states the current prompt', () => {
			// Auto-compact fires mid-Prompt, so its SessionStart carries the SAME
			// prompt_id as the open Run. The Prompt has not changed, but the context
			// has been rebuilt, so per-run state must still be reset — otherwise the
			// dedup/reasoning state from before the compaction leaks into after it.
			const {rl, resetPerRunState} = setup();
			rl.setSession({session_id: 'cs-1', started_at: 100});
			rl.beginRun(
				makeRuntimeEvent({timestamp: 200, promptId: 'p-1'}),
				'user_prompt_submit',
				'a',
			);
			resetPerRunState.mockClear?.();
			const events = rl.beginRun(
				makeRuntimeEvent({timestamp: 300, promptId: 'p-1'}),
				'compact',
			);
			expect(events.map(e => e.kind)).toEqual(['run.end', 'run.start']);
			expect(resetPerRunState).toHaveBeenCalledTimes(1);
		});

		it('is still a no-op when an implicit event re-states the current prompt', () => {
			const {rl, makeEvent} = setup();
			rl.setSession({session_id: 'cs-1', started_at: 100});
			rl.beginRun(
				makeRuntimeEvent({timestamp: 200, promptId: 'p-1'}),
				'user_prompt_submit',
				'a',
			);
			makeEvent.mockClear();
			const events = rl.beginRun(
				makeRuntimeEvent({timestamp: 300, promptId: 'p-1'}),
			);
			expect(events).toEqual([]);
			expect(makeEvent).not.toHaveBeenCalled();
		});

		it('opens an implicit run when none is open (default trigger other)', () => {
			const {rl} = setup();
			rl.setSession({session_id: 'cs-1', started_at: 100});
			const events = rl.beginRun(makeRuntimeEvent({timestamp: 200}));
			expect(events.map(e => e.kind)).toEqual(['run.start']);
			expect(events[0]?.data).toEqual({
				trigger: {type: 'other', prompt_preview: undefined},
			});
		});
	});

	describe('restoreFrom bootstrap', () => {
		it('resumes seq and runSeq from the highest values in stored events', () => {
			const {rl} = setup();
			const bootstrap: MapperBootstrap = {
				adapterSessionIds: ['cs-1'],
				createdAt: 1000,
				feedEvents: [
					makeFeedEvent({event_id: 'cs-1:R1:E1', seq: 1, run_id: 'cs-1:R1'}),
					makeFeedEvent({event_id: 'cs-1:R1:E5', seq: 5, run_id: 'cs-1:R1'}),
					makeFeedEvent({
						event_id: 'cs-1:R1:E6',
						seq: 6,
						run_id: 'cs-1:R1',
						kind: 'run.end',
						data: {status: 'completed', counters: {}},
					}),
				],
			};
			rl.restoreFrom(bootstrap);
			expect(rl.allocateSeq()).toBe(7);
			rl.openNewRun(2000, 'cs-1', 'user_prompt_submit', undefined);
			expect(rl.getRunId()).toBe('cs-1:R2');
		});

		it('restores session identity from the last adapter session id', () => {
			const {rl} = setup();
			rl.restoreFrom({
				adapterSessionIds: ['cs-old', 'cs-new'],
				createdAt: 1000,
				feedEvents: [],
			});
			expect(rl.getSession()?.session_id).toBe('cs-new');
			expect(rl.getSession()?.source).toBe('resume');
		});

		it('reopens an in-progress run when run.start has no matching run.end', () => {
			const {rl} = setup();
			rl.restoreFrom({
				adapterSessionIds: ['cs-1'],
				createdAt: 1000,
				feedEvents: [
					makeFeedEvent({
						event_id: 'cs-1:R1:E1',
						seq: 1,
						run_id: 'cs-1:R1',
						kind: 'run.start',
						actor_id: 'system',
						data: {trigger: {type: 'user_prompt_submit'}},
					}),
					makeFeedEvent({
						event_id: 'cs-1:R1:E2',
						seq: 2,
						run_id: 'cs-1:R1',
						kind: 'tool.pre',
					}),
					makeFeedEvent({
						event_id: 'cs-1:R1:E3',
						seq: 3,
						run_id: 'cs-1:R1',
						kind: 'tool.failure',
						data: {tool_name: 'Bash', error: 'boom'},
					}),
				],
			});
			const run = rl.getCurrentRun();
			expect(run).not.toBeNull();
			expect(run?.status).toBe('running');
			expect(run?.counters.tool_uses).toBe(1);
			expect(run?.counters.tool_failures).toBe(1);
		});

		it('does not reopen a run when the latest run.end follows the latest run.start', () => {
			const {rl} = setup();
			rl.restoreFrom({
				adapterSessionIds: ['cs-1'],
				createdAt: 1000,
				feedEvents: [
					makeFeedEvent({
						event_id: 'cs-1:R1:E1',
						seq: 1,
						run_id: 'cs-1:R1',
						kind: 'run.start',
						actor_id: 'system',
						data: {trigger: {type: 'user_prompt_submit'}},
					}),
					makeFeedEvent({
						event_id: 'cs-1:R1:E2',
						seq: 2,
						run_id: 'cs-1:R1',
						kind: 'run.end',
						actor_id: 'system',
						data: {status: 'completed', counters: {}},
					}),
				],
			});
			expect(rl.getCurrentRun()).toBeNull();
		});
	});
});
