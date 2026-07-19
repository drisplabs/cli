import {describe, it, expect} from 'vitest';
import {createFeedMapper} from './mapper';
import type {MapperBootstrap} from './bootstrap';
import type {FeedEvent} from './types';
import type {RuntimeEvent} from '../runtime/types';
import {mapLegacyHookNameToRuntimeKind} from '../runtime/events';

function makeFeedEvent(overrides: Partial<FeedEvent> = {}): FeedEvent {
	return {
		event_id: 'R1:E1',
		seq: 1,
		ts: Date.now(),
		session_id: 'cs-1',
		run_id: 'R1',
		kind: 'session.start',
		level: 'info',
		actor_id: 'system',
		title: 'Session started',
		data: {source: 'startup'},
		...overrides,
	} as unknown as FeedEvent;
}

function makeRuntimeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
	const hookName = overrides.hookName ?? 'PreToolUse';
	const payload =
		typeof overrides.payload === 'object' && overrides.payload !== null
			? (overrides.payload as Record<string, unknown>)
			: {tool_name: 'Bash'};
	return {
		id: 'rt-1',
		timestamp: Date.now(),
		kind: mapLegacyHookNameToRuntimeKind(hookName),
		data: payload,
		hookName,
		sessionId: 'cs-1',
		context: {cwd: '/tmp', transcriptPath: '/tmp/t.jsonl'},
		interaction: {expectsDecision: false},
		payload,
		...overrides,
	};
}

