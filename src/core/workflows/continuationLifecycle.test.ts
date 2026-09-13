import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createWorkflowRunner, type WorkflowRunnerInput} from './workflowRunner';
import {
	createInitialRun,
	step,
	deserializeRunMemory,
	type StepConfig,
	type RunMemory,
} from './runMachine';
import {readRestartContract} from './restartContract';
import type {TurnExecutionResult} from '../runtime/process';

const usage = (total: number) => ({
	input: total,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total,
	contextSize: null,
	contextWindowSize: null,
});
const ok: TurnExecutionResult = {
	exitCode: 0,
	error: null,
	tokens: usage(0),
	streamMessage: null,
};
const dirs: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const dir of dirs.splice(0))
		fs.rmSync(dir, {recursive: true, force: true});
});
function setup(overrides: Partial<WorkflowRunnerInput> = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-'));
	dirs.push(dir);
	const persistRunState = vi.fn();
	const input: WorkflowRunnerInput = {
		projectDir: dir,
		sessionId: 's',
		prompt: 'finish',
		persistRunState,
		workflow: {
			name: 'wf',
			plugins: [],
			promptTemplate: '{input}',
			loop: {enabled: true, maxIterations: 20},
		},
		startTurn: async () => ok,
		...overrides,
	};
	return {
		input,
		persistRunState,
		journal: path.join(dir, '.athena/s/journal.md'),
	};
}
function cfg(): StepConfig {
	const loop = {enabled: true, maxIterations: 20};
	return {
		initialPrompt: 'continue',
		loop,
		journalAbsPath: '/journal.md',
		contextKey: 'current',
		workflowState: {
			workflow: {name: 'wf', plugins: [], promptTemplate: '{input}', loop},
			warnings: [],
			journalPathForPrompt: '/journal.md',
			workflowOverride: undefined,
		},
	};
}
function memory(): RunMemory {
	return createInitialRun(cfg(), {waking: false}).memory;
}
describe('continuation lifecycle', () => {
	it('bounds shutdown waiting when a live Turn never settles', async () => {
		vi.useFakeTimers();
		const abortCurrentTurn = vi.fn();
		const {input, persistRunState} = setup({abortCurrentTurn});
		input.workflow!.loop!.maxRunTokens = 100;
		input.startTurn = vi.fn(async ({onUsage}) => {
			onUsage?.(usage(101));
			return await new Promise<TurnExecutionResult>(() => {});
		});
		const pending = createWorkflowRunner(input).result;
		await vi.advanceTimersByTimeAsync(6001);
		const result = await pending;
		expect(result.status).toBe('awaiting_attention');
		expect(result.interruption).toMatchObject({
			resource: {cause: 'tokens', used: 101},
		});
		expect(abortCurrentTurn).toHaveBeenCalledOnce();
		expect(
			deserializeRunMemory(persistRunState.mock.lastCall![0].runMemoryJson)
				?.cumulativeTokens,
		).toBe(101);
	});
	it('does not double-count streamed and final usage', async () => {
		const {input, journal} = setup();
		input.startTurn = async ({onUsage}) => {
			onUsage?.(usage(50));
			onUsage?.(usage(100));
			onUsage?.(usage(100));
			fs.writeFileSync(journal, '<!-- WORKFLOW_COMPLETE -->');
			return {...ok, tokens: usage(100)};
		};
		expect((await createWorkflowRunner(input).result).tokens.total).toBe(100);
	});
	it('a wake keeps the exhausted lifetime budget and sends no request', async () => {
		const startTurn = vi.fn(async () => ok);
		const {input} = setup({
			startTurn,
			resumeRunId: 'existing',
			resumedRunMemory: {
				...memory(),
				cumulativeTokens: 100,
			},
		});
		input.workflow!.loop!.maxRunTokens = 100;
		const result = await createWorkflowRunner(input).result;
		expect(result.status).toBe('awaiting_attention');
		expect(startTurn).not.toHaveBeenCalled();
		expect(result.tokens.total).toBe(100);
	});
	it('a budget increase admits wake without resetting earlier spend', async () => {
		const {input, journal} = setup({
			resumeRunId: 'existing',
			resumedRunMemory: {
				...memory(),
				cumulativeTokens: 100,
			},
		});
		input.workflow!.loop!.maxRunTokens = 200;
		input.startTurn = async () => {
			fs.writeFileSync(journal, '<!-- WORKFLOW_COMPLETE -->');
			return {...ok, tokens: usage(25)};
		};
		const result = await createWorkflowRunner(input).result;
		expect(result.status).toBe('completed');
		expect(result.tokens.total).toBe(125);
	});
});

