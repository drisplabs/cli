import type {ExecExitCode, ExecRunFailure} from './types';
import {EXEC_EXIT_CODE} from './types';

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
): ExecExitCode {
	if (!failure) return EXEC_EXIT_CODE.SUCCESS;
	if (failure.kind === 'timeout') return EXEC_EXIT_CODE.TIMEOUT;
	if (failure.kind === 'output') return EXEC_EXIT_CODE.OUTPUT;
	if (failure.kind === 'workflow') {
		return failure.state === 'exhausted'
			? EXEC_EXIT_CODE.WORKFLOW_EXHAUSTED
			: EXEC_EXIT_CODE.WORKFLOW_BLOCKED;
	}
	return EXEC_EXIT_CODE.RUNTIME;
}