describe('createFeedMapper', () => {
	it('works without stored session (default)', () => {
		const mapper = createFeedMapper();
		expect(mapper.getSession()).toBeNull();
		expect(mapper.getCurrentRun()).toBeNull();
	});

	describe('with stored session', () => {
		it('bootstraps session state from stored feed events', () => {
			const bootstrap: MapperBootstrap = {
				adapterSessionIds: ['cs-1'],
				createdAt: 1000,
				feedEvents: [
					makeFeedEvent({
						event_id: 'cs-1:R1:E1',
						seq: 1,
						run_id: 'cs-1:R1',
						kind: 'session.start',
						session_id: 'cs-1',
						data: {source: 'startup', model: 'opus'},
					}),
					makeFeedEvent({
						event_id: 'cs-1:R1:E2',
						seq: 2,
						run_id: 'cs-1:R1',
						kind: 'tool.pre',
						actor_id: 'agent:root',
					}),
					makeFeedEvent({
						event_id: 'cs-1:R1:E3',
						seq: 3,
						run_id: 'cs-1:R1',
						kind: 'session.end',
						data: {reason: 'completed'},
					}),
				],
			};

			const mapper = createFeedMapper(bootstrap);
			expect(mapper.getSession()).not.toBeNull();
			expect(mapper.getSession()!.session_id).toBe('cs-1');
		});

		it('continues run numbering from stored events', () => {
			const bootstrap: MapperBootstrap = {
				adapterSessionIds: ['cs-1'],
				createdAt: 1000,
				feedEvents: [
					makeFeedEvent({event_id: 'cs-1:R1:E1', seq: 1, run_id: 'cs-1:R1'}),
					makeFeedEvent({event_id: 'cs-1:R1:E2', seq: 2, run_id: 'cs-1:R1'}),
					makeFeedEvent({
						event_id: 'cs-1:R1:E3',
						seq: 3,
						run_id: 'cs-1:R1',
						kind: 'session.end',
						data: {reason: 'completed'},
					}),
				],
			};

			const mapper = createFeedMapper(bootstrap);

			// Process a new SessionStart — runSeq should be 2 (R2), not R1
			const newEvents = mapper.mapEvent(
				makeRuntimeEvent({
					hookName: 'SessionStart',
					sessionId: 'cs-2',
					payload: {session_id: 'cs-2', source: 'resume'},
				}),
			);

			// New events should use R2 in their run_id (stored had 1 run)
			const runStartEvent = newEvents.find(e => e.kind === 'run.start');
			expect(runStartEvent).toBeDefined();
			expect(runStartEvent!.run_id).toContain('R2');
		});

		// NOTE: Subagent actor reconstruction from stored events is intentionally
		// NOT done during bootstrap. Actors are registered when SubagentStart
		// events arrive in the new adapter session.
	});

	describe('session.start effort_level projection', () => {
		it('carries effort_level onto the projected session.start feed event', () => {
			const mapper = createFeedMapper();
			const newEvents = mapper.mapEvent(
				makeRuntimeEvent({
					hookName: 'SessionStart',
					sessionId: 'cs-1',
					payload: {
						session_id: 'cs-1',
						source: 'startup',
						effort_level: 'high',
					},
				}),
			);
			const startEvent = newEvents.find(e => e.kind === 'session.start');
			expect(startEvent).toBeDefined();
			expect((startEvent!.data as {effort_level?: string}).effort_level).toBe(
				'high',
			);
		});

		it('leaves effort_level undefined on session.start when absent', () => {
			const mapper = createFeedMapper();
			const newEvents = mapper.mapEvent(
				makeRuntimeEvent({
					hookName: 'SessionStart',
					sessionId: 'cs-1',
					payload: {session_id: 'cs-1', source: 'startup'},
				}),
			);
			const startEvent = newEvents.find(e => e.kind === 'session.start');
			expect(startEvent).toBeDefined();
			expect(
				(startEvent!.data as {effort_level?: string}).effort_level,
			).toBeUndefined();
		});
	});

	describe('getTasks', () => {
		it('returns empty array by default', () => {
			const mapper = createFeedMapper();
			expect(mapper.getTasks()).toEqual([]);
		});

		it('captures tasks from root-level TodoWrite events', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent({
					id: 'rt-todo-1',
					kind: 'tool.pre',
					hookName: 'PreToolUse',
					toolName: 'TodoWrite',
					payload: {
						tool_name: 'TodoWrite',
						tool_input: {
							todos: [
								{content: 'Fix bug', status: 'in_progress'},
								{content: 'Add test', status: 'pending'},
							],
						},
					},
				}),
			);
			expect(mapper.getTasks()).toEqual([
				{content: 'Fix bug', status: 'in_progress'},
				{content: 'Add test', status: 'pending'},
			]);
		});

		it('updates tasks when a new TodoWrite arrives', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent({
					id: 'rt-todo-1',
					kind: 'tool.pre',
					hookName: 'PreToolUse',
					toolName: 'TodoWrite',
					payload: {
						tool_name: 'TodoWrite',
						tool_input: {
							todos: [{content: 'Fix bug', status: 'in_progress'}],
						},
					},
				}),
			);
			mapper.mapEvent(
				makeRuntimeEvent({
					id: 'rt-todo-2',
					kind: 'tool.pre',
					hookName: 'PreToolUse',
					toolName: 'TodoWrite',
					payload: {
						tool_name: 'TodoWrite',
						tool_input: {
							todos: [{content: 'Fix bug', status: 'completed'}],
						},
					},
				}),
			);
			expect(mapper.getTasks()).toEqual([
				{content: 'Fix bug', status: 'completed'},
			]);
		});

		it('captures tasks from Codex plan.delta events', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent({
					id: 'rt-plan-1',
					kind: 'plan.delta',
					hookName: undefined as unknown as string,
					payload: {
						thread_id: 't1',
						turn_id: 'turn1',
						plan: [
							{step: 'Search codebase', status: 'completed'},
							{step: 'Implement fix', status: 'inProgress'},
							{step: 'Run tests', status: 'pending'},
						],
					},
				}),
			);
			expect(mapper.getTasks()).toEqual([
				{content: 'Search codebase', status: 'completed'},
				{content: 'Implement fix', status: 'in_progress'},
				{content: 'Run tests', status: 'pending'},
			]);
		});

		it('updates tasks when a new plan.delta arrives', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent({
					id: 'rt-plan-1',
					kind: 'plan.delta',
					hookName: undefined as unknown as string,
					payload: {
						plan: [
							{step: 'Step 1', status: 'pending'},
							{step: 'Step 2', status: 'pending'},
						],
					},
				}),
			);
			mapper.mapEvent(
				makeRuntimeEvent({
					id: 'rt-plan-2',
					kind: 'plan.delta',
					hookName: undefined as unknown as string,
					payload: {
						plan: [
							{step: 'Step 1', status: 'completed'},
							{step: 'Step 2', status: 'inProgress'},
						],
					},
				}),
			);
			expect(mapper.getTasks()).toEqual([
				{content: 'Step 1', status: 'completed'},
				{content: 'Step 2', status: 'in_progress'},
			]);
		});

		it('restores tasks from bootstrap', () => {
			const bootstrap: MapperBootstrap = {
				adapterSessionIds: ['cs-1'],
				createdAt: 1000,
				feedEvents: [
					makeFeedEvent({
						event_id: 'cs-1:R1:E1',
						seq: 1,
						run_id: 'cs-1:R1',
						kind: 'tool.pre',
						actor_id: 'agent:root',
						data: {
							tool_name: 'TodoWrite',
							tool_input: {
								todos: [{content: 'Deploy', status: 'pending'}],
							},
						},
					}),
				],
			};
			const mapper = createFeedMapper(bootstrap);
			expect(mapper.getTasks()).toEqual([
				{content: 'Deploy', status: 'pending'},
			]);
		});

		it('captures Claude TaskCreated events as pending tasks', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent({
					id: 'rt-task-created',
					kind: 'task.created',
					hookName: 'TaskCreated',
					payload: {
						hook_event_name: 'TaskCreated',
						task_id: '2',
						task_subject: 'Fix XPath locator in beneficiary.ts',
						task_description: 'Replace fixed div locator with drawer container',
					},
				}),
			);

			expect(mapper.getTasks()).toEqual([
				{
					taskId: '2',
					content: 'Fix XPath locator in beneficiary.ts',
					status: 'pending',
					activeForm: 'Replace fixed div locator with drawer container',
				},
			]);
		});

		it('updates Claude lifecycle task status from TaskUpdate tool events', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent({
					id: 'rt-task-created',
					kind: 'task.created',
					hookName: 'TaskCreated',
					payload: {
						hook_event_name: 'TaskCreated',
						task_id: '3',
						task_subject: 'Fix deprecated text= selectors in business-ops.ts',
					},
				}),
			);
			mapper.mapEvent(
				makeRuntimeEvent({
					id: 'rt-task-update',
					kind: 'tool.pre',
					hookName: 'PreToolUse',
					toolName: 'TaskUpdate',
					payload: {
						tool_name: 'TaskUpdate',
						tool_input: {
							taskId: '3',
							status: 'in_progress',
						},
					},
				}),
			);

			expect(mapper.getTasks()).toEqual([
				{
					taskId: '3',
					content: 'Fix deprecated text= selectors in business-ops.ts',
					status: 'in_progress',
					activeForm: undefined,
				},
			]);
		});

		it('marks Claude task lifecycle items completed', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent({
					id: 'rt-task-created',
					kind: 'task.created',
					hookName: 'TaskCreated',
					payload: {
						hook_event_name: 'TaskCreated',
						task_id: '2',
						task_subject: 'Fix XPath locator',
					},
				}),
			);
			mapper.mapEvent(
				makeRuntimeEvent({
					id: 'rt-task-completed',
					kind: 'task.completed',
					hookName: 'TaskCompleted',
					payload: {
						hook_event_name: 'TaskCompleted',
						task_id: '2',
						task_subject: 'Fix XPath locator',
					},
				}),
			);

			expect(mapper.getTasks()).toEqual([
				{
					taskId: '2',
					content: 'Fix XPath locator',
					status: 'completed',
					activeForm: undefined,
				},
			]);
		});

		it('keeps Codex plan replacement independent from Claude lifecycle tasks', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent({
					id: 'rt-plan-1',
					kind: 'plan.delta',
					hookName: undefined as unknown as string,
					payload: {
						plan: [
							{step: 'Search codebase', status: 'completed'},
							{step: 'Implement fix', status: 'inProgress'},
						],
					},
				}),
			);
			mapper.mapEvent(
				makeRuntimeEvent({
					id: 'rt-task-created',
					kind: 'task.created',
					hookName: 'TaskCreated',
					payload: {
						hook_event_name: 'TaskCreated',
						task_id: '2',
						task_subject: 'Fix XPath locator',
					},
				}),
			);
			mapper.mapEvent(
				makeRuntimeEvent({
					id: 'rt-plan-2',
					kind: 'plan.delta',
					hookName: undefined as unknown as string,
					payload: {
						plan: [{step: 'Run tests', status: 'pending'}],
					},
				}),
			);

			expect(mapper.getTasks()).toEqual([
				{content: 'Run tests', status: 'pending'},
				{
					taskId: '2',
					content: 'Fix XPath locator',
					status: 'pending',
					activeForm: undefined,
				},
			]);
		});

		it('restores Claude lifecycle tasks from bootstrap feed events', () => {
			const bootstrap: MapperBootstrap = {
				adapterSessionIds: ['cs-1'],
				createdAt: 1000,
				feedEvents: [
					makeFeedEvent({
						event_id: 'cs-1:R1:E1',
						seq: 1,
						run_id: 'cs-1:R1',
						kind: 'task.created',
						data: {
							task_id: '2',
							task_subject: 'Fix XPath locator',
							task_description: 'Use drawer container',
						},
					}),
					makeFeedEvent({
						event_id: 'cs-1:R1:E2',
						seq: 2,
						run_id: 'cs-1:R1',
						kind: 'task.completed',
						data: {
							task_id: '2',
							task_subject: 'Fix XPath locator',
						},
					}),
				],
			};

			const mapper = createFeedMapper(bootstrap);

			expect(mapper.getTasks()).toEqual([
				{
					taskId: '2',
					content: 'Fix XPath locator',
					status: 'completed',
					activeForm: 'Use drawer container',
				},
			]);
		});

		it('restores Claude lifecycle status from bootstrap TaskUpdate tool events', () => {
			const bootstrap: MapperBootstrap = {
				adapterSessionIds: ['cs-1'],
				createdAt: 1000,
				feedEvents: [
					makeFeedEvent({
						event_id: 'cs-1:R1:E1',
						seq: 1,
						run_id: 'cs-1:R1',
						kind: 'task.created',
						data: {
							task_id: '6',
							task_subject: 'Verify TypeScript types compile clean',
							task_description: 'Run tsc --noEmit',
						},
					}),
					makeFeedEvent({
						event_id: 'cs-1:R1:E2',
						seq: 2,
						run_id: 'cs-1:R1',
						kind: 'tool.post',
						data: {
							tool_name: 'TaskUpdate',
							tool_input: {taskId: '6', status: 'completed'},
							tool_response: {
								success: true,
								taskId: '6',
								updatedFields: ['status'],
								statusChange: {from: 'in_progress', to: 'completed'},
							},
						},
					}),
				],
			};

			const mapper = createFeedMapper(bootstrap);

			expect(mapper.getTasks()).toEqual([
				{
					taskId: '6',
					content: 'Verify TypeScript types compile clean',
					status: 'completed',
					activeForm: 'Run tsc --noEmit',
				},
			]);
		});
	});
});

