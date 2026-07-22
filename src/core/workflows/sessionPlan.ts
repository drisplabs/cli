import fs from 'node:fs';
import path from 'node:path';
import type {AthenaHarness} from '../../infra/plugins/config';
import type {HarnessProcessOverride} from '../runtime/process';
import {applyPromptTemplate} from './applyWorkflow';
import {substituteVariables} from './templateVars';
import {buildContinuePrompt, DEFAULT_TRACKER_PATH} from './trackerReader';
import {buildStateMachineContent} from './stateMachine';
import type {WorkflowConfig} from './types';

export type WorkflowRunState = {
	workflow?: WorkflowConfig;
	trackerPathForPrompt?: string;
	workflowOverride?: HarnessProcessOverride;
	warnings: string[];
};

export type PreparedWorkflowTurn = {
	prompt: string;
	configOverride?: HarnessProcessOverride;
	warnings: string[];
};

function readWorkflowOverride(
	projectDir: string,
	workflow?: WorkflowConfig,
	sessionId?: string,
	trackerPath?: string,
	harness: AthenaHarness = 'claude-code',
): Pick<WorkflowRunState, 'workflowOverride' | 'warnings'> {
	if (!workflow?.workflowFile) {
		return {workflowOverride: undefined, warnings: []};
	}

	const resolvedPath = path.isAbsolute(workflow.workflowFile)
		? workflow.workflowFile
		: path.resolve(projectDir, workflow.workflowFile);

	let workflowContent: string;
	try {
		workflowContent = fs.readFileSync(resolvedPath, 'utf-8');
	} catch {
		return {
			workflowOverride: undefined,
			warnings: [
				`Workflow file not found: ${workflow.workflowFile}. Continuing without workflow system instructions.`,
			],
		};
	}

	let composed = workflow.loop?.enabled
		? buildStateMachineContent(harness) + '\n\n' + workflowContent
		: workflowContent;

	composed = substituteVariables(composed, {
		sessionId,
		trackerPath: trackerPath ?? undefined,
	});

	// Write composed prompt to a stable file so the harness can read it via
	// --append-system-prompt-file without a temp-file cleanup concern.
	const workflowDir = path.dirname(resolvedPath);
	const composedPath = path.join(workflowDir, '.composed-system-prompt.md');
	fs.writeFileSync(composedPath, composed, 'utf-8');

	return {
		workflowOverride: {
			appendSystemPromptFile: composedPath,
			developerInstructions: composed,
		},
		warnings: [],
	};
}

function mergeOverrides(
	base?: HarnessProcessOverride,
	workflowOverride?: HarnessProcessOverride,
): HarnessProcessOverride | undefined {
	if (!base) return workflowOverride;
	if (!workflowOverride) return base;
	return {
		...base,
		...workflowOverride,
	};
}

export function resolveTrackerPath(input: {
	projectDir: string;
	sessionId?: string;
	workflow?: WorkflowConfig;
}): {absolutePath: string; promptPath: string} | null {
	const loop = input.workflow?.loop;
	if (!loop?.enabled) {
		return null;
	}

	const rawPath = loop.trackerPath ?? DEFAULT_TRACKER_PATH;

	// The default tracker path requires a session ID for substitution.
	// If neither a session ID nor an explicit tracker path was provided, the
	// loop cannot operate.
	if (!input.sessionId && rawPath.includes('{sessionId}')) {
		return null;
	}

	const promptPath = input.sessionId
		? rawPath.replaceAll('{sessionId}', input.sessionId)
		: rawPath;
	const absolutePath = path.isAbsolute(promptPath)
		? promptPath
		: path.resolve(input.projectDir, promptPath);

	return {
		absolutePath,
		promptPath,
	};
}

export function createWorkflowRunState(input: {
	projectDir: string;
	sessionId?: string;
	workflow?: WorkflowConfig;
	harness?: AthenaHarness;
}): WorkflowRunState {
	const {projectDir, sessionId, workflow, harness} = input;
	const trackerResolved = resolveTrackerPath({projectDir, sessionId, workflow});
	const {workflowOverride, warnings} = readWorkflowOverride(
		projectDir,
		workflow,
		sessionId,
		trackerResolved?.promptPath,
		harness,
	);

	return {
		workflow,
		trackerPathForPrompt: trackerResolved?.promptPath,
		workflowOverride,
		warnings,
	};
}

/**
 * Build the prompt for the Turn at `iteration` (1-based). Turn 1 gets the
 * Orient prompt from the workflow's template; Turn 2+ of a loop gets the
 * lightweight Continue Prompt that just points the agent at the Tracker.
 */
export function prepareWorkflowTurn(
	state: WorkflowRunState,
	input: {
		prompt: string;
		iteration?: number;
		configOverride?: HarnessProcessOverride;
	},
): PreparedWorkflowTurn {
	const {workflow} = state;
	const iteration = input.iteration ?? 1;
	const isContinuation = workflow?.loop?.enabled === true && iteration > 1;
	const prompt = isContinuation
		? buildContinuePrompt({
				...workflow.loop!,
				trackerPath: state.trackerPathForPrompt ?? workflow.loop?.trackerPath,
			})
		: workflow
			? applyPromptTemplate(workflow.promptTemplate, input.prompt)
			: input.prompt;

	return {
		prompt,
		configOverride: mergeOverrides(
			input.configOverride,
			state.workflowOverride,
		),
		warnings: state.warnings,
	};
}
