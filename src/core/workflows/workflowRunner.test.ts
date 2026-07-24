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

	it('resumes the intact Agent Session when nextTurnContinuation asks for it', async () => {
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
			currentAdapterSessionId: () => 'claude-sess-abc',
			nextTurnContinuation: ({adapterSessionId}) =>
				adapterSessionId
					? {mode: 'resume', handle: adapterSessionId}
					: {mode: 'fresh'},
		});

		const result = await handle.result;
		expect(result.status).toBe('completed');
		// A resume is still a Turn: the Iteration counter ticked for it.
		expect(result.iterations).toBe(2);
		expect(continuations).toEqual([
			{mode: 'fresh'},
			{mode: 'resume', handle: 'claude-sess-abc'},
		]);
	});

	it('degrades a failed resume to a fresh replay of the same iteration', async () => {
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
			// The resume attempt dies at startup (e.g. the vendor session is gone).
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
			nextTurnContinuation: () => ({mode: 'resume', handle: 'gone-session'}),
		});

		const result = await handle.result;
		expect(result.status).toBe('completed');
		// The failed resume attempt never ran an agent — it does not burn an
		// iteration against the ceiling.
		expect(result.iterations).toBe(2);
		expect(continuations).toEqual([
			{mode: 'fresh'},
			{mode: 'resume', handle: 'gone-session'},
			{mode: 'fresh'},
		]);
	});

	it('fails the Run when the fresh replay after a degraded resume also fails', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		fs.writeFileSync(path.join(trackerDir, 'tracker.md'), 'working', 'utf-8');

		const startTurn = vi
			.fn()
			.mockImplementationOnce(async () => OK_RESULT)
			.mockImplementationOnce(async () => ({
				...OK_RESULT,
				exitCode: 1,
				error: new Error('resume failed'),
			}))
			.mockImplementationOnce(async () => ({
				...OK_RESULT,
				exitCode: 1,
				error: new Error('fresh replay also failed'),
			}));

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
			nextTurnContinuation: () => ({mode: 'resume', handle: 'gone-session'}),
		});

		const result = await handle.result;
		expect(result.status).toBe('failed');
		expect(result.stopReason).toContain('fresh replay also failed');
		expect(startTurn).toHaveBeenCalledTimes(3);
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