it('checks opening feasibility once instead of penalizing later Journal growth', async () => {
	const {input, journal} = setup();
	input.workflow!.loop!.maxTurnTokenCount = 100000;
	input.startTurn = async ({onUsage}) => {
		onUsage?.({...usage(100), openingContextSize: 50000});
		fs.writeFileSync(journal, 'large evidence '.repeat(20000));
		onUsage?.({...usage(200), openingContextSize: 50000});
		fs.writeFileSync(journal, '<!-- WORKFLOW_COMPLETE -->');
		return {...ok, tokens: usage(200)};
	};
	expect((await createWorkflowRunner(input).result).status).toBe('completed');
});

function checkpoint(runId: string, action = 'verify changes') {
	return `## Restart\nRun: ${runId}\nObjective: ship\nNext action: ${action}\nConstraints: preserve user changes\nChanges: implementation ready\nOpen questions: none\nReferences: tests.md\n\n## History\n${'cold history '.repeat(10000)}`;
}

it('restarts directly from the Journal without an extra harness call or full-history ingest', async () => {
	const {input, journal} = setup({resumeRunId: 'current'});
	let request = true;
	input.handover = {
		takeRequest: () => {
			if (!request) return null;
			request = false;
			return {handle: 'old'};
		},
	};
	const prompts: string[] = [];
	input.startTurn = vi.fn(async turn => {
		prompts.push(turn.prompt);
		if (prompts.length === 1) fs.writeFileSync(journal, checkpoint('current'));
		else {
			expect(turn.continuation).toEqual({mode: 'fresh'});
			fs.writeFileSync(journal, '<!-- WORKFLOW_COMPLETE -->');
		}
		return {...ok, tokens: usage(50)};
	});
	const result = await createWorkflowRunner(input).result;
	expect(result.status).toBe('completed');
	expect(input.startTurn).toHaveBeenCalledTimes(2);
	expect(result.tokens.total).toBe(100);
	expect(prompts[1]).toContain('Constraints: preserve user changes');
	expect(prompts[1]).not.toContain('cold history');
	expect(fs.existsSync(path.join(path.dirname(journal), 'handoff'))).toBe(
		false,
	);
});

it.each(['missing', 'wrong run', 'unchanged'])(
	'parks a %s checkpoint without a recovery invocation',
	async kind => {
		const {input, journal} = setup({resumeRunId: 'current'});
		input.handover = {takeRequest: () => ({handle: 'old'})};
		input.startTurn = vi.fn(async () => {
			if (kind !== 'missing')
				fs.writeFileSync(
					journal,
					checkpoint(kind === 'wrong run' ? 'other' : 'current'),
				);
			return ok;
		});
		const result = await createWorkflowRunner(input).result;
		expect(result.status).toBe('awaiting_attention');
		expect(result.interruption).toMatchObject({
			resource: {cause: 'restart', fresh: true},
		});
		expect(input.startTurn).toHaveBeenCalledTimes(kind === 'unchanged' ? 2 : 1);
	},
);

it('checks the iteration ceiling before a fresh restart', async () => {
	const {input, journal} = setup({resumeRunId: 'current'});
	input.workflow!.loop!.maxIterations = 1;
	input.handover = {takeRequest: () => ({handle: 'old'})};
	input.startTurn = vi.fn(async () => {
		fs.writeFileSync(journal, checkpoint('current'));
		return ok;
	});
	const result = await createWorkflowRunner(input).result;
	expect(result.interruption).toMatchObject({resource: {cause: 'iterations'}});
	expect(input.startTurn).toHaveBeenCalledOnce();
});

it('retains the last valid checkpoint when a later Journal write is partial', async () => {
	const {input, journal, persistRunState} = setup({resumeRunId: 'current'});
	input.handover = {takeRequest: () => ({handle: 'old'})};
	let turns = 0;
	input.startTurn = async () => {
		fs.writeFileSync(
			journal,
			++turns === 1 ? checkpoint('current') : '## Restart\nObjective:',
		);
		return ok;
	};
	const result = await createWorkflowRunner(input).result;
	expect(result.status).toBe('awaiting_attention');
	expect(
		deserializeRunMemory(persistRunState.mock.lastCall![0].runMemoryJson)
			?.checkpoint?.contract.text,
	).toContain('Constraints: preserve user changes');
});

