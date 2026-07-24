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

	it('fails when the tracker skeleton is never replaced', async () => {
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
				loop: {enabled: true, maxIterations: 5},
			},
			startTurn,
			persistRunState,
		});

		const result = await handle.result;
		expect(result.status).toBe('failed');
		expect(result.stopReason).toMatch(/tracker skeleton.*never.*replaced/i);
		expect(startTurn).toHaveBeenCalledTimes(1);
		expect(persistRunState).toHaveBeenLastCalledWith(
			expect.objectContaining({
				status: 'failed',
				stopReason: expect.stringMatching(/tracker skeleton.*never.*replaced/i),
			}),
		);
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
		const handoffPath = path.join(trackerDir, 'handoff.md');

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
