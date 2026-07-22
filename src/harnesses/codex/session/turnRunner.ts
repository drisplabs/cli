import type {RuntimeEvent} from '../../../core/runtime/types';
import type {TurnExecutionResult} from '../../../core/runtime/process';
import type {TokenUsage} from '../../../shared/types/headerMetrics';
import type {CodexRuntime} from '../runtime/server';
import {NULL_TOKENS, readTokenUsage} from '../runtime/tokenUsage';
import {buildCodexPromptOptions} from './promptOptions';

type BuildCodexPromptOptionsInput = Parameters<
	typeof buildCodexPromptOptions
>[0];

/**
 * Accumulates a single Codex Turn from the runtime's event stream.
 *
 * Codex runs as one long-lived JSON-RPC thread, so a Turn is not a child
 * process but the slice of events between `sendPrompt` and `turn.complete`.
 * This collector is the ONE place that interprets those events into a
 * {@link TurnExecutionResult}; both the interactive (Ink) and non-interactive
 * (exec) Codex paths feed it, so the spawn→accumulate→finalize semantics are
 * defined exactly once. See ADR 0007.
 */
export function createCodexTurnEventCollector(): {
	handle: (event: RuntimeEvent) => void;
	result: () => TurnExecutionResult;
	errorResult: (error: Error) => TurnExecutionResult;
} {
	let message = '';
	let tokenDelta: TokenUsage = {...NULL_TOKENS};
	let turnStatus: string | undefined;
	let turnErrorMessage: string | undefined;

	return {
		handle(event: RuntimeEvent): void {
			const data =
				typeof event.data === 'object'
					? (event.data as Record<string, unknown>)
					: {};

			if (event.kind === 'message.delta') {
				const delta = typeof data['delta'] === 'string' ? data['delta'] : '';
				message += delta;
			}

			if (event.kind === 'usage.update') {
				tokenDelta = readTokenUsage(data['delta']);
			}

			if (event.kind === 'turn.complete') {
				turnStatus =
					typeof data['status'] === 'string' ? data['status'] : turnStatus;
			}

			if (event.kind === 'unknown' && event.hookName === 'error') {
				const payload =
					typeof data['payload'] === 'object' && data['payload'] !== null
						? (data['payload'] as Record<string, unknown>)
						: null;
				const errorValue =
					typeof payload?.['error'] === 'object' && payload['error'] !== null
						? (payload['error'] as Record<string, unknown>)
						: null;
				if (typeof errorValue?.['message'] === 'string') {
					turnErrorMessage = errorValue['message'];
				}
			}
		},

		result(): TurnExecutionResult {
			if (turnStatus === 'failed') {
				return {
					exitCode: 1,
					error: new Error(turnErrorMessage ?? 'Codex turn failed'),
					tokens: tokenDelta,
					streamMessage: message || null,
				};
			}
			return {
				exitCode: 0,
				error: null,
				tokens: tokenDelta,
				streamMessage: message || null,
			};
		},

		errorResult(error: Error): TurnExecutionResult {
			return {
				exitCode: null,
				error,
				tokens: tokenDelta,
				streamMessage: message || null,
			};
		},
	};
}

/**
 * Run one Codex Turn against an available runtime.
 *
 * The single lifecycle shared by both Codex session-controller shapes: subscribe
 * to the event stream, send the prompt, and interpret the accumulated events
 * into a {@link TurnExecutionResult}. The caller owns the runtime-availability
 * guard, active-promise tracking, and (for the hook) React state — see ADR 0007.
 *
 * @param hooks.onError invoked with the normalized error if `sendPrompt` throws,
 * before the error result is returned (the interactive path uses it to emit a
 * lifecycle event).
 */
export async function runCodexTurn(
	runtime: CodexRuntime,
	prompt: string,
	optionsInput: BuildCodexPromptOptionsInput,
	hooks?: {onError?: (error: Error) => void},
): Promise<TurnExecutionResult> {
	const collector = createCodexTurnEventCollector();
	const unsubscribe = runtime.onEvent(collector.handle);
	try {
		await runtime.sendPrompt(prompt, buildCodexPromptOptions(optionsInput));
		return collector.result();
	} catch (error) {
		const normalized =
			error instanceof Error ? error : new Error(String(error));
		hooks?.onError?.(normalized);
		return collector.errorResult(normalized);
	} finally {
		unsubscribe();
	}
}
