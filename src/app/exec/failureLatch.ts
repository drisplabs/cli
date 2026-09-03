import type {RunExitCode, ExecRunFailure} from './types';
import {RUN_EXIT_CODE} from './types';

/**
 * Single-write failure latch for a runExec invocation.
 * First call to `register` wins; subsequent calls are no-ops.
 */
export type FailureLatch = {
	register(next: ExecRunFailure): void;
	current(): ExecRunFailure | undefined;
	hasFailure(): boolean;
};

export function createFailureLatch(
	onRegister: (failure: ExecRunFailure) => void,
): FailureLatch {
	let failure: ExecRunFailure | undefined;
	return {
		register(next) {
			if (failure) return;
			failure = next;
			onRegister(failure);
		},
		current() {
			return failure;
		},
		hasFailure() {
			return failure !== undefined;
		},
	};
}

/** Map an exec failure (or absence of one) to the process exit code. */
export function exitCodeFromFailure(
	failure: ExecRunFailure | undefined,
): RunExitCode {
	if (!failure) return RUN_EXIT_CODE.SUCCESS;
	if (failure.kind === 'timeout') return RUN_EXIT_CODE.TIMEOUT;
	if (failure.kind === 'output') return RUN_EXIT_CODE.OUTPUT;
	if (failure.kind === 'workflow') {
		return failure.state === 'exhausted'
			? RUN_EXIT_CODE.WORKFLOW_EXHAUSTED
			: RUN_EXIT_CODE.WORKFLOW_BLOCKED;
	}
	return RUN_EXIT_CODE.RUNTIME;
}
