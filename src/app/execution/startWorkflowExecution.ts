import type {WorkflowPlan} from '../../core/workflows/plan';
import type {Runtime} from '../../core/runtime/types';
import {createExecutionResources} from './resources';
import type {WorkflowRunResult} from '../../core/workflows/workflowRunner';
import {
	createWorkflowRunner,
	type WorkflowRunnerInput,
	type WorkflowRunnerHandle,
} from '../../core/workflows/workflowRunner';
import {
	deserializeRunMemory,
	wakesFreshAfterHandover,
} from '../../core/workflows/runMachine';
import type {SessionStore} from '../../infra/sessions/store';
import type {HarnessProcessConfig} from '../../core/runtime/process';
import {executionIdentity, validateResumeIdentity} from './executionIdentity';

export type WorkflowExecution = WorkflowRunnerHandle & {
	/** Stop waits until the active turn settles. Safe to call repeatedly. */
	stop: () => Promise<WorkflowRunResult>;
	/** Release execution subscriptions, stopping unfinished work first. */
	dispose: () => Promise<void>;
};

/** Shared admission, identity and restoration for interactive and headless hosts. */
export function startWorkflowExecution(
	input: WorkflowRunnerInput,
	options: {
		store?: Pick<SessionStore, 'getLatestRun'>;
		isolationConfig?: HarnessProcessConfig;
		workflowPlan?: WorkflowPlan;
		runtime?: Runtime | null;
		signal?: AbortSignal;
		warnOnUnmanagedCompaction?: boolean;
	} = {},
): WorkflowExecution {
	const latest = options.store?.getLatestRun();
	const resume = input.resumeRunId ? latest : undefined;
	if (
		input.resumeRunId &&
		(!resume ||
			resume.id !== input.resumeRunId ||
			resume.status !== 'awaiting_attention')
	) {
		throw new Error(
			'The requested Workflow Run is not the current parked Run for this session.',
		);
	}
	const identity = executionIdentity({
		projectDir: input.projectDir,
		harness: input.harness ?? 'claude-code',
		workflow: input.workflow,
		isolationConfig: options.isolationConfig,
		workflowPlan: options.workflowPlan,
	});
	if (resume?.runMemoryJson && !deserializeRunMemory(resume.runMemoryJson))
		throw new Error(
			'Saved workflow memory is unreadable; refusing to reset continuation budgets.',
		);
	if (resume) {
		const warning = validateResumeIdentity(
			resume,
			identity,
			input.workflow?.name,
		);
		if (warning) input.onWarning?.(warning);
	}
	const resources = createExecutionResources();
	let adapterSessionId =
		resume?.adapterSessionId ??
		(input.initialContinuation?.mode === 'resume'
			? input.initialContinuation.handle
			: undefined);
	let toolCalls = 0;
	if (options.runtime)
		resources.own(
			options.runtime.onEvent(event => {
				if (event.sessionId) adapterSessionId = event.sessionId;
				if (event.kind === 'tool.pre') toolCalls++;
				if (
					event.kind === 'compact.pre' &&
					options.warnOnUnmanagedCompaction &&
					input.workflow?.loop?.enabled
				)
					input.onWarning?.(
						'The interactive runtime is compacting this conversation. Journal checkpoint restart is currently supported by headless Claude execution only.',
					);
			}),
		);
	let runner: WorkflowRunnerHandle;
	try {
		runner = createWorkflowRunner({
			...input,
			currentAdapterSessionId:
				input.currentAdapterSessionId ?? (() => adapterSessionId),
			currentTurnToolCalls: input.currentTurnToolCalls ?? (() => toolCalls),
			startTurn: turn => {
				toolCalls = 0;
				return input.startTurn(turn);
			},
			...(resume
				? {
						resumedRunMemory:
							deserializeRunMemory(resume.runMemoryJson) ?? undefined,
						resumedStopReason: resume.stopReason,
						parkedInterruption: resume.interruption,
						initialContinuation: wakesFreshAfterHandover(resume.runMemoryJson)
							? {mode: 'fresh' as const}
							: resume.adapterSessionId
								? {mode: 'resume' as const, handle: resume.adapterSessionId}
								: input.initialContinuation,
					}
				: {}),
			persistRunState: snapshot =>
				input.persistRunState({...snapshot, executionIdentityJson: identity}),
		});
	} catch (error) {
		void resources.dispose();
		throw error;
	}
	let settled = false;
	let stopped = false;
	const kill = () => {
		if (!settled && !stopped) {
			stopped = true;
			runner.kill();
		}
	};
	const result = runner.result.finally(async () => {
		settled = true;
		await resources.dispose();
	});
	if (options.signal) {
		const signal = options.signal;
		if (signal.aborted) kill();
		else {
			signal.addEventListener('abort', kill, {once: true});
			resources.own(() => signal.removeEventListener('abort', kill));
		}
	}
	return {
		...runner,
		kill,
		result,
		stop: () => {
			kill();
			return result;
		},
		dispose: async () => {
			kill();
			try {
				await result;
			} finally {
				await resources.dispose();
			}
		},
	};
}
