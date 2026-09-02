import {describe, it, expect} from 'vitest';
import {
	step,
	createInitialRun,
	serializeRunMemory,
	deserializeRunMemory,
	buildHandoverSeedPrompt,
	buildWakePrompt,
	type RunPhase,
	type RunMemory,
	type RunEvent,
	type StepConfig,
} from './runMachine';
import {
	buildContinuePrompt,
	buildNudgePrompt,
	TRACKER_SKELETON_MARKER,
} from './trackerReader';
import type {WorkflowRunState} from './sessionPlan';
import type {LoopConfig, WorkflowConfig} from './types';
import crypto from 'node:crypto';

const LOOP: LoopConfig = {
	enabled: true,
	maxIterations: 20,
	trackerPath: '.athena/s1/tracker.md',
};

function hash(content: string): string {
	return crypto.createHash('sha256').update(content).digest('hex');
}

function workflowState(overrides?: Partial<WorkflowConfig>): WorkflowRunState {
	const workflow: WorkflowConfig = {
		name: 'wf',
		plugins: [],
		promptTemplate: 'Orient: {input}',
		loop: LOOP,
		...overrides,
	};
	return {
		workflow,
		trackerPathForPrompt: LOOP.trackerPath,
		workflowOverride: undefined,
		warnings: [],
	};
}

function makeCfg(overrides?: Partial<StepConfig>): StepConfig {
	return {
		workflowState: workflowState(),
		initialPrompt: 'do the task',
		loop: LOOP,
		trackerAbsPath: '/proj/.athena/s1/tracker.md',
		trackerPromptPath: '.athena/s1/tracker.md',
		...overrides,
	};
}

function makeMemory(overrides?: Partial<RunMemory>): RunMemory {
	return {
		iteration: 1,
		nudgeStreak: 0,
		retryStreak: 0,
		lastTrackerHash: null,
		lastStopPrompt: 'do the task',
		lastStopContinuation: {mode: 'fresh'},
		...overrides,
	};
}

function turnInFlight(
	overrides?: Partial<Extract<RunPhase, {kind: 'turn_in_flight'}>>,
): Extract<RunPhase, {kind: 'turn_in_flight'}> {
	return {
		kind: 'turn_in_flight',
		prompt: 'do the task',
		continuation: {mode: 'fresh'},
		...overrides,
	};
}

function backingOff(
	overrides?: Partial<Extract<RunPhase, {kind: 'backing_off'}>>,
): Extract<RunPhase, {kind: 'backing_off'}> {
	return {
		kind: 'backing_off',
		ms: 10_000,
		prompt: 'do the task',
		continuation: {mode: 'fresh'},
		...overrides,
	};
}

function handingOver(
	overrides?: Partial<Extract<RunPhase, {kind: 'handing_over'}>>,
): Extract<RunPhase, {kind: 'handing_over'}> {
	return {kind: 'handing_over', handle: 'sess-1', ...overrides};
}

function turnFinished(
	overrides?: Partial<Extract<RunEvent, {type: 'turn_finished'}>>,
): Extract<RunEvent, {type: 'turn_finished'}> {
	return {
		type: 'turn_finished',
		cancelled: false,
		hasError: false,
		exitCode: 0,
		streamMessage: null,
		transportBroken: false,
		handoverRequestHandle: null,
		suspension: null,
		adapterSessionId: null,
		outcome: null,
		trackerContent: '',
		...overrides,
	};
}

function backoffElapsed(
	overrides?: Partial<Extract<RunEvent, {type: 'backoff_elapsed'}>>,
): Extract<RunEvent, {type: 'backoff_elapsed'}> {
	return {
		type: 'backoff_elapsed',
		cancelled: false,
		adapterSessionId: null,
		...overrides,
	};
}

function forkFinished(
	overrides?: Partial<Extract<RunEvent, {type: 'fork_finished'}>>,
): Extract<RunEvent, {type: 'fork_finished'}> {
	return {
		type: 'fork_finished',
		ok: true,
		cancelled: false,
		handoffPath: '/proj/.athena/s1/handoff/001.md',
		...overrides,
	};
}

