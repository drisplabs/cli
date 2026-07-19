import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {createWorkflowRunState, prepareWorkflowTurn} from './sessionPlan';
import {STATE_MACHINE_CONTENT} from './stateMachine';

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-workflow-'));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

describe('workflow session planning', () => {
	it('applies prompt template and resolves shared workflow overrides', () => {
		const projectDir = makeTempDir();
		const promptPath = path.join(projectDir, 'workflow-prompt.md');
		fs.writeFileSync(promptPath, 'Follow the tracker strictly.', 'utf-8');

		const state = createWorkflowRunState({
			projectDir,
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: 'Execute: {input}',
				workflowFile: 'workflow-prompt.md',
			},
		});
		const prepared = prepareWorkflowTurn(state, {
			prompt: 'ship it',
			configOverride: {model: 'gpt-5'},
		});

		const composedPath = path.join(projectDir, '.composed-system-prompt.md');
		expect(prepared.prompt).toBe('Execute: ship it');
		expect(prepared.configOverride).toEqual({
			model: 'gpt-5',
			appendSystemPromptFile: composedPath,
			developerInstructions: 'Follow the tracker strictly.',
		});
	});

	it('prepends state machine protocol for looped workflows', () => {
		const projectDir = makeTempDir();
		const workflowPath = path.join(projectDir, 'workflow.md');
		fs.writeFileSync(workflowPath, '# Workflow Steps', 'utf-8');

		const state = createWorkflowRunState({
			projectDir,
			sessionId: 'sess-1',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				workflowFile: 'workflow.md',
				loop: {enabled: true, maxIterations: 5},
			},
		});

		expect(state.workflowOverride).toBeDefined();
		const instructions = (state.workflowOverride as Record<string, unknown>)[
			'developerInstructions'
		] as string;
		expect(instructions).toContain('# Stateless Turn Protocol');
		expect(instructions).toContain('# Workflow Steps');
		expect(instructions.indexOf('Stateless Turn Protocol')).toBeLessThan(
			instructions.indexOf('Workflow Steps'),
		);
	});

	it('uses harness-specific task tool instructions in composed state machine content', () => {
		const projectDir = makeTempDir();
		const workflowPath = path.join(projectDir, 'workflow.md');
		fs.writeFileSync(workflowPath, '# Workflow Steps', 'utf-8');

		const state = createWorkflowRunState({
			projectDir,
			sessionId: 'sess-1',
			harness: 'openai-codex',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				workflowFile: 'workflow.md',
				loop: {enabled: true, maxIterations: 5},
			},
		});

		const instructions = (state.workflowOverride as Record<string, unknown>)[
			'developerInstructions'
		] as string;
		expect(instructions).toContain('Use the `update_plan` tool');
		expect(instructions).toContain('create a detailed task list');
		expect(instructions).toContain('Keep task state consistent and non-stale');
		expect(instructions).toContain(
			'Do not carry forward prior session task IDs',
		);
	});

	it('includes strict workflow step, skill loading, and git worktree discipline in looped workflow prompts', () => {
		const projectDir = makeTempDir();
		const workflowPath = path.join(projectDir, 'workflow.md');
		fs.writeFileSync(workflowPath, '# Workflow Steps', 'utf-8');

		const state = createWorkflowRunState({
			projectDir,
			sessionId: 'sess-1',
			harness: 'openai-codex',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				workflowFile: 'workflow.md',
				loop: {enabled: true, maxIterations: 5},
			},
		});

		const instructions = (state.workflowOverride as Record<string, unknown>)[
			'developerInstructions'
		] as string;
		expect(instructions).toContain('Be strict with workflow steps');
		expect(instructions).toContain(
			'terminal marker, it must be the final non-empty line',
		);
		expect(instructions).toContain('Never append prose after it');
		expect(instructions).toContain('follow it as written');
		expect(instructions).toContain('Do not substitute your own process');
		expect(instructions).toContain('Be strict with skills');
		expect(instructions).toContain('read it completely');
		expect(instructions).toContain(
			'Do not assume you already know the workflow',
		);
		expect(instructions).toContain(
			'Use a dedicated git worktree for repository-changing work',
		);
		expect(instructions).toContain('record its branch/path in the tracker');
	});

	it('uses non-codex harness task tools in composed state machine content', () => {
		const projectDir = makeTempDir();
		const workflowPath = path.join(projectDir, 'workflow.md');
		fs.writeFileSync(workflowPath, '# Workflow Steps', 'utf-8');

		const state = createWorkflowRunState({
			projectDir,
			sessionId: 'sess-1',
			harness: 'claude-code',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				workflowFile: 'workflow.md',
				loop: {enabled: true, maxIterations: 5},
			},
		});

		const instructions = (state.workflowOverride as Record<string, unknown>)[
			'developerInstructions'
		] as string;
		expect(instructions).toContain('Use `TaskCreate` and `TaskUpdate`');
		expect(instructions).toContain('create a detailed task list');
		expect(instructions).toContain('Maintain exactly one active task');
	});

	it('omits state machine protocol for non-looped workflows', () => {
		const projectDir = makeTempDir();
		const workflowPath = path.join(projectDir, 'workflow.md');
		fs.writeFileSync(workflowPath, '# Workflow Steps', 'utf-8');

		const state = createWorkflowRunState({
			projectDir,
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				workflowFile: 'workflow.md',
			},
		});

		const instructions = (state.workflowOverride as Record<string, unknown>)?.[
			'developerInstructions'
		] as string;
		expect(instructions).not.toContain(STATE_MACHINE_CONTENT);
		expect(instructions).toBe('# Workflow Steps');
	});

	it('switches from the orient template to the continue prompt on later iterations', () => {
		const projectDir = makeTempDir();
		const state = createWorkflowRunState({
			projectDir,
			sessionId: 'session-1',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: 'Execute: {input}',
				loop: {
					enabled: true,
					completionMarker: '<!-- DONE -->',
					maxIterations: 5,
					trackerPath: '.athena/{sessionId}.md',
					continuePrompt: 'Continue with {trackerPath}',
				},
			},
		});

		expect(
			prepareWorkflowTurn(state, {prompt: 'first', iteration: 1}).prompt,
		).toBe('Execute: first');
		expect(
			prepareWorkflowTurn(state, {
				prompt: 'ignored after first turn',
				iteration: 2,
			}).prompt,
		).toBe('Continue with .athena/session-1.md');
	});
});