describe('prompt_id Feed Run boundary (ADR 0009)', () => {
	function toolPre(promptId: string | undefined, id: string): RuntimeEvent {
		return makeRuntimeEvent({
			id,
			kind: 'tool.pre',
			hookName: 'PreToolUse',
			toolName: 'Bash',
			promptId,
			payload: {tool_name: 'Bash', tool_input: {command: 'ls'}},
		});
	}

	function runStarts(
		mapper: ReturnType<typeof createFeedMapper>,
		events: RuntimeEvent[],
	) {
		return events
			.flatMap(e => mapper.mapEvent(e))
			.filter(e => e.kind === 'run.start');
	}

	it('rolls over a Feed Run when prompt_id changes, even without a user.prompt event', () => {
		const mapper = createFeedMapper();
		const starts = runStarts(mapper, [
			toolPre('P1', 'e1'), // opens the first Run for Prompt P1
			toolPre('P1', 'e2'), // same Prompt → no rollover
			toolPre('P2', 'e3'), // Prompt changed → rollover
		]);
		expect(starts).toHaveLength(2);
		expect(starts[0]!.run_id).toMatch(/:R1$/);
		expect(starts[1]!.run_id).toMatch(/:R2$/);
	});

	it('persists prompt_id as a correlation field on every FeedEvent it stamps', () => {
		const mapper = createFeedMapper();
		const feed = mapper.mapEvent(toolPre('P1', 'e1'));
		const toolEvent = feed.find(e => e.kind === 'tool.pre');
		expect(toolEvent!.prompt_id).toBe('P1');
	});

	it('produces identical Run boundaries with prompt_id (Prompt-driven) and without (heuristic)', () => {
		const userPrompt = (
			promptId: string | undefined,
			prompt: string,
			id: string,
		): RuntimeEvent =>
			makeRuntimeEvent({
				id,
				kind: 'user.prompt',
				hookName: 'UserPromptSubmit',
				promptId,
				payload: {prompt},
			});

		const runIdsFor = (withPromptId: boolean): string[] => {
			const p = (v: string): string | undefined =>
				withPromptId ? v : undefined;
			const mapper = createFeedMapper();
			return runStarts(mapper, [
				userPrompt(p('P1'), 'first', 'a1'),
				toolPre(p('P1'), 'a2'),
				userPrompt(p('P2'), 'second', 'a3'),
				toolPre(p('P2'), 'a4'),
			]).map(e => e.run_id);
		};

		const driven = runIdsFor(true);
		const heuristic = runIdsFor(false);
		expect(driven).toEqual(heuristic);
		expect(driven).toHaveLength(2);
		expect(driven[0]).toMatch(/:R1$/);
		expect(driven[1]).toMatch(/:R2$/);
	});

	it('does not roll over on resume when a later event continues the restored Prompt', () => {
		const bootstrap: MapperBootstrap = {
			adapterSessionIds: ['cs-1'],
			createdAt: 1000,
			feedEvents: [
				makeFeedEvent({
					event_id: 'cs-1:R1:E1',
					seq: 1,
					run_id: 'cs-1:R1',
					kind: 'run.start',
					session_id: 'cs-1',
					data: {trigger: {type: 'user_prompt_submit'}},
				}),
				makeFeedEvent({
					event_id: 'cs-1:R1:E2',
					seq: 2,
					run_id: 'cs-1:R1',
					kind: 'tool.pre',
					actor_id: 'agent:root',
					prompt_id: 'P1',
				}),
			],
		};
		const mapper = createFeedMapper(bootstrap);
		const starts = runStarts(mapper, [toolPre('P1', 'e-continue')]);
		expect(starts).toHaveLength(0);
		expect(mapper.getCurrentRun()!.run_id).toBe('cs-1:R1');
	});
});