describe('runMachine.step — turn_in_flight', () => {
	it('cancelled mid-turn transitions to cancelled and persists', () => {
		const result = step(
			turnInFlight(),
			makeMemory(),
			turnFinished({cancelled: true}),
			makeCfg(),
		);
		expect(result.phase).toEqual({kind: 'cancelled'});
		expect(result.actions).toEqual([{type: 'persist'}]);
	});

	it('a Handover request starts a fork turn reusing this turn`s configOverride', () => {
		const phase = turnInFlight({configOverride: {marker: 'reused'}});
		const result = step(
			phase,
			makeMemory(),
			turnFinished({handoverRequestHandle: 'vendor-handle-1'}),
			makeCfg(),
		);
		expect(result.phase).toEqual({
			kind: 'handing_over',
			handle: 'vendor-handle-1',
		});
		expect(result.actions).toEqual([
			{
				type: 'start_fork_turn',
				handle: 'vendor-handle-1',
				configOverride: {marker: 'reused'},
			},
		]);
	});

	it('a declared suspension moves straight to awaiting_attention', () => {
		const result = step(
			turnInFlight(),
			makeMemory(),
			turnFinished({suspension: {reason: 'need human input: which env?'}}),
			makeCfg(),
		);
		expect(result.phase).toEqual({
			kind: 'awaiting_attention',
			stopReason: 'need human input: which env?',
		});
		expect(result.actions).toEqual([{type: 'persist'}]);
	});

	it('a transient failure backs off with exponential ms and bumps retryStreak', () => {
		const result = step(
			turnInFlight(),
			makeMemory({retryStreak: 1}),
			turnFinished({hasError: true, errorMessage: 'rate limit exceeded (429)'}),
			makeCfg(),
		);
		expect(result.phase.kind).toBe('backing_off');
		expect(result.memory.retryStreak).toBe(2);
		// backoffBase(10_000) * 2^(retryStreak-1) = 10_000 * 2^1 = 20_000
		expect(result.phase).toMatchObject({kind: 'backing_off', ms: 20_000});
		expect(result.actions).toEqual([{type: 'wait', ms: 20_000}]);
	});

	it('a transient failure past the retry cap suspends, naming the bound', () => {
		const result = step(
			turnInFlight(),
			makeMemory({retryStreak: 3}), // cfg default retryCap is DEFAULT_RETRY_CAP (3)
			turnFinished({
				hasError: true,
				errorMessage: 'server_error: 503 Service Unavailable',
			}),
			makeCfg(),
		);
		expect(result.phase.kind).toBe('awaiting_attention');
		expect((result.phase as {stopReason: string}).stopReason).toContain(
			'retry cap reached',
		);
		expect(result.actions).toEqual([{type: 'persist'}]);
	});

	it('a hard failure on a resumed turn degrades to one fresh replay at the same iteration', () => {
		const phase = turnInFlight({
			continuation: {mode: 'resume', handle: 'sess-x'},
		});
		const result = step(
			phase,
			makeMemory({iteration: 3}),
			turnFinished({hasError: true, errorMessage: 'invalid api key'}),
			makeCfg(),
		);
		expect(result.phase.kind).toBe('turn_in_flight');
		expect(
			(result.phase as Extract<RunPhase, {kind: 'turn_in_flight'}>)
				.continuation,
		).toEqual({
			mode: 'fresh',
		});
		expect(result.memory.iteration).toBe(3); // unchanged — same iteration, not consumed
		expect(result.actions.map(a => a.type)).toEqual(['persist', 'start_turn']);
	});

	it('a hard failure on a fresh turn suspends, needs a human', () => {
		const result = step(
			turnInFlight({continuation: {mode: 'fresh'}}),
			makeMemory(),
			turnFinished({hasError: true, errorMessage: 'invalid api key'}),
			makeCfg(),
		);
		expect(result.phase.kind).toBe('awaiting_attention');
		expect((result.phase as {stopReason: string}).stopReason).toContain(
			'hard failure',
		);
		expect(result.actions).toEqual([{type: 'persist'}]);
	});

	it('any failure with looping disabled fails the run outright', () => {
		const result = step(
			turnInFlight(),
			makeMemory(),
			turnFinished({hasError: true, errorMessage: 'boom'}),
			makeCfg({
				loop: undefined,
				workflowState: workflowState({loop: undefined}),
			}),
		);
		expect(result.phase).toEqual({kind: 'failed', stopReason: 'boom'});
		expect(result.actions).toEqual([{type: 'persist'}]);
	});

	it('a broken hook transport fails even on a successful exit', () => {
		const result = step(
			turnInFlight(),
			makeMemory({retryStreak: 2}),
			turnFinished({transportBroken: true}),
			makeCfg(),
		);
		expect(result.phase.kind).toBe('failed');
		expect((result.phase as {stopReason?: string}).stopReason).toContain(
			'Hook transport broken',
		);
		expect(result.memory.retryStreak).toBe(0); // success resets the streak even on this path
		expect(result.actions).toEqual([{type: 'persist'}]);
	});

	it('a successful turn with looping disabled completes the run', () => {
		const result = step(
			turnInFlight(),
			makeMemory(),
			turnFinished(),
			makeCfg({
				loop: undefined,
				workflowState: workflowState({loop: undefined}),
			}),
		);
		expect(result.phase).toEqual({kind: 'completed'});
		expect(result.actions).toEqual([{type: 'persist'}]);
	});

	it('a declared stop/completed outcome completes the run', () => {
		const result = step(
			turnInFlight(),
			makeMemory(),
			turnFinished({outcome: {kind: 'stop', status: 'completed'}}),
			makeCfg(),
		);
		expect(result.phase).toEqual({kind: 'completed'});
		expect(result.actions).toEqual([{type: 'persist'}]);
	});

	it('a declared stop/failed outcome (e.g. missing tracker) fails the run', () => {
		const result = step(
			turnInFlight(),
			makeMemory(),
			turnFinished({
				outcome: {
					kind: 'stop',
					status: 'failed',
					stopReason: 'tracker file is missing',
				},
			}),
			makeCfg(),
		);
		expect(result.phase).toEqual({
			kind: 'failed',
			stopReason: 'tracker file is missing',
		});
	});

	it('a declared suspend outcome (e.g. iteration ceiling) suspends the run', () => {
		const result = step(
			turnInFlight(),
			makeMemory(),
			turnFinished({
				outcome: {
					kind: 'suspend',
					status: 'awaiting_attention',
					stopReason: 'iteration ceiling reached: 20 iterations',
				},
			}),
			makeCfg(),
		);
		expect(result.phase).toEqual({
			kind: 'awaiting_attention',
			stopReason: 'iteration ceiling reached: 20 iterations',
		});
	});

	it('an undeclared stop with a live Agent Session dispatches a Nudge', () => {
		const trackerContent = '# Tracker\nsome progress';
		const result = step(
			turnInFlight(),
			makeMemory({
				iteration: 2,
				nudgeStreak: 1,
				lastTrackerHash: hash(trackerContent),
			}),
			turnFinished({adapterSessionId: 'sess-live', trackerContent}),
			makeCfg(),
		);
		expect(result.phase.kind).toBe('turn_in_flight');
		const nextPhase = result.phase as Extract<
			RunPhase,
			{kind: 'turn_in_flight'}
		>;
		expect(nextPhase.continuation).toEqual({
			mode: 'resume',
			handle: 'sess-live',
		});
		expect(nextPhase.prompt).toBe(
			buildNudgePrompt(LOOP, {skeletonNotReplaced: false}),
		);
		expect(result.memory.iteration).toBe(3);
		expect(result.memory.nudgeStreak).toBe(2); // unchanged hash → streak carries and increments
		expect(result.actions.map(a => a.type)).toEqual([
			'persist',
			'notify_iteration_complete',
			'start_turn',
		]);
	});

	it('the nudge streak resets when the tracker changed since the last stop', () => {
		const trackerContent = '# Tracker\nnew progress';
		const result = step(
			turnInFlight(),
			makeMemory({
				nudgeStreak: 2,
				lastTrackerHash: hash('# Tracker\nold progress'),
			}),
			turnFinished({adapterSessionId: 'sess-live', trackerContent}),
			makeCfg(),
		);
		expect(result.memory.nudgeStreak).toBe(1); // reset to 0, then incremented once for this stop
	});

	it('a nudge past the cap suspends, naming the bound', () => {
		const trackerContent = '# Tracker\nsame';
		const result = step(
			turnInFlight(),
			makeMemory({nudgeStreak: 3, lastTrackerHash: hash(trackerContent)}), // default nudgeCap is 3
			turnFinished({adapterSessionId: 'sess-live', trackerContent}),
			makeCfg(),
		);
		expect(result.phase.kind).toBe('awaiting_attention');
		expect((result.phase as {stopReason: string}).stopReason).toContain(
			'nudge cap reached',
		);
		expect(result.actions).toEqual([{type: 'persist'}]);
	});

	it('a nudge on an unreplaced skeleton uses the bootstrap corrective prompt', () => {
		const trackerContent = `${TRACKER_SKELETON_MARKER}\n# Workflow Tracker`;
		const result = step(
			turnInFlight(),
			makeMemory({lastTrackerHash: hash(trackerContent)}),
			turnFinished({adapterSessionId: 'sess-live', trackerContent}),
			makeCfg(),
		);
		const nextPhase = result.phase as Extract<
			RunPhase,
			{kind: 'turn_in_flight'}
		>;
		expect(nextPhase.prompt).toBe(
			buildNudgePrompt(LOOP, {skeletonNotReplaced: true}),
		);
		expect(nextPhase.prompt).toContain("still contains the runner's skeleton");
	});

	it('an undeclared stop with no Agent Session id falls back to a fresh Continue Prompt turn', () => {
		const result = step(
			turnInFlight(),
			makeMemory({iteration: 1}),
			turnFinished({adapterSessionId: null, trackerContent: '# Tracker'}),
			makeCfg(),
		);
		expect(result.phase.kind).toBe('turn_in_flight');
		const nextPhase = result.phase as Extract<
			RunPhase,
			{kind: 'turn_in_flight'}
		>;
		expect(nextPhase.continuation).toEqual({mode: 'fresh'});
		expect(nextPhase.prompt).toBe(buildContinuePrompt(LOOP));
		expect(result.memory.iteration).toBe(2);
	});
});