it('rejects a restart with insufficient context room', async () => {
	const {input, journal} = setup({resumeRunId: 'current'});
	input.handover = {takeRequest: () => ({handle: 'old'})};
	input.startTurn = vi.fn(async () => {
		fs.writeFileSync(journal, checkpoint('current'));
		return {
			...ok,
			tokens: {...usage(100), openingContextSize: 95000, contextSize: 100000},
		};
	});
	const result = await createWorkflowRunner(input).result;
	expect(result.interruption).toMatchObject({resource: {cause: 'context'}});
	expect(input.startTurn).toHaveBeenCalledOnce();
});

it('a fresh human wake uses the repaired current-run checkpoint', async () => {
	const {input, journal} = setup({
		resumeRunId: 'current',
		resumedStopReason: 'restart unavailable',
		resumedRunMemory: {...memory(), parkedAfterHandover: true},
	});
	fs.mkdirSync(path.dirname(journal), {recursive: true});
	fs.writeFileSync(journal, checkpoint('current', 'apply the repaired plan'));
	input.startTurn = vi.fn(async turn => {
		expect(turn.continuation).toEqual({mode: 'fresh'});
		expect(turn.prompt).toContain('Next action: apply the repaired plan');
		expect(turn.prompt).toContain('human replied');
		fs.writeFileSync(journal, '<!-- WORKFLOW_COMPLETE -->');
		return ok;
	});
	expect((await createWorkflowRunner(input).result).status).toBe('completed');
	expect(input.startTurn).toHaveBeenCalledOnce();
});

it('reconciles usage reported while a budget interruption drains', async () => {
	vi.useFakeTimers();
	const {input, persistRunState} = setup();
	input.workflow!.loop!.maxRunTokens = 100;
	input.startTurn = async ({onUsage}) => {
		onUsage?.(usage(101));
		await new Promise(resolve => setTimeout(resolve, 100));
		onUsage?.(usage(120));
		return {...ok, tokens: usage(130)};
	};
	const pending = createWorkflowRunner(input).result;
	await vi.advanceTimersByTimeAsync(101);
	const result = await pending;
	expect(result.tokens.total).toBe(130);
	expect(result.interruption).toMatchObject({resource: {used: 130}});
	expect(
		deserializeRunMemory(persistRunState.mock.lastCall![0].runMemoryJson)
			?.cumulativeTokens,
	).toBe(130);
});

it('rejects a retained checkpoint after the configured limit shrinks', async () => {
	const contract = readRestartContract(checkpoint('current'))!;
	const {input} = setup({
		resumeRunId: 'current',
		resumedStopReason: 'restart',
		resumedRunMemory: {
			...memory(),
			parkedAfterHandover: true,
			checkpoint: {path: '/journal.md', contract},
		},
	});
	input.workflow!.loop!.maxRestartTokens = 1;
	input.startTurn = vi.fn(async () => ok);
	expect((await createWorkflowRunner(input).result).interruption).toMatchObject(
		{resource: {cause: 'restart'}},
	);
	expect(input.startTurn).not.toHaveBeenCalled();
});

it('does not count the previous seed twice when admitting a replacement', () => {
	const config = cfg();
	const contract = readRestartContract(
		checkpoint('current', 'x'.repeat(7400)),
	)!;
	const result = step(
		{kind: 'awaiting_attention', stopReason: 'restart'},
		{
			...memory(),
			parkedAfterHandover: true,
			contextKey: config.contextKey,
			checkpoint: {path: '/journal.md', contract},
			lastBoundedTurn: {
				openingContextTokens: 89000,
				openingRestartTokens: contract.tokens,
				lastContextTokens: 98500,
				toolCalls: 2,
			},
		},
		{type: 'woken', continuation: {mode: 'fresh'}},
		config,
	);
	expect(result.phase.kind).toBe('turn_in_flight');
});

it('emits iteration telemetry when a handover has no valid checkpoint', async () => {
	const onIterationComplete = vi.fn();
	const {input} = setup({
		onIterationComplete,
		handover: {takeRequest: () => ({handle: 'old'})},
	});
	await createWorkflowRunner(input).result;
	expect(onIterationComplete).toHaveBeenCalledOnce();
});
