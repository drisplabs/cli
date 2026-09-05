import {describe, it, expect} from 'vitest';
import {
	step,
	createInitialRun,
	serializeRunMemory,
	deserializeRunMemory,
	buildHandoverSeedPrompt,
	buildWakePrompt,
	wakesFreshAfterHandover,
	type RunPhase,
	type RunMemory,
	type RunEvent,
	type StepConfig,
} from './runMachine';
import {
	buildContinuePrompt,
	buildNudgePrompt,
	buildJournalSizeNudgeSuffix,
	JOURNAL_SKELETON_MARKER,
} from './journalReader';
import type {WorkflowRunState} from './sessionPlan';
import {STEER_BLOCK_OPEN} from './steer';
import {
	DEFAULT_RETRY_BACKOFF_MS,
	type LoopConfig,
	type WorkflowConfig,
} from './types';
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
		lastHandoffSizeBytes: null,
		parkedAfterHandover: false,
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
		resume: {
			kind: 'turn',
			prompt: 'do the task',
			continuation: {mode: 'fresh'},
		},
		...overrides,
	};
}

function handingOver(
	overrides?: Partial<Extract<RunPhase, {kind: 'handing_over'}>>,
): Extract<RunPhase, {kind: 'handing_over'}> {
	return {kind: 'handing_over', handle: 'sess-1', ...overrides};
}

function awaitingAttention(
	overrides?: Partial<Extract<RunPhase, {kind: 'awaiting_attention'}>>,
): Extract<RunPhase, {kind: 'awaiting_attention'}> {
	return {
		kind: 'awaiting_attention',
		stopReason: 'needs a human',
		...overrides,
	};
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
		handoffSizeBytes: null,
		transient: false,
		...overrides,
	};
}