describe('runMachine.step — backing_off', () => {
	it('cancelled during backoff transitions to cancelled and persists', () => {
		const result = step(
			backingOff(),
			makeMemory(),
			backoffElapsed({cancelled: true}),
			makeCfg(),
		);
		expect(result.phase).toEqual({kind: 'cancelled'});
		expect(result.actions).toEqual([{type: 'persist'}]);
	});

	it('resumes the reported Agent Session once the backoff elapses', () => {
		const result = step(
			backingOff({continuation: {mode: 'fresh'}}),
			makeMemory(),
			backoffElapsed({adapterSessionId: 'sess-resumed'}),
			makeCfg(),
		);
		expect(result.phase.kind).toBe('turn_in_flight');
		const nextPhase = result.phase as Extract<
			RunPhase,
			{kind: 'turn_in_flight'}
		>;
		expect(nextPhase.continuation).toEqual({
			mode: 'resume',
			handle: 'sess-resumed',
		});
		expect(result.actions.map(a => a.type)).toEqual(['persist', 'start_turn']);
	});

	it('falls back to the attempted continuation when no Agent Session id is reported', () => {
		const result = step(
			backingOff({continuation: {mode: 'resume', handle: 'sess-old'}}),
			makeMemory(),
			backoffElapsed({adapterSessionId: null}),
			makeCfg(),
		);
		const nextPhase = result.phase as Extract<
			RunPhase,
			{kind: 'turn_in_flight'}
		>;
		expect(nextPhase.continuation).toEqual({
			mode: 'resume',
			handle: 'sess-old',
		});
	});
});

