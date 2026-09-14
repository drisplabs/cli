import {
	startWorkflowExecution,
	type WorkflowExecution,
} from './startWorkflowExecution';
import type {SessionStore} from '../../infra/sessions/store';
import type {Runtime} from '../../core/runtime/types';
import type {HarnessProcessConfig} from '../../core/runtime/process';
import {useCallback, useEffect, useRef, useState} from 'react';
import type {
	HarnessProcess,
	HarnessProcessOverride,
	TurnContinuation,
	TurnExecutionResult,
} from '../../core/runtime/process';
import {type PhaseChange} from '../../core/workflows/workflowRunner';
import type {WorkflowConfig} from '../../core/workflows/types';
import type {WorkflowPlan} from '../../core/workflows/plan';
import type {WorkflowRunSnapshot} from '../../infra/sessions/types';
import type {AthenaHarness} from '../../infra/plugins/config';

export type UseWorkflowSessionControllerInput = {
	projectDir: string;
	sessionId?: string;
	harness?: AthenaHarness;
	workflow?: WorkflowConfig;
	workflowPlan?: WorkflowPlan;
	pluginMcpConfig?: string;
	store?: SessionStore | null;
	runtime?: Runtime | null;
	isolationConfig?: HarnessProcessConfig;
	onWarning?: (message: string) => void;
	onOutcome?: (
		result: import('../../core/workflows/workflowRunner').WorkflowRunResult,
	) => void;
	persistRunState?: (snapshot: WorkflowRunSnapshot) => void;
	/** The Run moved to a new workflow step (the Journal's Turn Protocol block). */
	onPhaseChange?: (change: PhaseChange) => void;
};

export function useWorkflowSessionController(
	base: HarnessProcess<HarnessProcessOverride>,
	input: UseWorkflowSessionControllerInput,
): HarnessProcess<HarnessProcessOverride> & {
	readonly activeRunId: string | null;
} {
	const [isRunning, setIsRunning] = useState(false);
	const runnerRef = useRef<WorkflowExecution | null>(null);
	const activeRunIdRef = useRef<string | null>(null);

	const cancelCurrentRun = useCallback(async (): Promise<void> => {
		const runner = runnerRef.current;
		if (runner) {
			await runner.stop().catch(() => {});
			runnerRef.current = null;
			activeRunIdRef.current = null;
		}
	}, []);

	const interrupt = useCallback((): void => {
		const runner = runnerRef.current;
		if (runner) {
			runner.kill();
		} else {
			void base.kill().catch(() => {});
		}
		setIsRunning(false);
	}, [base]);

	const kill = useCallback(async (): Promise<void> => {
		if (runnerRef.current) {
			await cancelCurrentRun();
		} else {
			await base.kill();
		}
		setIsRunning(false);
	}, [base, cancelCurrentRun]);

	const spawn = useCallback(
		async (
			prompt: string,
			continuation?: TurnContinuation,
			_configOverride?: HarnessProcessOverride,
		): Promise<TurnExecutionResult> => {
			await cancelCurrentRun();
			const latest = input.store?.getLatestRun();
			const parked =
				latest?.status === 'awaiting_attention' ? latest : undefined;
			const handle = startWorkflowExecution(
				{
					sessionId: input.sessionId ?? '',
					projectDir: input.projectDir,
					harness: input.harness,
					workflow: input.workflow,
					prompt,
					initialContinuation: continuation,
					resumeRunId: parked?.id,
					onWarning: input.onWarning,
					startTurn: turnInput =>
						base.startTurn(
							turnInput.prompt,
							turnInput.continuation,
							turnInput.configOverride,
							turnInput.onUsage,
						),
					persistRunState: input.persistRunState ?? (() => {}),
					onPhaseChange: input.onPhaseChange,
					abortCurrentTurn: () => void base.kill().catch(() => {}),
				},
				{
					store: input.store ?? undefined,
					isolationConfig: input.isolationConfig,
					runtime: input.runtime,
					workflowPlan: input.workflowPlan,
					pluginMcpConfig: input.pluginMcpConfig,
					warnOnUnmanagedCompaction: true,
				},
			);
			setIsRunning(true);

			runnerRef.current = handle;
			activeRunIdRef.current = handle.runId;

			try {
				const runResult = await handle.result;
				input.onOutcome?.(runResult);
				return {
					exitCode: runResult.status === 'failed' ? 1 : 0,
					error:
						runResult.status === 'failed'
							? new Error(runResult.stopReason ?? 'Run failed')
							: null,
					tokens: runResult.tokens,
					streamMessage: null,
					workflowOutcome: {
						status: runResult.status,
						runId: runResult.runId,
						stopReason: runResult.stopReason,
					},
				};
			} finally {
				if (runnerRef.current === handle) {
					runnerRef.current = null;
					activeRunIdRef.current = null;
					setIsRunning(false);
				}
			}
		},
		[base, cancelCurrentRun, input],
	);

	useEffect(() => {
		return () => {
			runnerRef.current?.kill();
			runnerRef.current = null;
			activeRunIdRef.current = null;
		};
	}, []);

	return {
		...base,
		startTurn: spawn,
		isRunning,
		interrupt,
		kill,
		get activeRunId() {
			return activeRunIdRef.current;
		},
	};
}
