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
	JOURNAL_SKELETON_MARKER,
} from './journalReader';
import type {WorkflowRunState} from './sessionPlan';
import {STEER_BLOCK_OPEN} from './steer';
import type {LoopConfig, WorkflowConfig} from './types';
import type {Interruption} from '@drisp/protocol';
import crypto from 'node:crypto';

const LOOP: LoopConfig = {
	enabled: true,
	maxIterations: 20,
	journalPath: '.athena/s1/journal.md',
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
		journalPathForPrompt: LOOP.journalPath,
		workflowOverride: undefined,
		warnings: [],
	};
}

function makeCfg(overrides?: Partial<StepConfig>): StepConfig {
	return {
		workflowState: workflowState(),
		initialPrompt: 'do the task',
		loop: LOOP,
		journalAbsPath: '/proj/.athena/s1/journal.md',
		journalPromptPath: '.athena/s1/journal.md',
		...overrides,
	};
}

function makeMemory(overrides?: Partial<RunMemory>): RunMemory {
	return {
		iteration: 1,
		nudgeStreak: 0,
		retryStreak: 0,
		lastJournalHash: null,
		lastStopPrompt: 'do the task',
		lastStopContinuation: {mode: 'fresh'},
		pendingSteers: [],
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
		interruption: null,
		adapterSessionId: null,
		outcome: null,
		journalContent: '',
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

	describe('unattended interruptions park the Run as needs-human (#189)', () => {
		it('an ask rule firing parks the Run, naming the rule and the tool', () => {
			const result = step(
				turnInFlight(),
				makeMemory(),
				turnFinished({
					interruption: {kind: 'ask_rule', rule: 'Bash', toolName: 'Bash'},
				}),
				makeCfg(),
			);
			expect(result.phase).toEqual({
				kind: 'awaiting_attention',
				stopReason: 'ask rule "Bash" fired on Bash — needs a human',
			});
			expect(result.actions).toEqual([{type: 'persist'}]);
		});

		it('an ask rule pattern is named as written, not as the tool it matched', () => {
			const result = step(
				turnInFlight(),
				makeMemory(),
				turnFinished({
					interruption: {
						kind: 'ask_rule',
						rule: 'mcp__github__*',
						toolName: 'mcp__github__create_pull_request',
					},
				}),
				makeCfg(),
			);
			expect(result.phase).toEqual({
				kind: 'awaiting_attention',
				stopReason:
					'ask rule "mcp__github__*" fired on mcp__github__create_pull_request — needs a human',
			});
		});

		it('a NEEDS_HUMAN marker parks the Run the same way an ask rule does', () => {
			const marker = step(
				turnInFlight(),
				makeMemory(),
				turnFinished({
					outcome: {
						kind: 'suspend',
						status: 'awaiting_attention',
						stopReason: 'agent declared NEEDS_HUMAN: which env?',
					},
				}),
				makeCfg(),
			);
			const askRule = step(
				turnInFlight(),
				makeMemory(),
				turnFinished({
					interruption: {kind: 'ask_rule', rule: 'Bash', toolName: 'Bash'},
				}),
				makeCfg(),
			);
			expect(marker.phase).toEqual({
				kind: 'awaiting_attention',
				stopReason: 'agent declared NEEDS_HUMAN: which env?',
			});
			expect(marker.phase.kind).toBe(askRule.phase.kind);
			expect(marker.actions).toEqual(askRule.actions);
			expect(marker.memory).toEqual(askRule.memory);
		});

		it('a question no attached human can answer parks the Run with the question', () => {
			const result = step(
				turnInFlight(),
				makeMemory(),
				turnFinished({
					interruption: {
						kind: 'question',
						question: 'Deploy to prod or staging?',
					},
				}),
				makeCfg(),
			);
			expect(result.phase).toEqual({
				kind: 'awaiting_attention',
				stopReason:
					'agent asked a question with no human attached to answer: Deploy to prod or staging?',
			});
		});

		it('a permission no rule claims parks the Run and points at the autonomous preset', () => {
			const result = step(
				turnInFlight(),
				makeMemory(),
				turnFinished({
					interruption: {kind: 'unclaimed_permission', toolName: 'Edit'},
				}),
				makeCfg(),
			);
			expect(result.phase.kind).toBe('awaiting_attention');
			const reason = (
				result.phase as Extract<RunPhase, {kind: 'awaiting_attention'}>
			).stopReason;
			expect(reason).toContain('Edit');
			expect(reason).toContain('--isolation autonomous');
		});

		it('an interruption beats the Turn`s exit code: interrupting to park is not a failure', () => {
			const result = step(
				turnInFlight(),
				makeMemory(),
				turnFinished({
					exitCode: 143,
					interruption: {kind: 'ask_rule', rule: '*', toolName: 'Bash'},
				}),
				makeCfg(),
			);
			expect(result.phase.kind).toBe('awaiting_attention');
			expect(result.memory.retryStreak).toBe(0);
		});

		it('a Turn whose permission prompts were auto-answered is not interrupted: the Run continues', () => {
			// The autonomous preset answers an unclaimed permission inside the
			// Turn; the reducer never sees it. The Turn ends like any other —
			// here without a marker, so the next row is a Nudge, not a park.
			const result = step(
				turnInFlight(),
				makeMemory(),
				turnFinished({
					interruption: null,
					outcome: {kind: 'continue'},
					adapterSessionId: 'sess-1',
					journalContent: 'progress',
				}),
				makeCfg(),
			);
			expect(result.phase.kind).toBe('turn_in_flight');
			expect(result.memory.iteration).toBe(2);
		});

		it('a Turn that ends on WORKFLOW_COMPLETE with nobody watching completes the Run', () => {
			const result = step(
				turnInFlight(),
				makeMemory(),
				turnFinished({
					interruption: null,
					outcome: {kind: 'stop', status: 'completed'},
					journalContent: '# done\n<!-- WORKFLOW_COMPLETE -->',
				}),
				makeCfg(),
			);
			expect(result.phase).toEqual({kind: 'completed'});
			expect(result.actions).toEqual([{type: 'persist'}]);
		});
	});

	describe('a permission held for the grace window, then deferred, parks on a structured Interruption (#190)', () => {
		it('an unclaimed permission that went unanswered parks with the request id and the call, and asks the interpreter to record it', () => {
			// Hold, then park: the interpreter held the unanswered permission
			// for the grace window, refused it as "deferred", and ended the
			// Turn. The reducer owns the sentence, shapes the wire Interruption
			// (a `question` addressed by the request id), keeps it on the
			// parked phase, and asks for it to be recorded (journal + run
			// record) before persisting.
			const result = step(
				turnInFlight(),
				makeMemory(),
				turnFinished({
					exitCode: 143,
					interruption: {
						kind: 'unclaimed_permission',
						toolName: 'Bash',
						permission: {
							requestId: 'req-42',
							inputSummary: 'git push origin main',
							graceMs: 60_000,
						},
					},
				}),
				makeCfg(),
			);
			const expected: Interruption = {
				kind: 'question',
				message:
					'permission request (Bash) unanswered within the grace window (60s); deferred: git push origin main — wake with --answer=allow|deny, or rerun with --isolation autonomous',
				requestId: 'req-42',
				question: 'Bash: git push origin main',
			};
			expect(result.phase).toEqual({
				kind: 'awaiting_attention',
				stopReason: expected.message,
				interruption: expected,
			});
			expect(result.actions).toEqual([
				{type: 'record_interruption', interruption: expected},
				{type: 'persist'},
			]);
			expect(result.memory).toEqual(makeMemory());
		});

		it('an ask rule whose claimed permission went unanswered parks the same way, naming the rule', () => {
			const result = step(
				turnInFlight(),
				makeMemory(),
				turnFinished({
					interruption: {
						kind: 'ask_rule',
						rule: 'mcp__github__*',
						toolName: 'mcp__github__create_pull_request',
						permission: {
							requestId: 'req-7',
							inputSummary: 'title: Ship it',
							graceMs: 500,
						},
					},
				}),
				makeCfg(),
			);
			expect(result.phase).toMatchObject({
				kind: 'awaiting_attention',
				stopReason:
					'ask rule "mcp__github__*" fired on mcp__github__create_pull_request unanswered within the grace window (500ms); deferred: title: Ship it — wake with --answer=allow|deny',
				interruption: {
					kind: 'question',
					requestId: 'req-7',
					question: 'mcp__github__create_pull_request: title: Ship it',
				},
			});
			expect(result.actions.map(a => a.type)).toEqual([
				'record_interruption',
				'persist',
			]);
		});

		it('a permission deferred at once, with no hub to wait for, says so instead of naming a window', () => {
			const result = step(
				turnInFlight(),
				makeMemory(),
				turnFinished({
					interruption: {
						kind: 'unclaimed_permission',
						toolName: 'Bash',
						permission: {
							requestId: 'req-1',
							inputSummary: 'git push',
							graceMs: 0,
						},
					},
				}),
				makeCfg(),
			);
			expect(result.phase).toMatchObject({
				kind: 'awaiting_attention',
				stopReason:
					'permission request (Bash) deferred immediately (no hub attached to answer): git push — wake with --answer=allow|deny, or rerun with --isolation autonomous',
			});
		});

		it('a permission parked without being held keeps the plain row: no Interruption to record', () => {
			const result = step(
				turnInFlight(),
				makeMemory(),
				turnFinished({
					interruption: {kind: 'unclaimed_permission', toolName: 'Edit'},
				}),
				makeCfg(),
			);
			expect(result.phase).not.toHaveProperty('interruption');
			expect(result.actions).toEqual([{type: 'persist'}]);
		});
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

	it('a declared stop/failed outcome (e.g. missing journal) fails the run', () => {
		const result = step(
			turnInFlight(),
			makeMemory(),
			turnFinished({
				outcome: {
					kind: 'stop',
					status: 'failed',
					stopReason: 'journal file is missing',
				},
			}),
			makeCfg(),
		);
		expect(result.phase).toEqual({
			kind: 'failed',
			stopReason: 'journal file is missing',
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

	it('a suspend outcome that carries a deprecation suspends identically and asks the interpreter to warn', () => {
		const legacy = step(
			turnInFlight(),
			makeMemory(),
			turnFinished({
				outcome: {
					kind: 'suspend',
					status: 'awaiting_attention',
					stopReason: 'agent declared NEEDS_HUMAN: which env?',
					deprecation: 'WORKFLOW_BLOCKED is deprecated; write NEEDS_HUMAN',
				},
			}),
			makeCfg(),
		);
		const current = step(
			turnInFlight(),
			makeMemory(),
			turnFinished({
				outcome: {
					kind: 'suspend',
					status: 'awaiting_attention',
					stopReason: 'agent declared NEEDS_HUMAN: which env?',
				},
			}),
			makeCfg(),
		);
		// The reducer stays pure: the deprecation becomes an action, and the
		// resulting phase/memory are indistinguishable from the new marker's.
		expect(legacy.phase).toEqual(current.phase);
		expect(legacy.memory).toEqual(current.memory);
		expect(legacy.actions).toEqual([
			{
				type: 'warn',
				message: 'WORKFLOW_BLOCKED is deprecated; write NEEDS_HUMAN',
			},
			{type: 'persist'},
		]);
		expect(current.actions).toEqual([{type: 'persist'}]);
	});

	it('an undeclared stop with a live Agent Session dispatches a Nudge', () => {
		const journalContent = '# Journal\nsome progress';
		const result = step(
			turnInFlight(),
			makeMemory({
				iteration: 2,
				nudgeStreak: 1,
				lastJournalHash: hash(journalContent),
			}),
			turnFinished({adapterSessionId: 'sess-live', journalContent}),
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

	it('the nudge streak resets when the journal changed since the last stop', () => {
		const journalContent = '# Journal\nnew progress';
		const result = step(
			turnInFlight(),
			makeMemory({
				nudgeStreak: 2,
				lastJournalHash: hash('# Journal\nold progress'),
			}),
			turnFinished({adapterSessionId: 'sess-live', journalContent}),
			makeCfg(),
		);
		expect(result.memory.nudgeStreak).toBe(1); // reset to 0, then incremented once for this stop
	});

	it('a nudge past the cap suspends, naming the bound', () => {
		const journalContent = '# Journal\nsame';
		const result = step(
			turnInFlight(),
			makeMemory({nudgeStreak: 3, lastJournalHash: hash(journalContent)}), // default nudgeCap is 3
			turnFinished({adapterSessionId: 'sess-live', journalContent}),
			makeCfg(),
		);
		expect(result.phase.kind).toBe('awaiting_attention');
		expect((result.phase as {stopReason: string}).stopReason).toContain(
			'nudge cap reached',
		);
		expect(result.actions).toEqual([{type: 'persist'}]);
	});

	it('a nudge on an unreplaced skeleton uses the bootstrap corrective prompt', () => {
		const journalContent = `${JOURNAL_SKELETON_MARKER}\n# Workflow Journal`;
		const result = step(
			turnInFlight(),
			makeMemory({lastJournalHash: hash(journalContent)}),
			turnFinished({adapterSessionId: 'sess-live', journalContent}),
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
			turnFinished({adapterSessionId: null, journalContent: '# Journal'}),
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
				'/proj/.athena/s1/journal.md',
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
			buildWakePrompt('do the task', '.athena/s1/journal.md'),
		);
	});

	it('wakes a run parked on a deferred question by asking the agent to re-issue that exact call (#190)', () => {
		const parkedInterruption: Interruption = {
			kind: 'question',
			message:
				'permission request (Bash) unanswered within the grace window (60s); deferred: git push origin main',
			requestId: 'req-42',
			question: 'Bash: git push origin main',
		};
		const {phase} = createInitialRun(makeCfg(), {
			waking: true,
			parkedInterruption,
		});
		const prompt = (phase as Extract<RunPhase, {kind: 'turn_in_flight'}>)
			.prompt;
		expect(prompt).toBe(
			buildWakePrompt(
				'do the task',
				'.athena/s1/journal.md',
				parkedInterruption,
			),
		);
		// The replay contract, spelled out for the agent: re-issue the same
		// call; a stored answer is applied without asking again, otherwise the
		// request is held again.
		expect(prompt).toContain('Bash: git push origin main');
		expect(prompt).toContain('req-42');
		expect(prompt).toContain('Re-issue that exact call');
		// The plain wake framing is still there.
		expect(prompt).toContain('The human replied:\n\ndo the task');
	});

	it('wakes a run parked on a non-question Interruption with the plain wake prompt', () => {
		const {phase} = createInitialRun(makeCfg(), {
			waking: true,
			parkedInterruption: {
				kind: 'blocked',
				message: 'agent declared NEEDS_HUMAN: which env?',
				reason: 'which env?',
			},
		});
		expect((phase as Extract<RunPhase, {kind: 'turn_in_flight'}>).prompt).toBe(
			buildWakePrompt('do the task', '.athena/s1/journal.md'),
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
			lastJournalHash: 'abc123',
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

describe('steering (#191)', () => {
	const HUB_STEER = {
		text: 'use the other branch',
		origin: 'hub' as const,
		receivedAt: 1_000,
	};
	const LOCAL_STEER = {
		text: 'and skip the docs',
		origin: 'local' as const,
		receivedAt: 2_000,
	};

	it('a steer received mid-Turn is queued, persisted, and never injected into the running Turn', () => {
		const phase = turnInFlight({prompt: 'turn 1 prompt'});
		const result = step(
			phase,
			makeMemory(),
			{type: 'steer', steer: HUB_STEER},
			makeCfg(),
		);
		expect(result.phase).toEqual(phase);
		expect(result.memory.pendingSteers).toEqual([HUB_STEER]);
		expect(result.actions).toEqual([{type: 'persist'}]);
	});

	it('drains the queue into the head of the next Turn prompt at the Turn boundary', () => {
		const queued = step(
			turnInFlight(),
			makeMemory(),
			{type: 'steer', steer: HUB_STEER},
			makeCfg(),
		);
		const next = step(
			turnInFlight(),
			queued.memory,
			turnFinished({
				adapterSessionId: 'sess-1',
				outcome: {kind: 'continue'},
				journalContent: 'progress',
			}),
			makeCfg(),
		);
		const start = next.actions.find(a => a.type === 'start_turn');
		expect(start).toBeDefined();
		if (start?.type !== 'start_turn') throw new Error('unreachable');
		expect(start.prompt.startsWith(STEER_BLOCK_OPEN)).toBe(true);
		expect(start.prompt).toContain('use the other branch');
		expect(start.prompt).toContain(buildNudgePrompt(LOOP));
		expect(next.phase).toMatchObject({
			kind: 'turn_in_flight',
			prompt: start.prompt,
		});
		expect(next.memory.pendingSteers).toEqual([]);
		expect(next.memory.lastStopPrompt).toBe(start.prompt);
		// The delivery is reported ahead of the Turn so the interpreter can
		// journal it before the Turn starts.
		const startIndex = next.actions.indexOf(start);
		expect(next.actions[startIndex - 1]).toEqual({
			type: 'steers_delivered',
			steers: [HUB_STEER],
			iteration: 2,
		});
	});

	it('delivers several queued steers in arrival order in one Turn', () => {
		const first = step(
			turnInFlight(),
			makeMemory(),
			{type: 'steer', steer: HUB_STEER},
			makeCfg(),
		);
		const second = step(
			turnInFlight(),
			first.memory,
			{type: 'steer', steer: LOCAL_STEER},
			makeCfg(),
		);
		expect(second.memory.pendingSteers).toEqual([HUB_STEER, LOCAL_STEER]);
		const next = step(
			turnInFlight(),
			second.memory,
			turnFinished({outcome: {kind: 'continue'}, journalContent: 'p'}),
			makeCfg(),
		);
		const start = next.actions.find(a => a.type === 'start_turn');
		if (start?.type !== 'start_turn') throw new Error('unreachable');
		expect(start.prompt.indexOf('use the other branch')).toBeLessThan(
			start.prompt.indexOf('and skip the docs'),
		);
		expect(next.actions).toContainEqual({
			type: 'steers_delivered',
			steers: [HUB_STEER, LOCAL_STEER],
			iteration: 2,
		});
	});

	it('a steer received while backing off waits for the retried Turn', () => {
		const queued = step(
			backingOff(),
			makeMemory({retryStreak: 1}),
			{type: 'steer', steer: HUB_STEER},
			makeCfg(),
		);
		expect(queued.phase).toEqual(backingOff());
		expect(queued.actions).toEqual([{type: 'persist'}]);
		const next = step(backingOff(), queued.memory, backoffElapsed(), makeCfg());
		const start = next.actions.find(a => a.type === 'start_turn');
		if (start?.type !== 'start_turn') throw new Error('unreachable');
		expect(start.prompt.startsWith(STEER_BLOCK_OPEN)).toBe(true);
		expect(next.memory.pendingSteers).toEqual([]);
	});

	it('a steer received during a Handover fork rides into the seeded fresh Turn', () => {
		const queued = step(
			handingOver(),
			makeMemory(),
			{type: 'steer', steer: HUB_STEER},
			makeCfg(),
		);
		expect(queued.phase).toEqual(handingOver());
		const next = step(handingOver(), queued.memory, forkFinished(), makeCfg());
		const start = next.actions.find(a => a.type === 'start_turn');
		if (start?.type !== 'start_turn') throw new Error('unreachable');
		expect(start.prompt.startsWith(STEER_BLOCK_OPEN)).toBe(true);
		expect(start.prompt).toContain('A Handover occurred');
	});

	it('a steer stays queued through a transition that starts no Turn (suspend)', () => {
		const queued = step(
			turnInFlight(),
			makeMemory(),
			{type: 'steer', steer: HUB_STEER},
			makeCfg(),
		);
		const parked = step(
			turnInFlight(),
			queued.memory,
			turnFinished({interruption: {kind: 'question', question: 'which env?'}}),
			makeCfg(),
		);
		expect(parked.phase.kind).toBe('awaiting_attention');
		expect(parked.memory.pendingSteers).toEqual([HUB_STEER]);
		expect(parked.actions.some(a => a.type === 'steers_delivered')).toBe(false);
	});

	it('createInitialRun delivers initial steers at the head of the first Turn prompt', () => {
		const initial = createInitialRun(makeCfg(), {
			waking: false,
			initialSteers: [LOCAL_STEER],
		});
		expect(initial.phase.kind).toBe('turn_in_flight');
		if (initial.phase.kind !== 'turn_in_flight') throw new Error('unreachable');
		expect(initial.phase.prompt.startsWith(STEER_BLOCK_OPEN)).toBe(true);
		expect(initial.phase.prompt.endsWith('Orient: do the task')).toBe(true);
		expect(initial.memory.pendingSteers).toEqual([]);
		expect(initial.actions).toEqual([
			{type: 'steers_delivered', steers: [LOCAL_STEER], iteration: 1},
			{
				type: 'start_turn',
				prompt: initial.phase.prompt,
				continuation: {mode: 'fresh'},
				configOverride: undefined,
			},
		]);
	});

	it('createInitialRun on a wake puts the steer ahead of the wake framing', () => {
		const initial = createInitialRun(
			makeCfg({initialPrompt: 'French, please.'}),
			{waking: true, initialSteers: [HUB_STEER]},
		);
		if (initial.phase.kind !== 'turn_in_flight') throw new Error('unreachable');
		expect(initial.phase.prompt.startsWith(STEER_BLOCK_OPEN)).toBe(true);
		expect(initial.phase.prompt).toContain('suspended awaiting a human');
		expect(initial.phase.prompt).toContain('French, please.');
	});

	it('createInitialRun keeps a rehydrated Run steers pending until its backoff elapses', () => {
		const resumed = makeMemory({
			iteration: 3,
			lastStopPrompt: 'carried',
			pendingSteers: [HUB_STEER],
		});
		const initial = createInitialRun(makeCfg(), {
			waking: false,
			resumedMemory: resumed,
			initialSteers: [LOCAL_STEER],
		});
		expect(initial.phase.kind).toBe('backing_off');
		expect(initial.memory.pendingSteers).toEqual([HUB_STEER, LOCAL_STEER]);
		expect(initial.actions).toEqual([{type: 'wait', ms: 0}]);
	});

	it('serializes pending steers and rehydrates a pre-#191 snapshot with an empty queue', () => {
		const withSteers = makeMemory({pendingSteers: [HUB_STEER]});
		expect(deserializeRunMemory(serializeRunMemory(withSteers))).toEqual(
			withSteers,
		);
		const legacy = JSON.stringify({
			iteration: 2,
			nudgeStreak: 0,
			retryStreak: 0,
			lastJournalHash: null,
			lastStopPrompt: 'p',
			lastStopContinuation: {mode: 'fresh'},
		});
		expect(deserializeRunMemory(legacy)?.pendingSteers).toEqual([]);
	});

	it('rejects a snapshot whose pending steers are malformed', () => {
		const bad = JSON.stringify({...makeMemory(), pendingSteers: [{text: 1}]});
		expect(deserializeRunMemory(bad)).toBeNull();
	});
});