describe('runMachine.step — handing_over', () => {
	it('cancelled during the fork transitions to cancelled and persists', () => {
		const result = step(
			handingOver(),
			makeMemory(),
			forkFinished({cancelled: true}),
			makeCfg(),
		);
		expect(result.phase).toEqual({kind: 'cancelled'});
		expect(result.actions).toEqual([{type: 'persist'}]);
	});

	it('a successful fork starts a fresh turn seeded with the Handoff file, purging old ones', () => {
		const result = step(
			handingOver({handle: 'sess-1'}),
			makeMemory({iteration: 2}),
			forkFinished({ok: true, handoffPath: '/proj/.athena/s1/handoff/002.md'}),
			makeCfg(),
		);
		expect(result.phase.kind).toBe('turn_in_flight');
		const nextPhase = result.phase as Extract<
			RunPhase,
			{kind: 'turn_in_flight'}
		>;
		expect(nextPhase.continuation).toEqual({mode: 'fresh'});
		expect(nextPhase.prompt).toBe(
			buildHandoverSeedPrompt(
				'/proj/.athena/s1/handoff/002.md',
				'/proj/.athena/s1/tracker.md',
			),
		);
		expect(result.memory.iteration).toBe(3);
		expect(result.actions.map(a => a.type)).toEqual([
			'purge_handoffs',
			'persist',
			'start_turn',
		]);
	});

	it('a failed fork degrades to resuming the original conversation in place', () => {
		const result = step(
			handingOver({handle: 'sess-orig'}),
			makeMemory({iteration: 2}),
			forkFinished({ok: false}),
			makeCfg(),
		);
		expect(result.phase.kind).toBe('turn_in_flight');
		const nextPhase = result.phase as Extract<
			RunPhase,
			{kind: 'turn_in_flight'}
		>;
		expect(nextPhase.continuation).toEqual({
			mode: 'resume',
			handle: 'sess-orig',
		});
		expect(result.memory.iteration).toBe(3);
		expect(result.actions).toEqual([
			{type: 'degrade_handover', handle: 'sess-orig'},
			{type: 'persist'},
			expect.objectContaining({type: 'start_turn'}),
		]);
	});
});

