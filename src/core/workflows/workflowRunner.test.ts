import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createWorkflowRunner} from './workflowRunner';
import type {TurnExecutionResult} from '../runtime/process';
import {TRACKER_SKELETON_MARKER} from './trackerReader';

const NULL_TOKENS = {
	input: null,
	output: null,
	cacheRead: null,
	cacheWrite: null,
	total: null,
	contextSize: null,
	contextWindowSize: null,
};

const OK_RESULT: TurnExecutionResult = {
	exitCode: 0,
	error: null,
	tokens: NULL_TOKENS,
	streamMessage: null,
};

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-runner-'));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

describe('createWorkflowRunner', () => {
	it('runs a single non-looped turn and resolves', async () => {
		const startTurn = vi.fn().mockResolvedValue(OK_RESULT);
		const persistRunState = vi.fn();

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir: makeTempDir(),
			prompt: 'do it',
			startTurn,
			persistRunState,
		});

		expect(handle.runId).toBeDefined();
		const result = await handle.result;
		expect(result.status).toBe('completed');
		expect(result.iterations).toBe(1);
		expect(startTurn).toHaveBeenCalledTimes(1);
		expect(persistRunState).toHaveBeenCalled();
	});

	it('loops until completion marker is found', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		const trackerPath = path.join(trackerDir, 'tracker.md');

		const startTurn = vi
			.fn()
			.mockImplementationOnce(async () => {
				fs.writeFileSync(trackerPath, '## Plan\n- task 1\n- task 2', 'utf-8');
				return OK_RESULT;
			})
			.mockImplementationOnce(async () => {
				fs.writeFileSync(
					trackerPath,
					'## Plan\n- [x] task 1\n- [x] task 2\n<!-- WORKFLOW_COMPLETE -->',
					'utf-8',
				);
				return OK_RESULT;
			});

		const persistRunState = vi.fn();
		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 5},
			},
			startTurn,
			persistRunState,
		});

		const result = await handle.result;
		expect(result.status).toBe('completed');
		expect(result.iterations).toBe(2);
		expect(startTurn).toHaveBeenCalledTimes(2);
	});

	it('creates tracker skeleton before first turn when loop enabled', async () => {
		const projectDir = makeTempDir();
		const trackerPath = path.join(projectDir, '.athena', 's1', 'tracker.md');
		let trackerExistsBeforeFirstTurn = false;
		let trackerContent = '';

		const startTurn = vi.fn().mockImplementationOnce(async () => {
			trackerExistsBeforeFirstTurn = fs.existsSync(trackerPath);
			trackerContent = fs.readFileSync(trackerPath, 'utf-8');
			fs.writeFileSync(trackerPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
			return OK_RESULT;
		});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 5},
			},
			startTurn,
			persistRunState: vi.fn(),
		});

		await handle.result;
		expect(trackerExistsBeforeFirstTurn).toBe(true);
		expect(trackerContent).toContain(TRACKER_SKELETON_MARKER);
		expect(trackerContent).toContain('s1');
	});

	it('cancel stops the loop after current turn', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		const trackerPath = path.join(trackerDir, 'tracker.md');

		let turnCount = 0;
		// handleRef is declared here and assigned after createWorkflowRunner returns.
		// The mock captures it via closure. This is safe because startTurn runs async —
		// by the time the mock executes, handleRef has already been assigned.
		const handleRef: {current?: ReturnType<typeof createWorkflowRunner>} = {};

		const startTurn = vi.fn().mockImplementation(async () => {
			turnCount++;
			fs.writeFileSync(trackerPath, 'still running', 'utf-8');
			if (turnCount === 1) {
				handleRef.current!.cancel();
			}
			return OK_RESULT;
		});

		handleRef.current = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 10},
			},
			startTurn,
			persistRunState: vi.fn(),
		});

		const result = await handleRef.current!.result;
		expect(result.status).toBe('cancelled');
		expect(startTurn).toHaveBeenCalledTimes(1);
	});

	it('kill aborts the current turn', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		const trackerPath = path.join(trackerDir, 'tracker.md');
		fs.writeFileSync(trackerPath, 'running', 'utf-8');

		const abortCurrentTurn = vi.fn();
		let resolveFirstTurn: ((r: TurnExecutionResult) => void) | null = null;

		const startTurn = vi.fn().mockImplementation(() => {
			return new Promise<TurnExecutionResult>(resolve => {
				resolveFirstTurn = resolve;
			});
		});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 10},
			},
			startTurn,
			persistRunState: vi.fn(),
			abortCurrentTurn,
		});

		await new Promise(r => setTimeout(r, 10));
		expect(startTurn).toHaveBeenCalledTimes(1);

		handle.kill();
		expect(abortCurrentTurn).toHaveBeenCalledTimes(1);

		resolveFirstTurn!({...OK_RESULT, error: new Error('killed')});

		const result = await handle.result;
		expect(result.status).toBe('cancelled');
	});

	it('suspends as awaiting_attention when the tracker declares a block', async () => {
		const projectDir = makeTempDir();
		const trackerPath = path.join(projectDir, '.athena', 's1', 'tracker.md');

		const startTurn = vi.fn().mockImplementationOnce(async () => {
			fs.writeFileSync(
				trackerPath,
				'## Notes\nNeed a human.\n<!-- WORKFLOW_BLOCKED: which env? -->',
				'utf-8',
			);
			return OK_RESULT;
		});
		const persistRunState = vi.fn();

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 5},
			},
			startTurn,
			persistRunState,
		});

		const result = await handle.result;
		expect(result.status).toBe('awaiting_attention');
		expect(result.stopReason).toBe(
			'agent declared WORKFLOW_BLOCKED: which env?',
		);
		expect(startTurn).toHaveBeenCalledTimes(1);
		expect(persistRunState).toHaveBeenLastCalledWith(
			expect.objectContaining({status: 'awaiting_attention'}),
		);
	});

	it('suspends via checkSuspension even when the interrupted turn exited abnormally', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		fs.writeFileSync(path.join(trackerDir, 'tracker.md'), 'working', 'utf-8');

		// The Turn was killed to suspend (e.g. an unanswerable AskUserQuestion),
		// so the harness process exited non-zero — that must not read as failure.
		const startTurn = vi.fn().mockResolvedValue({
			...OK_RESULT,
			exitCode: 143,
			error: new Error('killed'),
		});
		const persistRunState = vi.fn();

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 5},
			},
			startTurn,
			persistRunState,
			checkSuspension: () => ({
				reason: 'agent asked a question with no human attached to answer',
			}),
		});

		const result = await handle.result;
		expect(result.status).toBe('awaiting_attention');
		expect(result.stopReason).toContain('asked a question');
		expect(startTurn).toHaveBeenCalledTimes(1);
	});

	it('reports failed when turn exits non-zero', async () => {
		const startTurn = vi.fn().mockResolvedValue({
			...OK_RESULT,
			exitCode: 1,
		});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir: makeTempDir(),
			prompt: 'do it',
			startTurn,
			persistRunState: vi.fn(),
		});

		const result = await handle.result;
		expect(result.status).toBe('failed');
	});

	it('fails fast when Claude stream shows tool use but hooks are silent', async () => {
		const startTurn = vi.fn().mockResolvedValue({
			...OK_RESULT,
			diagnostics: {
				transport: {
					streamToolUses: 1,
					preToolUseEvents: 0,
				},
			},
		});
		const persistRunState = vi.fn();

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir: makeTempDir(),
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 5},
			},
			startTurn,
			persistRunState,
		});

		const result = await handle.result;
		expect(result.status).toBe('failed');
		expect(result.stopReason).toContain('Hook transport broken');
		expect(startTurn).toHaveBeenCalledTimes(1);
		expect(persistRunState).toHaveBeenLastCalledWith(
			expect.objectContaining({
				status: 'failed',
				stopReason: expect.stringContaining('Hook transport broken'),
			}),
		);
	});

	it('nudges an untouched skeleton with a bootstrap corrective, then honors the declaration', async () => {
		const projectDir = makeTempDir();
		const trackerPath = path.join(projectDir, '.athena', 's1', 'tracker.md');

		// Turn 1: the agent asked its question in chat and never touched the
		// tracker. Turn 2 (the nudged resume) declares it properly.
		const prompts: string[] = [];
		const startTurn = vi
			.fn()
			.mockImplementation(async (turnInput: {prompt: string}) => {
				prompts.push(turnInput.prompt);
				if (prompts.length === 2) {
					fs.writeFileSync(
						trackerPath,
						'## Status\nNeed the operator.\n<!-- WORKFLOW_BLOCKED: English or French? -->',
						'utf-8',
					);
				}
				return OK_RESULT;
			});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 5},
			},
			startTurn,
			persistRunState: vi.fn(),
			currentAdapterSessionId: () => 'claude-sess-1',
		});

		const result = await handle.result;
		expect(result.status).toBe('awaiting_attention');
		expect(result.stopReason).toContain(
			'agent declared WORKFLOW_BLOCKED: English or French?',
		);
		expect(startTurn).toHaveBeenCalledTimes(2);
		// The corrective names the bootstrap duty and the declare-don't-chat rule.
		expect(prompts[1]).toContain("still contains the runner's skeleton");
		expect(prompts[1]).toContain('do not ask it in chat');
		// And it resumes the same Agent Session that has the question in context.
		expect(startTurn.mock.calls[1]![0].continuation).toEqual({
			mode: 'resume',
			handle: 'claude-sess-1',
		});
	});

	it('suspends at the nudge cap when the skeleton never advances', async () => {
		const projectDir = makeTempDir();

		const startTurn = vi.fn().mockResolvedValue(OK_RESULT);
		const persistRunState = vi.fn();

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 10, nudgeCap: 2},
			},
			startTurn,
			persistRunState,
			currentAdapterSessionId: () => 'claude-sess-1',
		});

		const result = await handle.result;
		// A genuinely broken bootstrap is still bounded — but it escalates to a
		// resumable suspension naming the tripped bound, not a dead `failed`.
		expect(result.status).toBe('awaiting_attention');
		expect(result.stopReason).toContain('nudge cap reached');
		expect(startTurn).toHaveBeenCalledTimes(3);
	});

	it('fails fast when a terminal marker is not the final tracker line', async () => {
		const projectDir = makeTempDir();
		const trackerPath = path.join(projectDir, '.athena', 's1', 'tracker.md');

		const startTurn = vi.fn().mockImplementationOnce(async () => {
			fs.writeFileSync(
				trackerPath,
				[
					'## Summary',
					'All work was completed.',
					'<!-- WORKFLOW_COMPLETE -->',
					'Trailing summary that would otherwise cause another iteration.',
				].join('\n'),
				'utf-8',
			);
			return OK_RESULT;
		});
		const persistRunState = vi.fn();

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 5},
			},
			startTurn,
			persistRunState,
		});

		const result = await handle.result;
		expect(result.status).toBe('failed');
		expect(result.stopReason).toContain('final non-empty line');
		expect(startTurn).toHaveBeenCalledTimes(1);
		expect(persistRunState).toHaveBeenLastCalledWith(
			expect.objectContaining({
				status: 'failed',
				stopReason: expect.stringContaining('final non-empty line'),
			}),
		);
	});

	it('surfaces a human-readable reason when the tracker disappears mid-run', async () => {
		const projectDir = makeTempDir();
		const trackerPath = path.join(projectDir, '.athena', 's1', 'tracker.md');

		// The agent removes the tracker during the turn. The Runner must report a
		// terminal outcome the user can read — never the raw Stop Reason enum.
		const startTurn = vi.fn().mockImplementationOnce(async () => {
			fs.rmSync(trackerPath, {force: true});
			return OK_RESULT;
		});
		const persistRunState = vi.fn();

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 5},
			},
			startTurn,
			persistRunState,
		});

		const result = await handle.result;
		expect(result.status).toBe('failed');
		expect(result.stopReason).not.toContain('missing_tracker');
		expect(result.stopReason).toMatch(/tracker/i);
		expect(startTurn).toHaveBeenCalledTimes(1);
		expect(persistRunState).toHaveBeenLastCalledWith(
			expect.objectContaining({
				status: 'failed',
				stopReason: expect.stringMatching(/tracker/i),
			}),
		);
	});

	it('nudges an undeclared markerless stop by resuming the same Agent Session with a corrective prompt', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		const trackerPath = path.join(trackerDir, 'tracker.md');

		const calls: Array<{continuation: unknown; prompt: string}> = [];
		const startTurn = vi
			.fn()
			.mockImplementationOnce(
				async (input: {continuation: unknown; prompt: string}) => {
					calls.push(input);
					fs.writeFileSync(trackerPath, 'working', 'utf-8');
					return OK_RESULT;
				},
			)
			.mockImplementationOnce(
				async (input: {continuation: unknown; prompt: string}) => {
					calls.push(input);
					fs.writeFileSync(trackerPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
					return OK_RESULT;
				},
			);

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 5},
			},
			startTurn,
			persistRunState: vi.fn(),
			currentAdapterSessionId: () => 'claude-sess-abc',
		});

		const result = await handle.result;
		expect(result.status).toBe('completed');
		// A nudged (resumed) Turn is still a Turn: the Iteration counter ticked.
		expect(result.iterations).toBe(2);
		expect(calls[0]!.continuation).toEqual({mode: 'fresh'});
		expect(calls[1]!.continuation).toEqual({
			mode: 'resume',
			handle: 'claude-sess-abc',
		});
		// The corrective prompt states both options: finish, or declare.
		expect(calls[1]!.prompt).toContain('continue it now');
		expect(calls[1]!.prompt).toContain('<!-- WORKFLOW_COMPLETE -->');
		expect(calls[1]!.prompt).toContain('<!-- WORKFLOW_BLOCKED');
	});

	it('suspends after the nudge cap with no tracker progress, naming the bound', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		const trackerPath = path.join(trackerDir, 'tracker.md');

		// Every Turn stops cleanly without a marker and without touching the
		// tracker after the first write — pure unproductive spinning.
		const startTurn = vi.fn().mockImplementation(async () => {
			fs.writeFileSync(trackerPath, 'stuck', 'utf-8');
			return OK_RESULT;
		});
		const persistRunState = vi.fn();

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 20, nudgeCap: 2},
			},
			startTurn,
			persistRunState,
			currentAdapterSessionId: () => 'claude-sess-abc',
		});

		const result = await handle.result;
		expect(result.status).toBe('awaiting_attention');
		expect(result.stopReason).toContain('nudge cap');
		expect(result.stopReason).toContain('nudgeCap');
		// Stop 1 → nudge 1, stop 2 → nudge 2, stop 3 → cap exceeded, suspend.
		expect(startTurn).toHaveBeenCalledTimes(3);
		expect(persistRunState).toHaveBeenLastCalledWith(
			expect.objectContaining({status: 'awaiting_attention'}),
		);
	});

	it('resets the nudge cap whenever the tracker advances between stops', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		const trackerPath = path.join(trackerDir, 'tracker.md');

		// Six markerless stops, each advancing the tracker (a checkpointing
		// workflow), then completion. With nudgeCap 2 this must NOT suspend —
		// only unproductive repeated stops escalate.
		let turn = 0;
		const startTurn = vi.fn().mockImplementation(async () => {
			turn++;
			if (turn <= 6) {
				fs.writeFileSync(trackerPath, `progress step ${turn}`, 'utf-8');
			} else {
				fs.writeFileSync(trackerPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
			}
			return OK_RESULT;
		});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 20, nudgeCap: 2},
			},
			startTurn,
			persistRunState: vi.fn(),
			currentAdapterSessionId: () => 'claude-sess-abc',
		});

		const result = await handle.result;
		expect(result.status).toBe('completed');
		expect(result.iterations).toBe(7);
	});

	it('falls back to a fresh Turn on a markerless stop when no vendor session id exists', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		const trackerPath = path.join(trackerDir, 'tracker.md');

		const continuations: unknown[] = [];
		const startTurn = vi
			.fn()
			.mockImplementationOnce(async (input: {continuation: unknown}) => {
				continuations.push(input.continuation);
				fs.writeFileSync(trackerPath, 'working', 'utf-8');
				return OK_RESULT;
			})
			.mockImplementationOnce(async (input: {continuation: unknown}) => {
				continuations.push(input.continuation);
				fs.writeFileSync(trackerPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
				return OK_RESULT;
			});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 5},
			},
			startTurn,
			persistRunState: vi.fn(),
		});

		const result = await handle.result;
		expect(result.status).toBe('completed');
		expect(continuations).toEqual([{mode: 'fresh'}, {mode: 'fresh'}]);
	});

	it('retries a transient failure by resuming the same Agent Session after a backoff', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		const trackerPath = path.join(trackerDir, 'tracker.md');

		const calls: Array<{continuation: unknown}> = [];
		const statuses: string[] = [];
		const startTurn = vi
			.fn()
			.mockImplementationOnce(async (input: {continuation: unknown}) => {
				calls.push(input);
				fs.writeFileSync(trackerPath, 'working', 'utf-8');
				return {
					...OK_RESULT,
					exitCode: 1,
					error: new Error('API Error: 429 rate_limit_error'),
				};
			})
			.mockImplementationOnce(async (input: {continuation: unknown}) => {
				calls.push(input);
				fs.writeFileSync(trackerPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
				return OK_RESULT;
			});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 5, retryBackoffMs: 1},
			},
			startTurn,
			persistRunState: vi.fn(snapshot => {
				statuses.push((snapshot as {status: string}).status);
			}),
			currentAdapterSessionId: () => 'claude-sess-abc',
		});

		const result = await handle.result;
		expect(result.status).toBe('completed');
		// The retried attempt reuses the iteration — transient infra failures
		// don't burn the ceiling.
		expect(result.iterations).toBe(1);
		expect(calls[1]!.continuation).toEqual({
			mode: 'resume',
			handle: 'claude-sess-abc',
		});
		// The Run stayed `running` throughout the retry — it never left it
		// until completion.
		expect(statuses).not.toContain('failed');
		expect(statuses).not.toContain('awaiting_attention');
	});

	it('retries when the API error reaches only the stream message (empty stderr)', async () => {
		// Live shape (Claude Code 2.1.246, stream-json): an API failure exits 1
		// with NOTHING on stderr — the error text arrives as the final stream
		// message on stdout. The classifier must see it, or every transient
		// failure suspends as hard/unclassified.
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		const trackerPath = path.join(trackerDir, 'tracker.md');

		const startTurn = vi
			.fn()
			.mockImplementationOnce(async () => ({
				...OK_RESULT,
				exitCode: 1,
				streamMessage:
					'API Error: Connection refused — a firewall or proxy may be blocking it (ConnectionRefused)',
			}))
			.mockImplementationOnce(async () => {
				fs.writeFileSync(trackerPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
				return OK_RESULT;
			});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 5, retryBackoffMs: 1},
			},
			startTurn,
			persistRunState: vi.fn(),
			currentAdapterSessionId: () => 'claude-sess-abc',
		});

		const result = await handle.result;
		expect(result.status).toBe('completed');
		expect(startTurn).toHaveBeenCalledTimes(2);
	});

	it('suspends when the retry cap is exhausted, naming the retry cap', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		fs.writeFileSync(path.join(trackerDir, 'tracker.md'), 'working', 'utf-8');

		const startTurn = vi.fn().mockResolvedValue({
			...OK_RESULT,
			exitCode: 1,
			error: new Error('API Error: 529 overloaded_error'),
		});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {
					enabled: true,
					maxIterations: 20,
					retryCap: 2,
					retryBackoffMs: 1,
				},
			},
			startTurn,
			persistRunState: vi.fn(),
			currentAdapterSessionId: () => 'claude-sess-abc',
		});

		const result = await handle.result;
		expect(result.status).toBe('awaiting_attention');
		expect(result.stopReason).toContain('retry cap');
		expect(result.stopReason).toContain('retryCap');
		expect(result.stopReason).toContain('overloaded');
		// Attempt 1 → retry 1, retry 2, then the cap trips on the third failure.
		expect(startTurn).toHaveBeenCalledTimes(3);
	});

	it('suspends immediately on a hard failure without retrying', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		fs.writeFileSync(path.join(trackerDir, 'tracker.md'), 'working', 'utf-8');

		const startTurn = vi.fn().mockResolvedValue({
			...OK_RESULT,
			exitCode: 1,
			error: new Error('API Error: 401 authentication_error'),
		});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 5},
			},
			startTurn,
			persistRunState: vi.fn(),
		});

		const result = await handle.result;
		expect(result.status).toBe('awaiting_attention');
		expect(result.stopReason).toContain('hard failure (auth)');
		expect(result.stopReason).toContain('authentication_error');
		expect(startTurn).toHaveBeenCalledTimes(1);
	});

	it('classifies from the stderr tail when the first line is teardown noise', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		fs.writeFileSync(path.join(trackerDir, 'tracker.md'), 'working', 'utf-8');

		// Observed live: the first stderr line was a cancelled SessionEnd hook,
		// and the 401 arrived later. Classification must see the tail — this is
		// an auth failure, not `unclassified`.
		const startTurn = vi.fn().mockResolvedValue({
			...OK_RESULT,
			exitCode: 1,
			lastStderr: 'SessionEnd hook failed: Hook cancelled',
			stderrTail:
				'SessionEnd hook failed: Hook cancelled\nFailed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.',
		});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 5},
			},
			startTurn,
			persistRunState: vi.fn(),
		});

		const result = await handle.result;
		expect(result.status).toBe('awaiting_attention');
		expect(result.stopReason).toContain('hard failure (auth)');
		expect(startTurn).toHaveBeenCalledTimes(1);
	});

	it('keeps plain terminal failure for non-looped runs', async () => {
		const startTurn = vi.fn().mockResolvedValue({
			...OK_RESULT,
			exitCode: 1,
			error: new Error('API Error: 401 authentication_error'),
		});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir: makeTempDir(),
			prompt: 'do it',
			startTurn,
			persistRunState: vi.fn(),
		});

		const result = await handle.result;
		expect(result.status).toBe('failed');
	});

	it('degrades a failed nudge resume to a fresh replay of the same iteration', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		const trackerPath = path.join(trackerDir, 'tracker.md');

		const continuations: unknown[] = [];
		const startTurn = vi
			.fn()
			.mockImplementationOnce(async (input: {continuation: unknown}) => {
				continuations.push(input.continuation);
				fs.writeFileSync(trackerPath, 'working', 'utf-8');
				return OK_RESULT;
			})
			// The nudge resume dies at startup (the vendor session is gone).
			.mockImplementationOnce(async (input: {continuation: unknown}) => {
				continuations.push(input.continuation);
				return {
					...OK_RESULT,
					exitCode: 1,
					error: new Error('No conversation found with session ID'),
				};
			})
			// The fresh replay of the same iteration completes the workflow.
			.mockImplementationOnce(async (input: {continuation: unknown}) => {
				continuations.push(input.continuation);
				fs.writeFileSync(trackerPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
				return OK_RESULT;
			});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 5},
			},
			startTurn,
			persistRunState: vi.fn(),
			currentAdapterSessionId: () => 'claude-sess-abc',
		});

		const result = await handle.result;
		expect(result.status).toBe('completed');
		// The failed resume attempt never ran an agent — it does not burn an
		// iteration against the ceiling.
		expect(result.iterations).toBe(2);
		expect(continuations).toEqual([
			{mode: 'fresh'},
			{mode: 'resume', handle: 'claude-sess-abc'},
			{mode: 'fresh'},
		]);
	});

	it('snapshots the vendor session id from currentAdapterSessionId', async () => {
		const persistRunState = vi.fn();
		const startTurn = vi.fn().mockImplementation(async () => {
			adapterSessionId = 'claude-sess-abc';
			return OK_RESULT;
		});
		let adapterSessionId: string | null = null;

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir: makeTempDir(),
			prompt: 'do it',
			startTurn,
			persistRunState,
			currentAdapterSessionId: () => adapterSessionId,
		});

		await handle.result;
		// The initial persist (before any Turn) has no id; the final one does.
		expect(persistRunState.mock.calls[0]![0]).not.toHaveProperty(
			'adapterSessionId',
		);
		expect(persistRunState).toHaveBeenLastCalledWith(
			expect.objectContaining({adapterSessionId: 'claude-sess-abc'}),
		);
	});

	it('runs a Handover: fork writes the Handoff file, then a fresh Turn is seeded with it', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		const trackerPath = path.join(trackerDir, 'tracker.md');
		// The Handoff chain starts at 001 (ADR 0014 §5).
		const handoffPath = path.join(trackerDir, 'handoff', '001.md');

		let pendingHandover: {handle: string} | null = null;
		const forkStates: boolean[] = [];
		const calls: Array<{
			prompt: string;
			continuation: unknown;
			configOverride?: Record<string, unknown>;
		}> = [];

		const startTurn = vi
			.fn()
			// Turn 1: interrupted mid-work by the Handover (compaction blocked,
			// process killed) — exits abnormally with a pending request.
			.mockImplementationOnce(async (input: never) => {
				calls.push(input);
				fs.writeFileSync(trackerPath, 'deep in work', 'utf-8');
				pendingHandover = {handle: 'claude-sess-primary'};
				return {...OK_RESULT, exitCode: 143, error: new Error('killed')};
			})
			// The fork: resumes the primary conversation, writes the Handoff file.
			.mockImplementationOnce(async (input: never) => {
				calls.push(input);
				fs.mkdirSync(path.dirname(handoffPath), {recursive: true});
				fs.writeFileSync(handoffPath, '# Handoff\nwhere things stand', 'utf-8');
				return OK_RESULT;
			})
			// The fresh post-Handover Turn completes the workflow.
			.mockImplementationOnce(async (input: never) => {
				calls.push(input);
				fs.writeFileSync(trackerPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
				return OK_RESULT;
			});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 5},
			},
			startTurn,
			persistRunState: vi.fn(),
			handover: {
				takeRequest: () => {
					const request = pendingHandover;
					pendingHandover = null;
					return request;
				},
				onForkStateChange: forking => forkStates.push(forking),
			},
		});

		const result = await handle.result;
		expect(result.status).toBe('completed');
		// Turn 1 (interrupted) + post-Handover Turn tick; the fork does not.
		expect(result.iterations).toBe(2);
		expect(startTurn).toHaveBeenCalledTimes(3);

		// The fork resumed the primary conversation with --fork-session.
		expect(calls[1]!.continuation).toEqual({
			mode: 'resume',
			handle: 'claude-sess-primary',
		});
		expect(calls[1]!.configOverride).toMatchObject({forkSession: true});
		expect(calls[1]!.prompt).toContain('handoff skill');
		expect(calls[1]!.prompt).toContain(handoffPath);

		// Compaction stayed blocked exactly while the fork ran.
		expect(forkStates).toEqual([true, false]);

		// The post-Handover Turn is fresh and seeded with Handoff file + Tracker.
		expect(calls[2]!.continuation).toEqual({mode: 'fresh'});
		expect(calls[2]!.prompt).toContain('Handover occurred');
		expect(calls[2]!.prompt).toContain(handoffPath);
		expect(calls[2]!.prompt).toContain(trackerPath);
	});

	it('keeps prior Handoff files: each Handover writes the next numbered file', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		const trackerPath = path.join(trackerDir, 'tracker.md');
		const handoffDir = path.join(trackerDir, 'handoff');

		let pendingHandover: {handle: string} | null = null;
		const calls: Array<{prompt: string; continuation: unknown}> = [];

		// The fork writes to whichever path the invocation prompt names.
		const writeHandoffFromPrompt = (prompt: string, body: string): void => {
			const named = /(\S*handoff\S*\.md)/.exec(prompt);
			if (!named) throw new Error(`no Handoff path in prompt: ${prompt}`);
			fs.mkdirSync(path.dirname(named[1]!), {recursive: true});
			fs.writeFileSync(named[1]!, body, 'utf-8');
		};

		const startTurn = vi
			.fn()
			// Turn 1 → first Handover.
			.mockImplementationOnce(async (input: never) => {
				calls.push(input);
				fs.writeFileSync(trackerPath, 'work in progress', 'utf-8');
				pendingHandover = {handle: 'sess-a'};
				return {...OK_RESULT, exitCode: 143, error: new Error('killed')};
			})
			// Fork 1 writes Handoff 001.
			.mockImplementationOnce(async (input: {prompt: string}) => {
				calls.push(input as never);
				writeHandoffFromPrompt(input.prompt, '# Handoff one');
				return OK_RESULT;
			})
			// Turn 2 (fresh, seeded) → second Handover.
			.mockImplementationOnce(async (input: never) => {
				calls.push(input);
				pendingHandover = {handle: 'sess-b'};
				return {...OK_RESULT, exitCode: 143, error: new Error('killed')};
			})
			// Fork 2 writes Handoff 002.
			.mockImplementationOnce(async (input: {prompt: string}) => {
				calls.push(input as never);
				writeHandoffFromPrompt(input.prompt, '# Handoff two');
				return OK_RESULT;
			})
			// Turn 3 finishes.
			.mockImplementationOnce(async (input: never) => {
				calls.push(input);
				fs.writeFileSync(trackerPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
				return OK_RESULT;
			});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 5},
			},
			startTurn,
			persistRunState: vi.fn(),
			handover: {
				takeRequest: () => {
					const request = pendingHandover;
					pendingHandover = null;
					return request;
				},
			},
		});

		const result = await handle.result;
		expect(result.status).toBe('completed');

		// Both Handoff files survive: the second Handover did not destroy the first.
		expect(fs.readdirSync(handoffDir).sort()).toEqual(['001.md', '002.md']);
		expect(fs.readFileSync(path.join(handoffDir, '001.md'), 'utf-8')).toContain(
			'Handoff one',
		);
		expect(fs.readFileSync(path.join(handoffDir, '002.md'), 'utf-8')).toContain(
			'Handoff two',
		);

		// Each Handover targets and seeds from its own file.
		expect(calls[1]!.prompt).toContain(path.join(handoffDir, '001.md'));
		expect(calls[2]!.prompt).toContain(path.join(handoffDir, '001.md'));
		expect(calls[3]!.prompt).toContain(path.join(handoffDir, '002.md'));
		expect(calls[4]!.prompt).toContain(path.join(handoffDir, '002.md'));
	});

	it('purges old Handoff files, keeping the two most recent', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		const trackerPath = path.join(trackerDir, 'tracker.md');
		const handoffDir = path.join(trackerDir, 'handoff');

		let pendingHandover: {handle: string} | null = null;
		let handovers = 0;

		const startTurn = vi
			.fn()
			.mockImplementation(async (input: {prompt: string}) => {
				const named = /(\S*handoff\S*\.md)/.exec(input.prompt);
				if (named && input.prompt.includes('handoff skill')) {
					fs.mkdirSync(path.dirname(named[1]!), {recursive: true});
					fs.writeFileSync(named[1]!, `# Handoff ${named[1]!}`, 'utf-8');
					return OK_RESULT;
				}
				if (handovers < 3) {
					handovers += 1;
					fs.writeFileSync(trackerPath, `work ${handovers}`, 'utf-8');
					pendingHandover = {handle: `sess-${handovers}`};
					return {...OK_RESULT, exitCode: 143, error: new Error('killed')};
				}
				fs.writeFileSync(trackerPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
				return OK_RESULT;
			});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 9},
			},
			startTurn,
			persistRunState: vi.fn(),
			handover: {
				takeRequest: () => {
					const request = pendingHandover;
					pendingHandover = null;
					return request;
				},
			},
		});

		const result = await handle.result;
		expect(result.status).toBe('completed');
		// Three Handovers wrote 001-003; only the newest two are retained.
		expect(fs.readdirSync(handoffDir).sort()).toEqual(['002.md', '003.md']);
	});

	it('degrades a failed Handover to vendor compaction: resume in place, stop intercepting', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		const trackerPath = path.join(trackerDir, 'tracker.md');

		let pendingHandover: {handle: string} | null = null;
		const degraded: string[] = [];
		const calls: Array<{continuation: unknown}> = [];

		const startTurn = vi
			.fn()
			.mockImplementationOnce(async (input: never) => {
				calls.push(input);
				fs.writeFileSync(trackerPath, 'working', 'utf-8');
				pendingHandover = {handle: 'claude-sess-primary'};
				return {...OK_RESULT, exitCode: 143, error: new Error('killed')};
			})
			// The fork fails — no Handoff file is written.
			.mockImplementationOnce(async (input: never) => {
				calls.push(input);
				return {...OK_RESULT, exitCode: 1, error: new Error('fork died')};
			})
			// Degraded continuation: resume the interrupted conversation in place.
			.mockImplementationOnce(async (input: never) => {
				calls.push(input);
				fs.writeFileSync(trackerPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
				return OK_RESULT;
			});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 5},
			},
			startTurn,
			persistRunState: vi.fn(),
			handover: {
				takeRequest: () => {
					const request = pendingHandover;
					pendingHandover = null;
					return request;
				},
				onDegraded: handle_ => degraded.push(handle_),
			},
		});

		const result = await handle.result;
		expect(result.status).toBe('completed');
		expect(degraded).toEqual(['claude-sess-primary']);
		expect(calls[2]!.continuation).toEqual({
			mode: 'resume',
			handle: 'claude-sess-primary',
		});
	});

	it('frames the human reply with wake context on the first Turn of a woken run', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		const trackerPath = path.join(trackerDir, 'tracker.md');

		const prompts: string[] = [];
		const startTurn = vi
			.fn()
			.mockImplementation(async (input: {prompt: string}) => {
				prompts.push(input.prompt);
				fs.writeFileSync(trackerPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
				return OK_RESULT;
			});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'French, please.',
			resumeRunId: 'run-suspended',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 5},
			},
			startTurn,
			persistRunState: vi.fn(),
		});

		const result = await handle.result;
		expect(result.status).toBe('completed');
		// Not the bare reply: the wake framing carries the reply, points at the
		// tracker, and demands the protocol bookkeeping even on a degraded
		// fresh session.
		expect(prompts[0]).toContain('suspended awaiting a human');
		expect(prompts[0]).toContain('French, please.');
		expect(prompts[0]).toContain('tracker');
		expect(prompts[0]).toContain('terminal marker');
	});

	it('reuses a resumed run id so the suspended run returns to running', async () => {
		const persistRunState = vi.fn();
		const startTurn = vi.fn().mockResolvedValue(OK_RESULT);

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir: makeTempDir(),
			prompt: 'the human reply',
			resumeRunId: 'run-suspended',
			startTurn,
			persistRunState,
		});

		expect(handle.runId).toBe('run-suspended');
		await handle.result;
		expect(persistRunState).toHaveBeenLastCalledWith(
			expect.objectContaining({runId: 'run-suspended'}),
		);
	});

	it('records each Workflow Run goal when the Tracker already exists', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		const trackerPath = path.join(trackerDir, 'tracker.md');
		// A prior Workflow Run in the same Athena Session left this behind.
		fs.writeFileSync(
			trackerPath,
			'# Workflow Tracker\n\nprior run work\n',
			'utf-8',
		);

		const startTurn = vi.fn().mockImplementation(async () => {
			fs.appendFileSync(trackerPath, '\n<!-- WORKFLOW_COMPLETE -->\n', 'utf-8');
			return OK_RESULT;
		});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'the second goal',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 3},
			},
			startTurn,
			persistRunState: vi.fn(),
		});

		await handle.result;

		const tracker = fs.readFileSync(trackerPath, 'utf-8');
		// The new Run's goal is on the Tracker, and the prior Run's work survives.
		expect(tracker).toContain('the second goal');
		expect(tracker).toContain('prior run work');
	});

	it('does not inherit a prior Run terminal marker', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		const trackerPath = path.join(trackerDir, 'tracker.md');
		// The prior Run finished and left its completion marker as the last line.
		fs.writeFileSync(
			trackerPath,
			'# Workflow Tracker\n\nprior run work\n\n<!-- WORKFLOW_COMPLETE -->\n',
			'utf-8',
		);

		// Turn 1 does real work but declares nothing; Turn 2 completes.
		const startTurn = vi
			.fn()
			.mockImplementationOnce(async () => {
				fs.appendFileSync(trackerPath, '\nworking on the new goal\n', 'utf-8');
				return OK_RESULT;
			})
			.mockImplementationOnce(async () => {
				fs.appendFileSync(
					trackerPath,
					'\n<!-- WORKFLOW_COMPLETE -->\n',
					'utf-8',
				);
				return OK_RESULT;
			});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'the second goal',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 3},
			},
			startTurn,
			persistRunState: vi.fn(),
		});

		const result = await handle.result;

		// The stale marker did not end the new Run at its first Turn...
		expect(startTurn).toHaveBeenCalledTimes(2);
		expect(result.status).toBe('completed');
		// ...and it was demoted rather than left to read as a misplaced marker.
		const afterBanner = fs
			.readFileSync(trackerPath, 'utf-8')
			.split('the second goal')[0]!;
		expect(afterBanner).not.toContain('<!-- WORKFLOW_COMPLETE -->');
		expect(afterBanner).toContain('Prior Run ended');
	});

	it('does not open a new Run section when waking a suspended Run', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		const trackerPath = path.join(trackerDir, 'tracker.md');
		fs.writeFileSync(
			trackerPath,
			'# Workflow Tracker\n\nmid-run work\n',
			'utf-8',
		);

		const startTurn = vi.fn().mockImplementation(async () => {
			fs.appendFileSync(trackerPath, '\n<!-- WORKFLOW_COMPLETE -->\n', 'utf-8');
			return OK_RESULT;
		});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'the human reply',
			resumeRunId: 'run-1',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 3},
			},
			startTurn,
			persistRunState: vi.fn(),
		});

		await handle.result;

		// A wake continues the same Run, so it opens no new Run section.
		expect(fs.readFileSync(trackerPath, 'utf-8')).not.toContain(
			'New Workflow Run',
		);
	});

	it('uses injected createTracker instead of fs', async () => {
		const createTracker = vi.fn();
		const startTurn = vi.fn().mockResolvedValue(OK_RESULT);

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir: '/fake',
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 1},
			},
			startTurn,
			persistRunState: vi.fn(),
			createTracker,
		});

		await handle.result;
		expect(createTracker).toHaveBeenCalledTimes(1);
		expect(createTracker.mock.calls[0][0]).toContain('.athena/s1/tracker.md');
		expect(createTracker.mock.calls[0][1]).toContain(TRACKER_SKELETON_MARKER);
	});
});
