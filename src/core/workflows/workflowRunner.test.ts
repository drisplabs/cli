import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createWorkflowRunner} from './workflowRunner';
import type {TurnExecutionResult} from '../runtime/process';
import {JOURNAL_SKELETON_MARKER} from './journalReader';
import type {JournalTaskProjection} from './journalReader';
import {STEER_BLOCK_END, STEER_BLOCK_OPEN} from './steer';
import type {RunMemory} from './runMachine';
import {deserializeRunMemory} from './runMachine';
import type {WorkflowRunSnapshot} from '../../infra/sessions/types';

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
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');

		const startTurn = vi
			.fn()
			.mockImplementationOnce(async () => {
				fs.writeFileSync(journalPath, '## Plan\n- task 1\n- task 2', 'utf-8');
				return OK_RESULT;
			})
			.mockImplementationOnce(async () => {
				fs.writeFileSync(
					journalPath,
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

	it('creates journal skeleton before first turn when loop enabled', async () => {
		const projectDir = makeTempDir();
		const journalPath = path.join(projectDir, '.athena', 's1', 'journal.md');
		let journalExistsBeforeFirstTurn = false;
		let journalContent = '';

		const startTurn = vi.fn().mockImplementationOnce(async () => {
			journalExistsBeforeFirstTurn = fs.existsSync(journalPath);
			journalContent = fs.readFileSync(journalPath, 'utf-8');
			fs.writeFileSync(journalPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
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
		expect(journalExistsBeforeFirstTurn).toBe(true);
		expect(journalContent).toContain(JOURNAL_SKELETON_MARKER);
		expect(journalContent).toContain('s1');
	});

	it('cancel stops the loop after current turn', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');

		let turnCount = 0;
		// handleRef is declared here and assigned after createWorkflowRunner returns.
		// The mock captures it via closure. This is safe because startTurn runs async —
		// by the time the mock executes, handleRef has already been assigned.
		const handleRef: {current?: ReturnType<typeof createWorkflowRunner>} = {};

		const startTurn = vi.fn().mockImplementation(async () => {
			turnCount++;
			fs.writeFileSync(journalPath, 'still running', 'utf-8');
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
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');
		fs.writeFileSync(journalPath, 'running', 'utf-8');

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

	it('suspends as awaiting_attention when the journal declares a block', async () => {
		const projectDir = makeTempDir();
		const journalPath = path.join(projectDir, '.athena', 's1', 'journal.md');

		const startTurn = vi.fn().mockImplementationOnce(async () => {
			fs.writeFileSync(
				journalPath,
				'## Notes\nNeed a human.\n<!-- NEEDS_HUMAN: which env? -->',
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
		expect(result.stopReason).toBe('agent declared NEEDS_HUMAN: which env?');
		expect(startTurn).toHaveBeenCalledTimes(1);
		expect(persistRunState).toHaveBeenLastCalledWith(
			expect.objectContaining({status: 'awaiting_attention'}),
		);
	});

	it('reaches the same suspended outcome on the legacy WORKFLOW_BLOCKED marker and warns once', async () => {
		const projectDir = makeTempDir();
		const journalPath = path.join(projectDir, '.athena', 's1', 'journal.md');
		const onWarning = vi.fn();

		const startTurn = vi.fn().mockImplementationOnce(async () => {
			fs.writeFileSync(
				journalPath,
				'## Notes\nNeed a human.\n<!-- WORKFLOW_BLOCKED: which env? -->',
				'utf-8',
			);
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
			onWarning,
		});

		const result = await handle.result;
		expect(result.status).toBe('awaiting_attention');
		expect(result.stopReason).toBe('agent declared NEEDS_HUMAN: which env?');
		expect(onWarning).toHaveBeenCalledTimes(1);
		expect(onWarning.mock.calls[0]![0]).toMatch(/WORKFLOW_BLOCKED.*deprecated/);
	});

	it('writes the journal skeleton to journal.md, but keeps reading a legacy tracker.md the session already has', async () => {
		const projectDir = makeTempDir();
		const dossier = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(dossier, {recursive: true});
		const legacyPath = path.join(dossier, 'tracker.md');
		fs.writeFileSync(legacyPath, '# Workflow Tracker\nprior work\n', 'utf-8');

		const startTurn = vi.fn().mockImplementationOnce(async () => {
			fs.appendFileSync(legacyPath, '\n<!-- WORKFLOW_COMPLETE -->\n', 'utf-8');
			return OK_RESULT;
		});

		const persistRunState = vi.fn();
		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'continue',
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
		expect(fs.existsSync(path.join(dossier, 'journal.md'))).toBe(false);
		expect(persistRunState).toHaveBeenLastCalledWith(
			expect.objectContaining({journalPath: '.athena/s1/tracker.md'}),
		);
	});

	it('parks via checkInterruption even when the interrupted turn exited abnormally', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		fs.writeFileSync(path.join(journalDir, 'journal.md'), 'working', 'utf-8');

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
			checkInterruption: () => ({
				kind: 'question',
				question: 'Deploy to prod or staging?',
			}),
		});

		const result = await handle.result;
		expect(result.status).toBe('awaiting_attention');
		expect(result.stopReason).toContain('asked a question');
		expect(startTurn).toHaveBeenCalledTimes(1);
	});

	it('parks on a deferred permission: records the Interruption in the journal and on the run record (#190)', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');
		fs.writeFileSync(journalPath, '## Status\n\nworking', 'utf-8');

		// The Turn was interrupted after the grace window elapsed; the harness
		// process exited non-zero — still a park, not a failure.
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
			checkInterruption: () => ({
				kind: 'unclaimed_permission',
				toolName: 'Bash',
				permission: {
					requestId: 'req-42',
					inputSummary: 'git push origin main',
					graceMs: 60_000,
				},
			}),
		});

		const result = await handle.result;
		expect(result.status).toBe('awaiting_attention');
		expect(result.stopReason).toContain(
			'permission request (Bash) unanswered within the grace window (60s); deferred: git push origin main',
		);
		const interruption = {
			kind: 'question',
			message: result.stopReason,
			requestId: 'req-42',
			question: 'Bash: git push origin main',
		};
		expect(result.interruption).toEqual(interruption);

		// The run record carries the structured Interruption so `drisp runs`
		// and the hub can show the pending question.
		const last = persistRunState.mock.calls.at(-1)![0];
		expect(last).toMatchObject({
			status: 'awaiting_attention',
			stopReason: result.stopReason,
			interruption,
		});

		// The journal records it too — the next Turn reads it there — without
		// disturbing what the agent wrote.
		const journal = fs.readFileSync(journalPath, 'utf-8');
		expect(journal.startsWith('## Status\n\nworking')).toBe(true);
		expect(journal).toContain('Needs human');
		expect(journal).toContain('req-42');
		expect(journal).toContain('Bash: git push origin main');
	});

	it('wakes a run parked on a deferred question by asking the agent to re-issue that call (#190)', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');

		const prompts: string[] = [];
		const startTurn = vi
			.fn()
			.mockImplementation(async (input: {prompt: string}) => {
				prompts.push(input.prompt);
				fs.writeFileSync(journalPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
				return OK_RESULT;
			});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'Go ahead and push.',
			resumeRunId: 'run-parked',
			parkedInterruption: {
				kind: 'question',
				message:
					'permission request (Bash) unanswered within the grace window (60s); deferred: git push origin main',
				requestId: 'req-42',
				question: 'Bash: git push origin main',
			},
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
		expect(prompts[0]).toContain('Go ahead and push.');
		expect(prompts[0]).toContain('Bash: git push origin main');
		expect(prompts[0]).toContain('Re-issue that exact call');
		// Resumed: the parked Interruption is not carried onto the resumed record.
		expect(result.interruption).toBeUndefined();
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
		const journalPath = path.join(projectDir, '.athena', 's1', 'journal.md');

		// Turn 1: the agent asked its question in chat and never touched the
		// journal. Turn 2 (the nudged resume) declares it properly.
		const prompts: string[] = [];
		const startTurn = vi
			.fn()
			.mockImplementation(async (turnInput: {prompt: string}) => {
				prompts.push(turnInput.prompt);
				if (prompts.length === 2) {
					fs.writeFileSync(
						journalPath,
						'## Status\nNeed the operator.\n<!-- NEEDS_HUMAN: English or French? -->',
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
			'agent declared NEEDS_HUMAN: English or French?',
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

	it('fails fast when a terminal marker is not the final journal line', async () => {
		const projectDir = makeTempDir();
		const journalPath = path.join(projectDir, '.athena', 's1', 'journal.md');

		const startTurn = vi.fn().mockImplementationOnce(async () => {
			fs.writeFileSync(
				journalPath,
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

	it('surfaces a human-readable reason when the journal disappears mid-run', async () => {
		const projectDir = makeTempDir();
		const journalPath = path.join(projectDir, '.athena', 's1', 'journal.md');

		// The agent removes the journal during the turn. The Runner must report a
		// terminal outcome the user can read — never the raw Stop Reason enum.
		const startTurn = vi.fn().mockImplementationOnce(async () => {
			fs.rmSync(journalPath, {force: true});
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
		expect(result.stopReason).not.toContain('missing_journal');
		expect(result.stopReason).toMatch(/journal/i);
		expect(startTurn).toHaveBeenCalledTimes(1);
		expect(persistRunState).toHaveBeenLastCalledWith(
			expect.objectContaining({
				status: 'failed',
				stopReason: expect.stringMatching(/journal/i),
			}),
		);
	});

	it('nudges an undeclared markerless stop by resuming the same Agent Session with a corrective prompt', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');

		const calls: Array<{continuation: unknown; prompt: string}> = [];
		const startTurn = vi
			.fn()
			.mockImplementationOnce(
				async (input: {continuation: unknown; prompt: string}) => {
					calls.push(input);
					fs.writeFileSync(journalPath, 'working', 'utf-8');
					return OK_RESULT;
				},
			)
			.mockImplementationOnce(
				async (input: {continuation: unknown; prompt: string}) => {
					calls.push(input);
					fs.writeFileSync(journalPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
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
		expect(calls[1]!.prompt).toContain('<!-- NEEDS_HUMAN');
	});

	it('suspends after the nudge cap with no journal progress, naming the bound', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');

		// Every Turn stops cleanly without a marker and without touching the
		// journal after the first write — pure unproductive spinning.
		const startTurn = vi.fn().mockImplementation(async () => {
			fs.writeFileSync(journalPath, 'stuck', 'utf-8');
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

	it('resets the nudge cap whenever the journal advances between stops', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');

		// Six markerless stops, each advancing the journal (a checkpointing
		// workflow), then completion. With nudgeCap 2 this must NOT suspend —
		// only unproductive repeated stops escalate.
		let turn = 0;
		const startTurn = vi.fn().mockImplementation(async () => {
			turn++;
			if (turn <= 6) {
				fs.writeFileSync(journalPath, `progress step ${turn}`, 'utf-8');
			} else {
				fs.writeFileSync(journalPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
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
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');

		const continuations: unknown[] = [];
		const startTurn = vi
			.fn()
			.mockImplementationOnce(async (input: {continuation: unknown}) => {
				continuations.push(input.continuation);
				fs.writeFileSync(journalPath, 'working', 'utf-8');
				return OK_RESULT;
			})
			.mockImplementationOnce(async (input: {continuation: unknown}) => {
				continuations.push(input.continuation);
				fs.writeFileSync(journalPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
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
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');

		const calls: Array<{continuation: unknown}> = [];
		const statuses: string[] = [];
		const startTurn = vi
			.fn()
			.mockImplementationOnce(async (input: {continuation: unknown}) => {
				calls.push(input);
				fs.writeFileSync(journalPath, 'working', 'utf-8');
				return {
					...OK_RESULT,
					exitCode: 1,
					error: new Error('API Error: 429 rate_limit_error'),
				};
			})
			.mockImplementationOnce(async (input: {continuation: unknown}) => {
				calls.push(input);
				fs.writeFileSync(journalPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
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
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');

		const startTurn = vi
			.fn()
			.mockImplementationOnce(async () => ({
				...OK_RESULT,
				exitCode: 1,
				streamMessage:
					'API Error: Connection refused — a firewall or proxy may be blocking it (ConnectionRefused)',
			}))
			.mockImplementationOnce(async () => {
				fs.writeFileSync(journalPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
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
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		fs.writeFileSync(path.join(journalDir, 'journal.md'), 'working', 'utf-8');

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
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		fs.writeFileSync(path.join(journalDir, 'journal.md'), 'working', 'utf-8');

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
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		fs.writeFileSync(path.join(journalDir, 'journal.md'), 'working', 'utf-8');

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
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');

		const continuations: unknown[] = [];
		const startTurn = vi
			.fn()
			.mockImplementationOnce(async (input: {continuation: unknown}) => {
				continuations.push(input.continuation);
				fs.writeFileSync(journalPath, 'working', 'utf-8');
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
				fs.writeFileSync(journalPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
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
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');
		// The Handoff chain starts at 001 (ADR 0014 §5).
		const handoffPath = path.join(journalDir, 'handoff', '001.md');

		let pendingHandover: {handle: string} | null = null;
		const forkStates: boolean[] = [];
		const calls: Array<{
			prompt: string;
			continuation: unknown;
			configOverride?: Record<string, unknown>;
			iteration: number;
		}> = [];

		const startTurn = vi
			.fn()
			// Turn 1: interrupted mid-work by the Handover (compaction blocked,
			// process killed) — exits abnormally with a pending request.
			.mockImplementationOnce(async (input: never) => {
				calls.push(input);
				fs.writeFileSync(journalPath, 'deep in work', 'utf-8');
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
				fs.writeFileSync(journalPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
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

		// Every startTurn names the Turn it belongs to (ADR 0018 §8): the fork
		// runs inside the interrupted Turn's iteration; the fresh Turn ticks it.
		expect(calls.map(call => call.iteration)).toEqual([1, 1, 2]);

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

		// The post-Handover Turn is fresh and seeded with Handoff file + Journal.
		expect(calls[2]!.continuation).toEqual({mode: 'fresh'});
		expect(calls[2]!.prompt).toContain('Handover occurred');
		expect(calls[2]!.prompt).toContain(handoffPath);
		expect(calls[2]!.prompt).toContain(journalPath);
		// The post-Handover Turn must fold the Handoff in before domain work (ADR
		// 0015 §8) — only what the Journal lacks, never as an appended note (ADR
		// 0018 §7) — and a Journal under the bound draws no size nudge.
		expect(calls[2]!.prompt.toLowerCase()).toContain('before any domain work');
		expect(calls[2]!.prompt.toLowerCase()).toContain(
			'if it lacks nothing, write nothing',
		);
		expect(calls[2]!.prompt).not.toContain('shedding backstop');
	});

	it('attaches the size nudge to the Handover seed prompt when the Journal is over the shed bound (#212)', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');
		const handoffPath = path.join(journalDir, 'handoff', '001.md');

		let pendingHandover: {handle: string} | null = null;
		const calls: Array<{prompt: string}> = [];
		const startTurn = vi
			.fn()
			.mockImplementationOnce(async (input: {prompt: string}) => {
				calls.push(input);
				// ~10k tokens at the ~4 chars/token estimate: over the 8k bound.
				fs.writeFileSync(journalPath, 'deep in work '.repeat(3_200), 'utf-8');
				pendingHandover = {handle: 'claude-sess-primary'};
				return {...OK_RESULT, exitCode: 143, error: new Error('killed')};
			})
			.mockImplementationOnce(async (input: {prompt: string}) => {
				calls.push(input);
				fs.mkdirSync(path.dirname(handoffPath), {recursive: true});
				fs.writeFileSync(handoffPath, '# Handoff\nwhere things stand', 'utf-8');
				return OK_RESULT;
			})
			.mockImplementationOnce(async (input: {prompt: string}) => {
				calls.push(input);
				fs.writeFileSync(journalPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
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
		expect(calls).toHaveLength(3);
		expect(calls[2]!.prompt).toContain('Handover occurred');
		expect(calls[2]!.prompt).toContain('shedding backstop');
		expect(calls[2]!.prompt).toContain('.athena/s1/journal.md');
	});

	describe('the Handover cap (ADR 0018 §2)', () => {
		/**
		 * A scripted Run: Turn 1 stops cleanly without a marker (the boundary
		 * that records the first Journal hash), then every Turn hands over and
		 * every fork writes the next Handoff file. `journalOnTurn` may rewrite
		 * the Journal before a Turn hands over, making that Handover productive.
		 */
		function scriptedHandoverRun(input: {
			journalOnTurn?: Record<number, string>;
			handoverCap?: number;
			/** The Handoff text each fork writes, by fork index (1-based). */
			handoffOnFork?: (fork: number) => string;
		}) {
			const projectDir = makeTempDir();
			const journalDir = path.join(projectDir, '.athena', 's1');
			fs.mkdirSync(journalDir, {recursive: true});
			const journalPath = path.join(journalDir, 'journal.md');
			let pendingHandover: {handle: string} | null = null;
			let turn = 0;
			let fork = 0;
			const startTurn = vi
				.fn()
				.mockImplementation(async (call: {prompt: string}) => {
					if (call.prompt.includes('handoff skill')) {
						fork += 1;
						const handoffPath = /to (\S+\.md)\./.exec(call.prompt)![1]!;
						fs.mkdirSync(path.dirname(handoffPath), {recursive: true});
						// By default every fork distills something new (no shared
						// 3-gram), so the Journal hash alone carries the verdict.
						fs.writeFileSync(
							handoffPath,
							input.handoffOnFork?.(fork) ??
								`# Handoff ${fork}\n${Array.from({length: 12}, (_, i) => `w${fork}_${i}`).join(' ')}`,
							'utf-8',
						);
						return OK_RESULT;
					}
					turn += 1;
					const rewrite = input.journalOnTurn?.[turn];
					if (rewrite !== undefined)
						fs.writeFileSync(journalPath, rewrite, 'utf-8');
					if (turn === 1) {
						fs.writeFileSync(journalPath, 'plan written', 'utf-8');
						return OK_RESULT;
					}
					if (turn >= 8) {
						fs.writeFileSync(
							journalPath,
							'<!-- WORKFLOW_COMPLETE -->',
							'utf-8',
						);
						return OK_RESULT;
					}
					pendingHandover = {handle: `sess-${turn}`};
					return {...OK_RESULT, exitCode: 143, error: new Error('killed')};
				});
			const snapshots: WorkflowRunSnapshot[] = [];
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
						maxIterations: 50,
						...(input.handoverCap !== undefined
							? {handoverCap: input.handoverCap}
							: {}),
					},
				},
				startTurn,
				persistRunState: snapshot => snapshots.push(snapshot),
				handover: {
					takeRequest: () => {
						const request = pendingHandover;
						pendingHandover = null;
						return request;
					},
				},
			});
			return {handle, startTurn, snapshots, turns: () => turn};
		}

		it('parks after three consecutive Handovers that left the Journal unchanged, naming the bound and marking the wake fresh', async () => {
			const {handle, snapshots, turns} = scriptedHandoverRun({});
			const result = await handle.result;
			expect(result.status).toBe('awaiting_attention');
			expect(result.stopReason).toBe(
				'handover cap reached: 3 consecutive Handovers (handoverCap) without progress — ' +
					'last Handoff 0% similar to the previous; journal unchanged. ' +
					"Raise loop.maxTurnTokenCount, shrink the workflow's baseline context, or shed the journal.",
			);
			// Turn 1 (clean stop) + Turns 2, 3, 4, each handing over: the third
			// unproductive Handover parks before a fifth Turn is seeded.
			expect(turns()).toBe(4);
			const last = deserializeRunMemory(snapshots.at(-1)!.runMemoryJson);
			expect(last?.handoverStreak).toBe(3);
			expect(last?.parkedAfterHandover).toBe(true);
		});

		it('a Handover after which the Journal changed resets the streak, so a Run that keeps working never trips the cap', async () => {
			const {handle, turns} = scriptedHandoverRun({
				// Turn 4 advances the Journal before its Handover: streak 2 → 0.
				journalOnTurn: {4: 'real progress made', 7: 'and more progress'},
			});
			const result = await handle.result;
			expect(result.status).toBe('completed');
			expect(turns()).toBe(8);
		});

		it('near-duplicate Handoffs park the Run even though the Journal changed every Turn, naming the similarity (#211)', async () => {
			const distillation = [
				'# Handoff',
				'## Task and status',
				'Migrate the billing service to the new ledger API; the adapter compiles',
				'and the contract tests still fail on refunds because the ledger rejects',
				'a negative amount, so refunds are modelled as reversal entries.',
				'## Files touched',
				'src/billing/adapter.ts, src/billing/adapter.test.ts, docs/ledger.md',
			].join('\n');
			const {handle, turns} = scriptedHandoverRun({
				// The fold-in mandate rewrites the Journal on every fresh Turn…
				journalOnTurn: {
					2: 'plan written\nHandoff 1 processed',
					3: 'plan written\nHandoff 1 processed\nHandoff 2 processed',
					4: 'plan written\nHandoff 1 processed\nHandoff 2 processed\nHandoff 3 processed',
					5: 'plan written\nHandoff 1 processed\nHandoff 2 processed\nHandoff 3 processed\nHandoff 4 processed',
				},
				// …while every session distills to the same substance.
				handoffOnFork: fork =>
					`${distillation}\nHandover ${fork} of the same substance.`,
			});
			const result = await handle.result;
			expect(result.status).toBe('awaiting_attention');
			expect(result.stopReason).toMatch(
				/^handover cap reached: 3 consecutive Handovers \(handoverCap\) without progress — last Handoff \d+% similar to the previous; journal changed\./,
			);
			// Handover 1 has no predecessor (judged on the hash: changed, so
			// productive); Handovers 2, 3 and 4 are near-duplicates: park after
			// the fourth, before a sixth Turn is seeded.
			expect(turns()).toBe(5);
		});

		it('loop.handoverCap overrides the default', async () => {
			const {handle, turns} = scriptedHandoverRun({handoverCap: 1});
			const result = await handle.result;
			expect(result.status).toBe('awaiting_attention');
			expect(result.stopReason).toMatch(
				/^handover cap reached: 1 consecutive Handover \(handoverCap\)/,
			);
			expect(turns()).toBe(2);
		});
	});

	it('records the Handoff file size on the run snapshot once the fork writes it', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');
		const handoffPath = path.join(journalDir, 'handoff', '001.md');
		const handoffBody = '# Handoff\nwhere things stand';

		let pendingHandover: {handle: string} | null = null;
		const startTurn = vi
			.fn()
			.mockImplementationOnce(async () => {
				fs.writeFileSync(journalPath, 'deep in work', 'utf-8');
				pendingHandover = {handle: 'claude-sess-primary'};
				return {...OK_RESULT, exitCode: 143, error: new Error('killed')};
			})
			.mockImplementationOnce(async () => {
				fs.mkdirSync(path.dirname(handoffPath), {recursive: true});
				fs.writeFileSync(handoffPath, handoffBody, 'utf-8');
				return OK_RESULT;
			})
			.mockImplementationOnce(async () => {
				fs.writeFileSync(journalPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
				return OK_RESULT;
			});

		const snapshots: WorkflowRunSnapshot[] = [];
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
			persistRunState: snapshot => snapshots.push(snapshot),
			handover: {
				takeRequest: () => {
					const request = pendingHandover;
					pendingHandover = null;
					return request;
				},
				onForkStateChange: () => {},
			},
		});

		await handle.result;

		// Some snapshot taken after the fork must carry the Handoff's byte size.
		const memories = snapshots
			.map(s =>
				s.runMemoryJson ? deserializeRunMemory(s.runMemoryJson) : null,
			)
			.filter(m => m !== null);
		const sawHandoffSize = memories.some(
			m => m!.lastHandoffSizeBytes === Buffer.byteLength(handoffBody, 'utf-8'),
		);
		expect(sawHandoffSize).toBe(true);
	});

	it('keeps prior Handoff files: each Handover writes the next numbered file', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');
		const handoffDir = path.join(journalDir, 'handoff');

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
				fs.writeFileSync(journalPath, 'work in progress', 'utf-8');
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
				fs.writeFileSync(journalPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
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
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');
		const handoffDir = path.join(journalDir, 'handoff');

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
					fs.writeFileSync(journalPath, `work ${handovers}`, 'utf-8');
					pendingHandover = {handle: `sess-${handovers}`};
					return {...OK_RESULT, exitCode: 143, error: new Error('killed')};
				}
				fs.writeFileSync(journalPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
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
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');

		let pendingHandover: {handle: string} | null = null;
		const degraded: string[] = [];
		const calls: Array<{continuation: unknown}> = [];

		const startTurn = vi
			.fn()
			.mockImplementationOnce(async (input: never) => {
				calls.push(input);
				fs.writeFileSync(journalPath, 'working', 'utf-8');
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
				fs.writeFileSync(journalPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
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

	it('retries a transient fork failure once with backoff before completing the Handover', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');

		let pendingHandover: {handle: string} | null = null;
		const degraded: string[] = [];
		const calls: Array<{continuation: unknown}> = [];

		const startTurn = vi
			.fn()
			.mockImplementationOnce(async (input: never) => {
				calls.push(input);
				fs.writeFileSync(journalPath, 'working', 'utf-8');
				pendingHandover = {handle: 'claude-sess-primary'};
				return {...OK_RESULT, exitCode: 143, error: new Error('killed')};
			})
			// First fork attempt: a transient infra failure — no Handoff file
			// written, so it must retry rather than degrade immediately.
			.mockImplementationOnce(async (input: never) => {
				calls.push(input);
				return {
					...OK_RESULT,
					exitCode: 1,
					error: new Error('API Error: 503 Service Unavailable'),
				};
			})
			// The retried fork attempt succeeds.
			.mockImplementationOnce(async (input: {prompt: string}) => {
				calls.push(input as never);
				const named = /(\S*handoff\S*\.md)/.exec(input.prompt);
				if (!named)
					throw new Error(`no Handoff path in prompt: ${input.prompt}`);
				fs.mkdirSync(path.dirname(named[1]!), {recursive: true});
				fs.writeFileSync(named[1]!, '# Handoff', 'utf-8');
				return OK_RESULT;
			})
			// The post-Handover Turn completes the workflow.
			.mockImplementationOnce(async (input: never) => {
				calls.push(input);
				fs.writeFileSync(journalPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
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
		// The retry succeeded — the Handover never degraded to in-place vendor
		// compaction.
		expect(degraded).toEqual([]);
		// Turn 1, the failed fork, the retried fork, the post-Handover Turn.
		expect(startTurn).toHaveBeenCalledTimes(4);
		// Turn 1 (interrupted) + post-Handover Turn tick; neither fork attempt
		// does.
		expect(result.iterations).toBe(2);
	});

	it('frames the human reply with wake context on the first Turn of a woken run', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');

		const prompts: string[] = [];
		const startTurn = vi
			.fn()
			.mockImplementation(async (input: {prompt: string}) => {
				prompts.push(input.prompt);
				fs.writeFileSync(journalPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
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
		// journal, and demands the protocol bookkeeping even on a degraded
		// fresh session.
		expect(prompts[0]).toContain('suspended awaiting a human');
		expect(prompts[0]).toContain('French, please.');
		expect(prompts[0]).toContain('journal');
		expect(prompts[0]).toContain('terminal marker');
	});

	it('wakes from resumedRunMemory: carries the iteration budget across the wake and seeds the wake prompt', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');
		fs.writeFileSync(
			journalPath,
			'# Workflow Journal\n\nstuck on a question\n',
			'utf-8',
		);

		const prompts: string[] = [];
		const continuations: unknown[] = [];
		const startTurn = vi
			.fn()
			.mockImplementation(
				async (input: {prompt: string; continuation: unknown}) => {
					prompts.push(input.prompt);
					continuations.push(input.continuation);
					fs.writeFileSync(journalPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
					return OK_RESULT;
				},
			);

		// A Run suspended at iteration 7 (ADR 0016 §2/§6) — the wake must
		// continue that budget, not restart it at 1.
		const resumedRunMemory: RunMemory = {
			iteration: 7,
			nudgeStreak: 3,
			retryStreak: 1,
			lastJournalHash: 'deadbeef',
			lastStopPrompt: 'the stale pre-wake prompt',
			lastStopContinuation: {mode: 'fresh'},
			pendingSteers: [],
			lastHandoffSizeBytes: null,
			parkedAfterHandover: false,
		};

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'the human reply',
			resumeRunId: 'run-suspended',
			resumedRunMemory,
			resumedStopReason:
				'nudge cap reached: 2 nudges (nudgeCap) without journal progress or a terminal marker',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 20},
			},
			startTurn,
			persistRunState: vi.fn(),
		});

		const result = await handle.result;
		expect(result.status).toBe('completed');
		// The wake ticks the iteration once from the rehydrated budget — a
		// Run-wide ceiling across wakes, not restarted at 1.
		expect(result.iterations).toBe(8);
		expect(startTurn).toHaveBeenCalledTimes(1);
		expect(continuations[0]).toEqual({mode: 'fresh'});
		expect(prompts[0]).toContain('suspended awaiting a human');
		expect(prompts[0]).toContain('the human reply');
		// Not the stale pre-wake prompt the suspended Run last attempted — the
		// replay invariant (ADR 0016 §3) never replays it on a wake.
		expect(prompts[0]).not.toContain('the stale pre-wake prompt');
	});

	it('wakes a Run parked after a Handover fresh, naming the newest Handoff file (ADR 0018 §9)', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		const handoffDir = path.join(journalDir, 'handoff');
		fs.mkdirSync(handoffDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');
		fs.writeFileSync(journalPath, 'parked at the bound\n', 'utf-8');
		fs.writeFileSync(path.join(handoffDir, '002.md'), 'older', 'utf-8');
		fs.writeFileSync(path.join(handoffDir, '003.md'), 'newest', 'utf-8');

		const calls: Array<{prompt: string; continuation: unknown}> = [];
		const startTurn = vi
			.fn()
			.mockImplementation(
				async (input: {prompt: string; continuation: unknown}) => {
					calls.push(input);
					fs.writeFileSync(journalPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
					return OK_RESULT;
				},
			);

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'the human reply',
			resumeRunId: 'run-suspended',
			// The caller resolved the persisted session — the one at its bound.
			initialContinuation: {mode: 'resume', handle: 'claude-sess-at-bound'},
			resumedRunMemory: {
				iteration: 3,
				nudgeStreak: 0,
				retryStreak: 0,
				lastJournalHash: null,
				lastStopPrompt: 'the stale pre-wake prompt',
				lastStopContinuation: {mode: 'fresh'},
				pendingSteers: [],
				lastHandoffSizeBytes: 6,
				parkedAfterHandover: true,
			},
			resumedStopReason:
				'iteration ceiling reached: 3 iterations (maxIterations) used without a terminal marker',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 20},
			},
			startTurn,
			persistRunState: vi.fn(),
		});

		const result = await handle.result;
		expect(result.status).toBe('completed');
		expect(startTurn).toHaveBeenCalledTimes(1);
		expect(calls[0]!.continuation).toEqual({mode: 'fresh'});
		expect(calls[0]!.prompt).toContain('the human reply');
		expect(calls[0]!.prompt).toContain(path.join(handoffDir, '003.md'));
		expect(calls[0]!.prompt).not.toContain(path.join(handoffDir, '002.md'));
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

	it('records each Workflow Run goal when the Journal already exists', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');
		// A prior Workflow Run in the same Athena Session left this behind.
		fs.writeFileSync(
			journalPath,
			'# Workflow Journal\n\nprior run work\n',
			'utf-8',
		);

		const startTurn = vi.fn().mockImplementation(async () => {
			fs.appendFileSync(journalPath, '\n<!-- WORKFLOW_COMPLETE -->\n', 'utf-8');
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

		const journal = fs.readFileSync(journalPath, 'utf-8');
		// The new Run's goal is on the Journal, and the prior Run's work survives.
		expect(journal).toContain('the second goal');
		expect(journal).toContain('prior run work');
	});

	it('does not inherit a prior Run terminal marker', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');
		// The prior Run finished and left its completion marker as the last line.
		fs.writeFileSync(
			journalPath,
			'# Workflow Journal\n\nprior run work\n\n<!-- WORKFLOW_COMPLETE -->\n',
			'utf-8',
		);

		// Turn 1 does real work but declares nothing; Turn 2 completes.
		const startTurn = vi
			.fn()
			.mockImplementationOnce(async () => {
				fs.appendFileSync(journalPath, '\nworking on the new goal\n', 'utf-8');
				return OK_RESULT;
			})
			.mockImplementationOnce(async () => {
				fs.appendFileSync(
					journalPath,
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
			.readFileSync(journalPath, 'utf-8')
			.split('the second goal')[0]!;
		expect(afterBanner).not.toContain('<!-- WORKFLOW_COMPLETE -->');
		expect(afterBanner).toContain('Prior Run ended');
	});

	it('does not open a new Run section when waking a suspended Run', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');
		fs.writeFileSync(
			journalPath,
			'# Workflow Journal\n\nmid-run work\n',
			'utf-8',
		);

		const startTurn = vi.fn().mockImplementation(async () => {
			fs.appendFileSync(journalPath, '\n<!-- WORKFLOW_COMPLETE -->\n', 'utf-8');
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
		expect(fs.readFileSync(journalPath, 'utf-8')).not.toContain(
			'New Workflow Run',
		);
	});

	it('uses injected createJournal instead of fs', async () => {
		const createJournal = vi.fn();
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
			createJournal,
		});

		await handle.result;
		expect(createJournal).toHaveBeenCalledTimes(1);
		expect(createJournal.mock.calls[0][0]).toContain('.athena/s1/journal.md');
		expect(createJournal.mock.calls[0][1]).toContain(JOURNAL_SKELETON_MARKER);
	});
});

describe('createWorkflowRunner — steering (#191)', () => {
	const LOOPED = {
		name: 'wf',
		plugins: [],
		promptTemplate: '{input}',
		loop: {enabled: true, maxIterations: 5},
	};

	it('holds a mid-Turn steer for the boundary and delivers it at the head of the next Turn', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');

		const prompts: string[] = [];
		let journalSeenByTurn2 = '';
		let releaseFirstTurn: (() => void) | null = null;
		const startTurn = vi
			.fn()
			.mockImplementation(async (input: {prompt: string}) => {
				prompts.push(input.prompt);
				if (prompts.length === 1) {
					await new Promise<void>(resolve => {
						releaseFirstTurn = resolve;
					});
					fs.writeFileSync(journalPath, 'turn 1 progress', 'utf-8');
					return OK_RESULT;
				}
				journalSeenByTurn2 = fs.readFileSync(journalPath, 'utf-8');
				fs.writeFileSync(journalPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
				return OK_RESULT;
			});
		const delivered: unknown[] = [];
		const persistRunState = vi.fn();

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: LOOPED,
			startTurn,
			persistRunState,
			onSteerDelivered: steers => delivered.push(...steers),
		});

		// Wait for Turn 1 to be in flight, then steer it.
		await vi.waitFor(() => expect(releaseFirstTurn).not.toBeNull());
		expect(
			handle.steer({
				text: 'use the other branch',
				origin: 'hub',
				receivedAt: 5,
			}),
		).toBe(true);
		// Queued, not injected: Turn 1 is still the only Turn, and the queued
		// steer is already on the persisted snapshot.
		expect(startTurn).toHaveBeenCalledTimes(1);
		expect(persistRunState).toHaveBeenLastCalledWith(
			expect.objectContaining({
				runMemoryJson: expect.stringContaining('use the other branch'),
			}),
		);
		releaseFirstTurn!();

		const result = await handle.result;
		expect(result.status).toBe('completed');
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).not.toContain('use the other branch');
		expect(prompts[1]!.startsWith(STEER_BLOCK_OPEN)).toBe(true);
		expect(prompts[1]).toContain('via hub');
		expect(prompts[1]).toContain('use the other branch');
		expect(prompts[1]!.indexOf(STEER_BLOCK_END)).toBeLessThan(
			prompts[1]!.indexOf('journal'),
		);
		expect(delivered).toEqual([
			{
				text: 'use the other branch',
				origin: 'hub',
				receivedAt: 5,
				iteration: 2,
			},
		]);
		// The Journal records the steer — origin and the Turn it went into —
		// before that Turn starts, so Turn 2 reads it alongside Turn 1's work.
		expect(journalSeenByTurn2).toContain('turn 1 progress');
		expect(journalSeenByTurn2).toContain('Human steer (via hub)');
		expect(journalSeenByTurn2).toContain('delivered into Turn 2');
		expect(journalSeenByTurn2).toContain('> use the other branch');
	});

	it('delivers a steer queued before the Run starts at the head of the first Turn', async () => {
		const projectDir = makeTempDir();
		const journalPath = path.join(projectDir, '.athena', 's1', 'journal.md');
		const prompts: string[] = [];
		const startTurn = vi
			.fn()
			.mockImplementation(async (input: {prompt: string}) => {
				prompts.push(input.prompt);
				fs.writeFileSync(journalPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
				return OK_RESULT;
			});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: LOOPED,
			startTurn,
			persistRunState: vi.fn(),
		});
		handle.steer({text: 'first', origin: 'local', receivedAt: 1});
		handle.steer({text: 'second', origin: 'hub', receivedAt: 2});

		await handle.result;
		expect(prompts).toHaveLength(1);
		expect(prompts[0]!.startsWith(STEER_BLOCK_OPEN)).toBe(true);
		expect(prompts[0]).toContain('1 of 2, via local');
		expect(prompts[0]).toContain('2 of 2, via hub');
		expect(prompts[0]!.indexOf('first')).toBeLessThan(
			prompts[0]!.indexOf('second'),
		);
		expect(prompts[0]!.endsWith('do it')).toBe(true);
	});

	it('on a wake, records the steer above the answered NEEDS_HUMAN marker so the Journal stays well-formed', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');
		fs.writeFileSync(
			journalPath,
			'# Journal\n\nasked which env\n\n<!-- NEEDS_HUMAN: which env? -->\n',
			'utf-8',
		);

		let journalSeenByTurn = '';
		const prompts: string[] = [];
		const startTurn = vi
			.fn()
			.mockImplementation(async (input: {prompt: string}) => {
				prompts.push(input.prompt);
				journalSeenByTurn = fs.readFileSync(journalPath, 'utf-8');
				fs.writeFileSync(journalPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
				return OK_RESULT;
			});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'staging',
			resumeRunId: 'run-suspended',
			workflow: LOOPED,
			startTurn,
			persistRunState: vi.fn(),
		});
		handle.steer({text: 'and be quick', origin: 'local', receivedAt: 9});

		const result = await handle.result;
		expect(result.status).toBe('completed');
		expect(prompts[0]!.startsWith(STEER_BLOCK_OPEN)).toBe(true);
		expect(prompts[0]).toContain('suspended awaiting a human');
		expect(prompts[0]).toContain('staging');
		// Recorded before the Turn started, above the marker, marker still last.
		expect(journalSeenByTurn).toContain('Human steer (via local)');
		expect(journalSeenByTurn).toContain('delivered into Turn 1');
		expect(
			journalSeenByTurn.trimEnd().endsWith('<!-- NEEDS_HUMAN: which env? -->'),
		).toBe(true);
	});

	it('rejects a steer once the Run has ended', async () => {
		const startTurn = vi.fn().mockResolvedValue(OK_RESULT);
		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir: makeTempDir(),
			prompt: 'do it',
			startTurn,
			persistRunState: vi.fn(),
		});
		await handle.result;
		expect(handle.steer({text: 'late', origin: 'hub', receivedAt: 1})).toBe(
			false,
		);
		expect(startTurn).toHaveBeenCalledTimes(1);
	});
});

describe('createWorkflowRunner phase events', () => {
	const LOOPED_WORKFLOW = {
		name: 'wf',
		plugins: [],
		promptTemplate: '{input}',
		loop: {enabled: true, maxIterations: 5},
	};

	function journalWith(block: string[], ...tail: string[]): string {
		return [
			'# Journal',
			'## Status',
			'Working.',
			'<!-- TURN_PROTOCOL',
			...block,
			'-->',
			...tail,
		].join('\n');
	}

	it('emits one phase change when a Turn names a new step and none while the step stays the same', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');
		const onPhaseChange = vi.fn();
		const onWarning = vi.fn();

		const startTurn = vi
			.fn()
			.mockImplementationOnce(async () => {
				fs.writeFileSync(
					journalPath,
					journalWith(['step: Orient', 'step_index: 1', 'step_total: 3']),
					'utf-8',
				);
				return OK_RESULT;
			})
			.mockImplementationOnce(async () => {
				fs.writeFileSync(
					journalPath,
					journalWith(
						['step: Orient', 'step_index: 1', 'step_total: 3'],
						'More notes.',
					),
					'utf-8',
				);
				return OK_RESULT;
			})
			.mockImplementationOnce(async () => {
				fs.writeFileSync(
					journalPath,
					journalWith(
						['step: Build', 'step_index: 2', 'step_total: 3'],
						'<!-- WORKFLOW_COMPLETE -->',
					),
					'utf-8',
				);
				return OK_RESULT;
			});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: LOOPED_WORKFLOW,
			startTurn,
			persistRunState: vi.fn(),
			onPhaseChange,
			onWarning,
		});

		const result = await handle.result;
		expect(result.status).toBe('completed');
		expect(startTurn).toHaveBeenCalledTimes(3);
		expect(onWarning).not.toHaveBeenCalled();
		expect(onPhaseChange.mock.calls.map(call => call[0])).toEqual([
			{
				runId: handle.runId,
				turn: 1,
				step: 'Orient',
				stepIndex: 1,
				stepTotal: 3,
			},
			{
				runId: handle.runId,
				turn: 3,
				step: 'Build',
				stepIndex: 2,
				stepTotal: 3,
			},
		]);
	});

	it('ignores a malformed block with one warning and keeps the Run going', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');
		const onPhaseChange = vi.fn();
		const onWarning = vi.fn();

		const startTurn = vi
			.fn()
			.mockImplementationOnce(async () => {
				fs.writeFileSync(journalPath, journalWith(['step_index: 2']), 'utf-8');
				return OK_RESULT;
			})
			.mockImplementationOnce(async () => {
				fs.writeFileSync(
					journalPath,
					journalWith(['step_index: 2'], '<!-- WORKFLOW_COMPLETE -->'),
					'utf-8',
				);
				return OK_RESULT;
			});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: LOOPED_WORKFLOW,
			startTurn,
			persistRunState: vi.fn(),
			onPhaseChange,
			onWarning,
		});

		const result = await handle.result;
		expect(result.status).toBe('completed');
		expect(startTurn).toHaveBeenCalledTimes(2);
		expect(onPhaseChange).not.toHaveBeenCalled();
		expect(onWarning).toHaveBeenCalledTimes(1);
		expect(onWarning.mock.calls[0]![0]).toMatch(/TURN_PROTOCOL/);
	});

	it('emits no phase and no warning for a journal without a block', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(journalDir, {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');
		const onPhaseChange = vi.fn();
		const onWarning = vi.fn();

		const startTurn = vi.fn().mockImplementationOnce(async () => {
			fs.writeFileSync(
				journalPath,
				'## Plan\n- [x] done\n<!-- WORKFLOW_COMPLETE -->',
				'utf-8',
			);
			return OK_RESULT;
		});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: LOOPED_WORKFLOW,
			startTurn,
			persistRunState: vi.fn(),
			onPhaseChange,
			onWarning,
		});

		await handle.result;
		expect(onPhaseChange).not.toHaveBeenCalled();
		expect(onWarning).not.toHaveBeenCalled();
	});

	it('projects the journal unit table into the task tools after each Turn (ADR 0015 §7)', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(path.join(journalDir, 'units'), {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');
		fs.writeFileSync(
			path.join(journalDir, 'units', 'first-unit.md'),
			['---', 'status: closed', '---', '', 'Done.'].join('\n'),
		);

		const startTurn = vi.fn().mockImplementationOnce(async () => {
			fs.writeFileSync(
				journalPath,
				[
					'# Workflow Journal',
					'',
					'## Units',
					'',
					'| Unit | Record |',
					'| --- | --- |',
					'| First unit | units/first-unit.md |',
					'',
					'<!-- WORKFLOW_COMPLETE -->',
				].join('\n'),
				'utf-8',
			);
			return OK_RESULT;
		});

		const projected: JournalTaskProjection[][] = [];
		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 3},
			},
			startTurn,
			persistRunState: vi.fn(),
			projectTasks: tasks => projected.push(tasks),
		});

		await handle.result;

		expect(projected.length).toBeGreaterThan(0);
		expect(projected[projected.length - 1]).toEqual([
			{taskId: 'first-unit', content: 'First unit', status: 'completed'},
		]);
	});

	it('never fails a Turn when the journal has no unit table to project (parse miss degrades silently)', async () => {
		const projectDir = makeTempDir();
		const startTurn = vi.fn().mockResolvedValue(OK_RESULT);
		const projectTasks = vi.fn();

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			startTurn,
			persistRunState: vi.fn(),
			projectTasks,
		});

		const result = await handle.result;
		expect(result.status).toBe('completed');
		expect(projectTasks).not.toHaveBeenCalled();
	});

	it('never fails a Turn when the projectTasks callback itself throws', async () => {
		const projectDir = makeTempDir();
		const journalDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(path.join(journalDir, 'units'), {recursive: true});
		const journalPath = path.join(journalDir, 'journal.md');
		fs.writeFileSync(
			path.join(journalDir, 'units', 'u.md'),
			['---', 'status: open', '---', ''].join('\n'),
		);

		const startTurn = vi.fn().mockImplementationOnce(async () => {
			fs.writeFileSync(
				journalPath,
				[
					'## Units',
					'| Unit | Record |',
					'| --- | --- |',
					'| Unit | units/u.md |',
					'<!-- WORKFLOW_COMPLETE -->',
				].join('\n'),
				'utf-8',
			);
			return OK_RESULT;
		});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			startTurn,
			persistRunState: vi.fn(),
			projectTasks: () => {
				throw new Error('boom');
			},
		});

		const result = await handle.result;
		expect(result.status).toBe('completed');
	});
});
