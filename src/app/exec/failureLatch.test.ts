import {describe, it, expect, vi} from 'vitest';
import {createFailureLatch, exitCodeFromFailure} from './failureLatch';
import {EXEC_EXIT_CODE} from './types';

describe('createFailureLatch', () => {
	it('starts with no failure', () => {
		const latch = createFailureLatch(() => {});
		expect(latch.hasFailure()).toBe(false);
		expect(latch.current()).toBeUndefined();
	});

	it('registers the first failure and calls onRegister', () => {
		const onRegister = vi.fn();
		const latch = createFailureLatch(onRegister);
		const failure = {kind: 'process' as const, message: 'boom'};
		latch.register(failure);
		expect(latch.hasFailure()).toBe(true);
		expect(latch.current()).toBe(failure);
		expect(onRegister).toHaveBeenCalledOnce();
		expect(onRegister).toHaveBeenCalledWith(failure);
	});

	it('ignores subsequent registrations — first write wins', () => {
		const onRegister = vi.fn();
		const latch = createFailureLatch(onRegister);
		const first = {kind: 'process' as const, message: 'first'};
		const second = {kind: 'timeout' as const, message: 'second'};
		latch.register(first);
		latch.register(second);
		expect(latch.current()).toBe(first);
		expect(onRegister).toHaveBeenCalledOnce();
	});

	it('handles all failure kinds via register', () => {
		for (const failure of [
			{kind: 'timeout' as const, message: 'timed out'},
			{kind: 'output' as const, message: 'output error'},
			{
				kind: 'workflow' as const,
				state: 'blocked' as const,
				message: 'blocked',
			},
			{
				kind: 'workflow' as const,
				state: 'exhausted' as const,
				message: 'exhausted',
			},
		]) {
			const latch = createFailureLatch(() => {});
			latch.register(failure);
			expect(latch.current()).toStrictEqual(failure);
		}
	});
});

describe('exitCodeFromFailure', () => {
	it('returns SUCCESS when no failure', () => {
		expect(exitCodeFromFailure(undefined)).toBe(EXEC_EXIT_CODE.SUCCESS);
	});

	it('maps timeout to TIMEOUT', () => {
		expect(exitCodeFromFailure({kind: 'timeout', message: 'x'})).toBe(
			EXEC_EXIT_CODE.TIMEOUT,
		);
	});

	it('maps output to OUTPUT', () => {
		expect(exitCodeFromFailure({kind: 'output', message: 'x'})).toBe(
			EXEC_EXIT_CODE.OUTPUT,
		);
	});

	it('maps workflow blocked to WORKFLOW_BLOCKED', () => {
		expect(
			exitCodeFromFailure({kind: 'workflow', state: 'blocked', message: 'x'}),
		).toBe(EXEC_EXIT_CODE.WORKFLOW_BLOCKED);
	});

	it('maps workflow exhausted to WORKFLOW_EXHAUSTED', () => {
		expect(
			exitCodeFromFailure({kind: 'workflow', state: 'exhausted', message: 'x'}),
		).toBe(EXEC_EXIT_CODE.WORKFLOW_EXHAUSTED);
	});

	it('maps process failure to RUNTIME', () => {
		expect(exitCodeFromFailure({kind: 'process', message: 'x'})).toBe(
			EXEC_EXIT_CODE.RUNTIME,
		);
	});
});
