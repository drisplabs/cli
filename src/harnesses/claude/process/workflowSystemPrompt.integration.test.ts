/**
 * End-to-end integration: a looped workflow's composed system prompt
 * (Stateless Session Protocol + the workflow's instructions file) must reach
 * the spawned Claude process via `--append-system-prompt-file`.
 *
 * This spans the seam that unit tests leave uncovered: `sessionPlan` proves the
 * override is *built*, and `spawn` proves *a given* file flag reaches argv — but
 * nothing asserts a real workflow config produces argv carrying the protocol.
 * Drive the public path: createWorkflowRunState -> prepareWorkflowTurn ->
 * spawnClaude, then read the actual argv handed to child_process.spawn.
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {EventEmitter} from 'node:events';
import {spawnClaude} from './spawn';
import type {IsolationConfig} from '../config/isolation';
import {
	createWorkflowRunState,
	prepareWorkflowTurn,
} from '../../../core/workflows/sessionPlan';
import type {WorkflowConfig} from '../../../core/workflows/types';

const mockCleanup = vi.fn();

vi.mock('../hooks/generateHookSettings', () => ({
	generateHookSettings: vi.fn(() => ({
		settingsPath: '/tmp/mock-settings.json',
		cleanup: mockCleanup,
	})),
	registerCleanupOnExit: vi.fn(),
	resolveHookForwarderCommand: vi.fn(),
}));

vi.mock('node:child_process', () => ({spawn: vi.fn()}));

vi.mock('../system/resolveBinary', () => ({
	resolveClaudeBinary: vi.fn(() => '/resolved/claude'),
}));

vi.mock('../auth/runtimeAuth', () => ({
	resolveRuntimeAuthOverlay: vi.fn(() => null),
}));

import {resolveClaudeBinary} from '../system/resolveBinary';
import {resolveHookForwarderCommand} from '../hooks/generateHookSettings';
import {resolveRuntimeAuthOverlay} from '../auth/runtimeAuth';

function createMockChildProcess() {
	return Object.assign(new EventEmitter(), {
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		stdin: undefined,
		kill: vi.fn().mockReturnValue(true),
	}) as unknown as childProcess.ChildProcess;
}

const tempDirs: string[] = [];
function makeProjectDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-wf-integration-'));
	tempDirs.push(dir);
	return dir;
}

/** A loop-enabled workflow whose instructions live in `workflow.md`. */
function loopedWorkflow(): WorkflowConfig {
	return {
		name: 'wf',
		plugins: [],
		promptTemplate: 'Execute: {input}',
		workflowFile: 'workflow.md',
		loop: {enabled: true, maxIterations: 5},
	};
}

/**
 * Drive the real production path from a workflow config to a spawned process
 * and return the args handed to child_process.spawn.
 */
function spawnForWorkflow(input: {
	projectDir: string;
	sessionId: string;
	workflow: WorkflowConfig;
}): string[] {
	const state = createWorkflowRunState({
		projectDir: input.projectDir,
		sessionId: input.sessionId,
		workflow: input.workflow,
	});
	const prepared = prepareWorkflowTurn(state, {prompt: 'ship it'});

	spawnClaude({
		prompt: prepared.prompt,
		projectDir: input.projectDir,
		instanceId: 12345,
		// In production the prepared override flows in as perCallIsolation and is
		// spread into the isolation config by mergeIsolation; mirror that here.
		isolation: prepared.configOverride as IsolationConfig,
	});

	return vi.mocked(childProcess.spawn).mock.calls.at(-1)?.[1] as string[];
}

function appendedSystemPromptFileContents(args: string[]): string {
	const i = args.indexOf('--append-system-prompt-file');
	expect(i).toBeGreaterThanOrEqual(0);
	return fs.readFileSync(args[i + 1]!, 'utf8');
}

describe('workflow system prompt reaches the spawned process (e2e)', () => {
	let tempHookForwarderPath = '';

	beforeEach(() => {
		tempHookForwarderPath = path.join(
			os.tmpdir(),
			`athena-wf-hook-forwarder-${process.pid}-${Date.now()}.js`,
		);
		fs.writeFileSync(tempHookForwarderPath, 'console.log("ok");');
		vi.mocked(childProcess.spawn).mockReturnValue(createMockChildProcess());
		vi.mocked(resolveClaudeBinary).mockReturnValue('/resolved/claude');
		vi.mocked(resolveHookForwarderCommand).mockReturnValue({
			command: `'${process.execPath}' '${tempHookForwarderPath}'`,
			executable: process.execPath,
			args: [tempHookForwarderPath],
			source: 'bundled',
			scriptPath: tempHookForwarderPath,
		});
		vi.mocked(resolveRuntimeAuthOverlay).mockReturnValue(null);
		mockCleanup.mockClear();
	});

	afterEach(() => {
		try {
			fs.unlinkSync(tempHookForwarderPath);
		} catch {
			// ignore
		}
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, {recursive: true, force: true});
		}
		vi.clearAllMocks();
	});

	it('carries the protocol and workflow instructions onto the spawned argv', () => {
		const projectDir = makeProjectDir();
		fs.writeFileSync(
			path.join(projectDir, 'workflow.md'),
			'# My Workflow Steps\nDo the thing.',
			'utf8',
		);

		const args = spawnForWorkflow({
			projectDir,
			sessionId: 'sess-e2e',
			workflow: loopedWorkflow(),
		});

		const appended = appendedSystemPromptFileContents(args);
		expect(appended).toContain('Stateless Session Protocol');
		expect(appended).toContain('# My Workflow Steps');
	});

	it('delivers the protocol via the persistent system-prompt channel, not the conversation prompt', () => {
		const projectDir = makeProjectDir();
		fs.writeFileSync(
			path.join(projectDir, 'workflow.md'),
			'# My Workflow Steps',
			'utf8',
		);

		const args = spawnForWorkflow({
			projectDir,
			sessionId: 'sess-e2e',
			workflow: loopedWorkflow(),
		});

		// The conversation prompt (-p) is part of the message history and is
		// subject to compaction. The protocol must NOT live there.
		const promptArg = args[args.indexOf('-p') + 1]!;
		expect(promptArg).not.toContain('Stateless Session Protocol');

		// It must live in the appended system-prompt file, which is re-sent on
		// every model request for the life of the process and therefore survives
		// an in-process compaction.
		expect(appendedSystemPromptFileContents(args)).toContain(
			'Stateless Session Protocol',
		);
	});

	it('regenerates the composed prompt on a later run when the workflow file changes', () => {
		const projectDir = makeProjectDir();
		const workflowFile = path.join(projectDir, 'workflow.md');

		// Run 1: the workflow ships version one.
		fs.writeFileSync(workflowFile, '# Workflow Version One', 'utf8');
		const firstArgs = spawnForWorkflow({
			projectDir,
			sessionId: 'sess-run-1',
			workflow: loopedWorkflow(),
		});
		expect(appendedSystemPromptFileContents(firstArgs)).toContain(
			'# Workflow Version One',
		);

		// The workflow is upgraded in place between runs.
		fs.writeFileSync(workflowFile, '# Workflow Version Two', 'utf8');

		// Run 2: a fresh run picks up the new instructions, no stale caching.
		const secondArgs = spawnForWorkflow({
			projectDir,
			sessionId: 'sess-run-2',
			workflow: loopedWorkflow(),
		});
		const secondAppended = appendedSystemPromptFileContents(secondArgs);
		expect(secondAppended).toContain('# Workflow Version Two');
		expect(secondAppended).not.toContain('# Workflow Version One');
	});
});