describe('runMachine.step — programmer errors', () => {
	it('throws when called on a terminal phase', () => {
		expect(() =>
			step({kind: 'completed'}, makeMemory(), turnFinished(), makeCfg()),
		).toThrow(/terminal phase/);
	});

	it('throws when the event does not match the phase', () => {
		expect(() =>
			step(turnInFlight(), makeMemory(), backoffElapsed(), makeCfg()),
		).toThrow(/unexpected event/);
	});
});

describe('createInitialRun', () => {
	it('starts a fresh run with the Orient prompt at iteration 1', () => {
		const {phase, memory} = createInitialRun(makeCfg(), {waking: false});
		expect(phase).toEqual({
			kind: 'turn_in_flight',
			prompt: 'Orient: do the task',
			continuation: {mode: 'fresh'},
			configOverride: undefined,
		});
		expect(memory.iteration).toBe(1);
		expect(memory.nudgeStreak).toBe(0);
		expect(memory.retryStreak).toBe(0);
	});

	it('wakes a suspended run with the wake prompt, not the bare reply', () => {
		const {phase} = createInitialRun(makeCfg(), {waking: true});
		expect((phase as Extract<RunPhase, {kind: 'turn_in_flight'}>).prompt).toBe(
			buildWakePrompt('do the task', '.athena/s1/tracker.md'),
		);
	});

	it('rehydrates from a persisted RunMemory as a zero-wait backoff instead of restarting budgets', () => {
		const resumedMemory = makeMemory({
			iteration: 5,
			nudgeStreak: 2,
			retryStreak: 1,
			lastStopPrompt: 'resume this',
			lastStopContinuation: {mode: 'resume', handle: 'sess-persisted'},
		});
		const {phase, memory} = createInitialRun(makeCfg(), {
			waking: false,
			resumedMemory,
		});
		expect(phase).toEqual({
			kind: 'backing_off',
			ms: 0,
			prompt: 'resume this',
			continuation: {mode: 'resume', handle: 'sess-persisted'},
		});
		expect(memory).toBe(resumedMemory);
	});
});

describe('RunMemory serialization', () => {
	it('round-trips through serialize/deserialize', () => {
		const original = makeMemory({
			iteration: 4,
			nudgeStreak: 1,
			retryStreak: 2,
			lastTrackerHash: 'abc123',
			lastStopContinuation: {mode: 'resume', handle: 'sess-1'},
		});
		const parsed = deserializeRunMemory(serializeRunMemory(original));
		expect(parsed).toEqual(original);
	});

	it('returns null for missing, malformed, or foreign JSON', () => {
		expect(deserializeRunMemory(undefined)).toBeNull();
		expect(deserializeRunMemory(null)).toBeNull();
		expect(deserializeRunMemory('')).toBeNull();
		expect(deserializeRunMemory('not json')).toBeNull();
		expect(deserializeRunMemory('{}')).toBeNull();
		expect(deserializeRunMemory('{"iteration": 1}')).toBeNull();
		expect(deserializeRunMemory('[1,2,3]')).toBeNull();
	});
});
