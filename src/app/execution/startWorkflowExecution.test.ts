import {describe, it, expect, vi} from 'vitest';
import {startWorkflowExecution} from './startWorkflowExecution';
import type {RuntimeEventHandler} from '../../core/runtime/types';
import type {TurnExecutionResult} from '../../core/runtime/process';
import type {TokenUsage} from '../../shared/types/headerMetrics';

const tokens: TokenUsage = {
	input: null,
	output: null,
	cacheRead: null,
	cacheWrite: null,
	total: null,
	contextSize: null,
	contextWindowSize: null,
};
const ok: TurnExecutionResult = {
	exitCode: 0,
	error: null,
	tokens,
	streamMessage: null,
};

describe.each(['claude-code', 'openai-codex'] as const)(
	'%s shared execution lifecycle',
	harness => {
		it('subscribes before the first turn and releases after completion', async () => {
			const handlers = new Set<RuntimeEventHandler>();
			const unsubscribe = vi.fn();
			const runtime = {
				onEvent: (handler: RuntimeEventHandler) => {
					handlers.add(handler);
					return () => {
						handlers.delete(handler);
						unsubscribe();
					};
				},
			};
			const handle = startWorkflowExecution(
				{
					projectDir: '.',
					sessionId: 'session',
					harness,
					prompt: 'work',
					persistRunState: vi.fn(),
					startTurn: async () => {
						expect(handlers.size).toBe(1);
						return ok;
					},
				},
				{runtime: runtime as never},
			);
			expect(await handle.result).toMatchObject({status: 'completed'});
			await handle.dispose();
			await handle.dispose();
			expect(handlers.size).toBe(0);
			expect(unsubscribe).toHaveBeenCalledTimes(1);
		});
		it('waits for cancellation settlement and aborts only once', async () => {
			let finish!: (value: TurnExecutionResult) => void;
			const turn = new Promise<TurnExecutionResult>(resolve => {
				finish = resolve;
			});
			const abort = vi.fn(() =>
				finish({...ok, exitCode: null, error: new Error('stopped')}),
			);
			let notifyStarted!: () => void;
			const started = new Promise<void>(resolve => {
				notifyStarted = resolve;
			});
			const handle = startWorkflowExecution({
				projectDir: '.',
				sessionId: 'session',
				harness,
				prompt: 'work',
				persistRunState: vi.fn(),
				startTurn: () => {
					notifyStarted();
					return turn;
				},
				abortCurrentTurn: abort,
			});
			await started;
			const first = handle.stop();
			const second = handle.stop();
			expect(await first).toMatchObject({status: 'cancelled'});
			await second;
			await handle.dispose();
			expect(abort).toHaveBeenCalledTimes(1);
		});
		it('rejects a foreign parked run before starting a vendor conversation', () => {
			const startTurn = vi.fn();
			expect(() =>
				startWorkflowExecution(
					{
						projectDir: '.',
						sessionId: 'session',
						harness,
						prompt: 'work',
						resumeRunId: 'foreign',
						startTurn,
						persistRunState: vi.fn(),
					},
					{store: {getLatestRun: () => null}},
				),
			).toThrow('current parked');
			expect(startTurn).not.toHaveBeenCalled();
		});
	},
);

it.each(['claude-code', 'openai-codex'] as const)(
	'preserves the same parked Run and turn count across a %s wake',
	async harness => {
		const fs = await import('node:fs');
		const os = await import('node:os');
		const path = await import('node:path');
		const {createSessionStore} = await import('../../infra/sessions/store');
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drisp-wake-'));
		const store = createSessionStore({
			sessionId: 's',
			projectDir,
			dbPath: path.join(projectDir, 'session.db'),
		});
		const workflow = {
			name: 'original',
			plugins: [],
			promptTemplate: '{input}',
			loop: {enabled: true, maxIterations: 5},
		};
		const journal = path.join(projectDir, '.athena', 's', 'journal.md');
		try {
			const parked = startWorkflowExecution(
				{
					projectDir,
					sessionId: 's',
					harness,
					workflow,
					prompt: 'work',
					persistRunState: state => store.persistRun(state),
					startTurn: async () => {
						fs.writeFileSync(journal, '<!-- NEEDS_HUMAN: confirm -->');
						return ok;
					},
				},
				{store},
			);
			expect(await parked.result).toMatchObject({
				status: 'awaiting_attention',
				iterations: 1,
			});
			expect(store.getLatestRun()?.executionIdentityJson).toBeTruthy();
			expect(() =>
				startWorkflowExecution(
					{
						projectDir,
						sessionId: 's',
						harness,
						workflow: {...workflow, name: 'different'},
						prompt: 'reply',
						resumeRunId: parked.runId,
						startTurn: async () => ok,
						persistRunState: state => store.persistRun(state),
					},
					{store},
				),
			).toThrow('Cannot continue');
			const resumed = startWorkflowExecution(
				{
					projectDir,
					sessionId: 's',
					harness,
					workflow,
					prompt: 'confirmed',
					resumeRunId: parked.runId,
					persistRunState: state => store.persistRun(state),
					startTurn: async () => {
						fs.writeFileSync(journal, '<!-- WORKFLOW_COMPLETE -->');
						return ok;
					},
				},
				{store},
			);
			expect(await resumed.result).toMatchObject({
				runId: parked.runId,
				status: 'completed',
				iterations: 2,
			});
		} finally {
			store.close();
			fs.rmSync(projectDir, {recursive: true, force: true});
		}
	},
);