function woken(
	overrides?: Partial<Extract<RunEvent, {type: 'woken'}>>,
): Extract<RunEvent, {type: 'woken'}> {
	return {
		type: 'woken',
		continuation: {mode: 'fresh'},
		handoffPath: null,
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
			configOverride: {marker: 'reused'},
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

	it('does not append a size nudge when the journal is under the token bound (Nudge path)', () => {
		const journalContent = '# Tracker\nsmall';
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
			buildNudgePrompt(LOOP, {skeletonNotReplaced: false}),
		);
	});

	it('appends a size nudge suffix once the journal crosses the token bound (Nudge path)', () => {
		const journalContent = 'x'.repeat(40_000); // well past the ~8,000-token bound
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
			buildNudgePrompt(LOOP, {skeletonNotReplaced: false}) +
				buildJournalSizeNudgeSuffix(LOOP.journalPath),
		);
	});

	it('does not append a size nudge when the journal is under the token bound (fresh-continue path)', () => {
		const result = step(
			turnInFlight(),
			makeMemory({iteration: 1}),
			turnFinished({adapterSessionId: null, journalContent: '# Journal'}),
			makeCfg(),
		);
		const nextPhase = result.phase as Extract<
			RunPhase,
			{kind: 'turn_in_flight'}
		>;
		expect(nextPhase.prompt).toBe(buildContinuePrompt(LOOP));
	});

	it('appends a size nudge suffix once the journal crosses the token bound (fresh-continue path)', () => {
		const journalContent = 'x'.repeat(40_000);
		const result = step(
			turnInFlight(),
			makeMemory({iteration: 1}),
			turnFinished({adapterSessionId: null, journalContent}),
			makeCfg(),
		);
		const nextPhase = result.phase as Extract<
			RunPhase,
			{kind: 'turn_in_flight'}
		>;
		expect(nextPhase.prompt).toBe(
			buildContinuePrompt(LOOP) + buildJournalSizeNudgeSuffix(LOOP.journalPath),
		);
	});

	it('the size nudge never blocks the Run or produces a different action set', () => {
		const journalContent = 'x'.repeat(40_000);
		const result = step(
			turnInFlight(),
			makeMemory({iteration: 1}),
			turnFinished({adapterSessionId: null, journalContent}),
			makeCfg(),
		);
		expect(result.phase.kind).toBe('turn_in_flight');
		expect(result.actions.map(a => a.type)).toEqual([
			'persist',
			'notify_iteration_complete',
			'start_turn',
		]);
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

	it('resumes the reported Agent Session once the backoff elapses, replaying nothing (replay invariant)', () => {
		const result = step(
			backingOff({
				resume: {
					kind: 'turn',
					prompt: 'do the task',
					continuation: {mode: 'fresh'},
				},
			}),
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
		// ADR 0016 §3: continuation.mode === 'resume' → do not replay the
		// carried in-flight prompt (it's already on disk in that session) —
		// use the bare Continue Prompt instead.
		expect(nextPhase.prompt).toBe(buildContinuePrompt(LOOP));
		expect(result.actions.map(a => a.type)).toEqual(['persist', 'start_turn']);
	});

	it('falls back to the attempted continuation when no Agent Session id is reported, replaying the in-flight prompt (replay invariant)', () => {
		const result = step(
			backingOff({
				resume: {
					kind: 'turn',
					prompt: 'the exact prompt that was in flight',
					continuation: {mode: 'fresh'},
				},
			}),
			makeMemory(),
			backoffElapsed({adapterSessionId: null}),
			makeCfg(),
		);
		const nextPhase = result.phase as Extract<
			RunPhase,
			{kind: 'turn_in_flight'}
		>;
		expect(nextPhase.continuation).toEqual({mode: 'fresh'});
		// ADR 0016 §3: continuation.mode === 'fresh' → replay the carried
		// in-flight prompt — a fresh session has nothing on disk yet.
		expect(nextPhase.prompt).toBe('the exact prompt that was in flight');
	});

	it('resuming an explicit prior session (not freshly reported) also does not replay (replay invariant)', () => {
		const result = step(
			backingOff({
				resume: {
					kind: 'turn',
					prompt: 'the exact prompt that was in flight',
					continuation: {mode: 'resume', handle: 'sess-old'},
				},
			}),
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
		expect(nextPhase.prompt).toBe(buildContinuePrompt(LOOP));
	});

	it('re-issues a retried fork once its backoff elapses', () => {
		const result = step(
			backingOff({
				resume: {
					kind: 'fork',
					handle: 'sess-fork',
					configOverride: {marker: 'fork-cfg'},
				},
			}),
			makeMemory(),
			backoffElapsed({adapterSessionId: null}),
			makeCfg(),
		);
		expect(result.phase).toEqual({
			kind: 'handing_over',
			handle: 'sess-fork',
			configOverride: {marker: 'fork-cfg'},
			retried: true,
		});
		expect(result.actions).toEqual([
			{
				type: 'start_fork_turn',
				handle: 'sess-fork',
				configOverride: {marker: 'fork-cfg'},
			},
		]);
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
		// The Handover row reports `iteration.complete` like the Nudge rows do
		// (ADR 0018 §8), so the exec stream never loses an iteration to a Handover.
		expect(result.actions.map(a => a.type)).toEqual([
			'purge_handoffs',
			'persist',
			'notify_iteration_complete',
			'start_turn',
		]);
		expect(result.memory.parkedAfterHandover).toBe(false);
	});

	describe('the iteration ceiling applies on the Handover row (ADR 0018 §4)', () => {
		const ceilingCfg = () => makeCfg({loop: {...LOOP, maxIterations: 3}});

		it('a successful fork whose interrupted Turn reached maxIterations parks with the ceiling sentence, Handoff written first', () => {
			const result = step(
				handingOver({handle: 'sess-1'}),
				makeMemory({iteration: 3, lastHandoffSizeBytes: null}),
				forkFinished({
					ok: true,
					handoffPath: '/proj/.athena/s1/handoff/003.md',
					handoffSizeBytes: 2048,
				}),
				ceilingCfg(),
			);
			expect(result.phase).toEqual({
				kind: 'awaiting_attention',
				stopReason:
					'iteration ceiling reached: 3 iterations (maxIterations) used without a terminal marker',
			});
			// Fork first, then check: the Handoff is on disk for the wake, and its
			// size is recorded like any other successful fork.
			expect(result.memory.lastHandoffSizeBytes).toBe(2048);
			// The park does not consume an iteration — the wake ticks it, exactly
			// as a wake after the clean-stop ceiling does.
			expect(result.memory.iteration).toBe(3);
			// Marked so the wake starts a fresh Agent Session (ADR 0018 §9): the
			// persisted vendor session sits at its context bound.
			expect(result.memory.parkedAfterHandover).toBe(true);
			expect(result.actions).toEqual([
				{type: 'purge_handoffs'},
				{type: 'persist'},
			]);
		});

		it('a successful fork below the ceiling seeds the fresh Turn as before', () => {
			const result = step(
				handingOver({handle: 'sess-1'}),
				makeMemory({iteration: 2}),
				forkFinished({ok: true}),
				ceilingCfg(),
			);
			expect(result.phase.kind).toBe('turn_in_flight');
			expect(result.memory.iteration).toBe(3);
			expect(result.memory.parkedAfterHandover).toBe(false);
			expect(result.actions.map(a => a.type)).toEqual([
				'purge_handoffs',
				'persist',
				'notify_iteration_complete',
				'start_turn',
			]);
		});

		it('a failed fork at the ceiling still degrades in place — failed, retried and cancelled forks are unchanged', () => {
			const degraded = step(
				handingOver({handle: 'sess-orig'}),
				makeMemory({iteration: 3}),
				forkFinished({ok: false, transient: false}),
				ceilingCfg(),
			);
			expect(degraded.phase.kind).toBe('turn_in_flight');
			expect(degraded.memory.parkedAfterHandover).toBe(false);
			expect(degraded.actions).toEqual([
				{type: 'degrade_handover', handle: 'sess-orig'},
				{type: 'persist'},
				expect.objectContaining({type: 'start_turn'}),
			]);

			const retried = step(
				handingOver({handle: 'sess-orig'}),
				makeMemory({iteration: 3}),
				forkFinished({ok: false, transient: true}),
				ceilingCfg(),
			);
			expect(retried.phase.kind).toBe('backing_off');
			expect(retried.actions).toEqual([
				{type: 'wait', ms: DEFAULT_RETRY_BACKOFF_MS},
			]);

			const cancelled = step(
				handingOver({handle: 'sess-orig'}),
				makeMemory({iteration: 3}),
				forkFinished({cancelled: true}),
				ceilingCfg(),
			);
			expect(cancelled.phase).toEqual({kind: 'cancelled'});
		});
	});

	it('a non-transient failed fork degrades immediately to resuming the original conversation in place', () => {
		const result = step(
			handingOver({handle: 'sess-orig'}),
			makeMemory({iteration: 2}),
			forkFinished({ok: false, transient: false}),
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

	it('records the Handoff file size on the run memory when the fork succeeds', () => {
		const result = step(
			handingOver({handle: 'sess-1'}),
			makeMemory({iteration: 2, lastHandoffSizeBytes: null}),
			forkFinished({ok: true, handoffSizeBytes: 4096}),
			makeCfg(),
		);
		expect(result.memory.lastHandoffSizeBytes).toBe(4096);
	});

	it('records a null Handoff size when the stat failed rather than guessing', () => {
		const result = step(
			handingOver({handle: 'sess-1'}),
			makeMemory({iteration: 2, lastHandoffSizeBytes: 1024}),
			forkFinished({ok: true, handoffSizeBytes: null}),
			makeCfg(),
		);
		expect(result.memory.lastHandoffSizeBytes).toBeNull();
	});

	it('leaves the prior Handoff size untouched when the fork fails and degrades in place', () => {
		const result = step(
			handingOver({handle: 'sess-orig'}),
			makeMemory({iteration: 2, lastHandoffSizeBytes: 2048}),
			forkFinished({ok: false}),
			makeCfg(),
		);
		expect(result.memory.lastHandoffSizeBytes).toBe(2048);
	});

	it('the Handover seed prompt instructs folding the Handoff in before domain work', () => {
		const prompt = buildHandoverSeedPrompt(
			'/proj/.athena/s1/handoff/002.md',
			'/proj/.athena/s1/journal.md',
		);
		expect(prompt.toLowerCase()).toContain('before any domain work');
	});

	it('a transient failed fork retries once with backoff instead of degrading (ADR 0016 §8)', () => {
		const result = step(
			handingOver({handle: 'sess-orig', configOverride: {marker: 'fork-cfg'}}),
			makeMemory({iteration: 2}),
			forkFinished({ok: false, transient: true}),
			makeCfg(),
		);
		expect(result.phase).toEqual({
			kind: 'backing_off',
			ms: DEFAULT_RETRY_BACKOFF_MS,
			resume: {
				kind: 'fork',
				handle: 'sess-orig',
				configOverride: {marker: 'fork-cfg'},
			},
		});
		expect(result.memory.iteration).toBe(2); // unchanged — not consumed by a retry
		expect(result.actions).toEqual([
			{type: 'wait', ms: DEFAULT_RETRY_BACKOFF_MS},
		]);
	});

	it('a second transient failure on an already-retried fork degrades instead of retrying again', () => {
		const result = step(
			handingOver({handle: 'sess-orig', retried: true}),
			makeMemory({iteration: 2}),
			forkFinished({ok: false, transient: true}),
			makeCfg(),
		);
		expect(result.phase.kind).toBe('turn_in_flight');
		expect(result.actions).toEqual([
			{type: 'degrade_handover', handle: 'sess-orig'},
			{type: 'persist'},
			expect.objectContaining({type: 'start_turn'}),
		]);
	});
});

describe('runMachine.step — awaiting_attention', () => {
	it('a wake starts a fresh turn with the wake prompt and advances the Iteration budget across the wake (ADR 0016 §2/§7)', () => {
		const result = step(
			awaitingAttention({stopReason: 'nudge cap reached'}),
			makeMemory({iteration: 5}),
			woken({continuation: {mode: 'fresh'}}),
			makeCfg(),
		);
		expect(result.phase.kind).toBe('turn_in_flight');
		const nextPhase = result.phase as Extract<
			RunPhase,
			{kind: 'turn_in_flight'}
		>;
		expect(nextPhase.continuation).toEqual({mode: 'fresh'});
		expect(nextPhase.prompt).toBe(
			buildWakePrompt('do the task', '.athena/s1/journal.md'),
		);
		// Iteration keeps climbing across the wake — this is what makes
		// maxIterations a Run budget across wakes rather than resetting
		// per-wake (the pre-fix bug this ticket closes).
		expect(result.memory.iteration).toBe(6);
		expect(result.actions.map(a => a.type)).toEqual(['persist', 'start_turn']);
	});

	it('a wake resuming a reported Agent Session carries that continuation into the new turn', () => {
		const result = step(
			awaitingAttention(),
			makeMemory({iteration: 5}),
			woken({continuation: {mode: 'resume', handle: 'sess-woken'}}),
			makeCfg(),
		);
		const nextPhase = result.phase as Extract<
			RunPhase,
			{kind: 'turn_in_flight'}
		>;
		expect(nextPhase.continuation).toEqual({
			mode: 'resume',
			handle: 'sess-woken',
		});
	});

	describe('a park that followed a Handover wakes fresh (ADR 0018 §9)', () => {
		it('starts a fresh Agent Session even when a bound session was reported, names the newest Handoff, and clears the marking', () => {
			const result = step(
				awaitingAttention({
					stopReason:
						'iteration ceiling reached: 3 iterations (maxIterations) used without a terminal marker',
				}),
				makeMemory({iteration: 3, parkedAfterHandover: true}),
				woken({
					continuation: {mode: 'resume', handle: 'sess-at-bound'},
					handoffPath: '/proj/.athena/s1/handoff/003.md',
				}),
				makeCfg(),
			);
			const nextPhase = result.phase as Extract<
				RunPhase,
				{kind: 'turn_in_flight'}
			>;
			expect(nextPhase.continuation).toEqual({mode: 'fresh'});
			expect(nextPhase.prompt).toBe(
				buildWakePrompt(
					'do the task',
					'.athena/s1/journal.md',
					undefined,
					'/proj/.athena/s1/handoff/003.md',
				),
			);
			expect(nextPhase.prompt).toContain('/proj/.athena/s1/handoff/003.md');
			expect(nextPhase.prompt).toContain('.athena/s1/journal.md');
			expect(result.memory.iteration).toBe(4);
			expect(result.memory.lastStopContinuation).toEqual({mode: 'fresh'});
			// The wake consumed the marking: a later park on another row resumes.
			expect(result.memory.parkedAfterHandover).toBe(false);
			expect(result.actions).toEqual([
				{type: 'persist'},
				expect.objectContaining({
					type: 'start_turn',
					continuation: {mode: 'fresh'},
				}),
			]);
		});

		it('a wake of a Run parked on any other row keeps the reported session and never names a Handoff that happens to be on disk', () => {
			const result = step(
				awaitingAttention({stopReason: 'nudge cap reached'}),
				makeMemory({iteration: 5, parkedAfterHandover: false}),
				woken({
					continuation: {mode: 'resume', handle: 'sess-woken'},
					handoffPath: '/proj/.athena/s1/handoff/001.md',
				}),
				makeCfg(),
			);
			const nextPhase = result.phase as Extract<
				RunPhase,
				{kind: 'turn_in_flight'}
			>;
			expect(nextPhase.continuation).toEqual({
				mode: 'resume',
				handle: 'sess-woken',
			});
			expect(nextPhase.prompt).toBe(
				buildWakePrompt('do the task', '.athena/s1/journal.md'),
			);
			expect(nextPhase.prompt).not.toContain('handoff/001.md');
		});
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

	it('throws when awaiting_attention receives an event other than woken', () => {
		expect(() =>
			step(awaitingAttention(), makeMemory(), backoffElapsed(), makeCfg()),
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

	it('rehydrates a mid-turn process restart as a zero-wait backoff instead of restarting budgets', () => {
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
			resume: {
				kind: 'turn',
				prompt: 'resume this',
				continuation: {mode: 'resume', handle: 'sess-persisted'},
			},
		});
		expect(memory).toBe(resumedMemory);
	});

	it('rehydrates a wake with persisted memory straight into awaiting_attention, carrying the Iteration budget forward (ADR 0016 §2/§7)', () => {
		const resumedMemory = makeMemory({
			iteration: 5,
			nudgeStreak: 2,
			retryStreak: 1,
			lastStopPrompt: 'resume this',
			lastStopContinuation: {mode: 'resume', handle: 'sess-persisted'},
		});
		const {phase, memory} = createInitialRun(makeCfg(), {
			waking: true,
			resumedMemory,
			awaitingAttentionStopReason: 'nudge cap reached: 3 nudges (nudgeCap)',
		});
		expect(phase).toEqual({
			kind: 'awaiting_attention',
			stopReason: 'nudge cap reached: 3 nudges (nudgeCap)',
		});
		// The wake does not itself advance Iteration — that happens once
		// `handleAwaitingAttention` processes the `woken` event — but the
		// budget carries forward as-is rather than resetting to 1.
		expect(memory).toBe(resumedMemory);
		expect(memory.iteration).toBe(5);
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

	it('rehydrates a snapshot persisted before ADR 0018 with the Handover-park marking cleared', () => {
		const legacy = makeMemory({iteration: 4}) as Partial<RunMemory>;
		delete legacy.parkedAfterHandover;
		const parsed = deserializeRunMemory(JSON.stringify(legacy));
		expect(parsed).not.toBeNull();
		expect(parsed!.parkedAfterHandover).toBe(false);
		expect(wakesFreshAfterHandover(JSON.stringify(legacy))).toBe(false);
		expect(
			wakesFreshAfterHandover(
				serializeRunMemory(makeMemory({parkedAfterHandover: true})),
			),
		).toBe(true);
		expect(wakesFreshAfterHandover(undefined)).toBe(false);
		expect(wakesFreshAfterHandover('not json')).toBe(false);
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
