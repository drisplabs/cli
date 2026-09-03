/**
 * Hold, then park, then replay (#190) — the pure helpers behind the exec
 * runner's handling of a permission request nobody answers in time.
 *
 * - **Hold**: a permission request that no rule answers is held for the
 *   grace window so an attached hub can answer it.
 * - **Defer**: when the window elapses unanswered, the tool call is refused
 *   with a "deferred" result (`deferredPermissionDecision`) and the Turn
 *   ends; the Run parks on an Interruption that records the request id and
 *   a one-line summary of the call (`summarizeToolInput`).
 * - **Replay**: on continue the agent re-issues the call. The runner
 *   recognises it by the same tool and input summary (`matchesParkedCall`)
 *   and replays the stored answer into it without prompting.
 *
 * Nothing here touches timers, the runtime, or the store; `runner.ts` owns
 * those.
 */

import type {Interruption} from '@drisp/protocol';
import type {RuntimeDecision, RuntimeEvent} from '../../core/runtime/types';

const SUMMARY_MAX_CHARS = 160;

/**
 * Input keys whose value is the call, in the order a human would name it:
 * a Bash `command`, a file tool's path, a fetch's `url`, a search's `query`
 * or `pattern`, an agent's `prompt` or `description`.
 */
const PREFERRED_INPUT_KEYS = [
	'command',
	'file_path',
	'path',
	'notebook_path',
	'url',
	'query',
	'pattern',
	'prompt',
	'description',
] as const;

function truncate(text: string): string {
	const oneLine = text.replace(/\s+/g, ' ').trim();
	return oneLine.length > SUMMARY_MAX_CHARS
		? `${oneLine.slice(0, SUMMARY_MAX_CHARS - 1)}…`
		: oneLine;
}

/**
 * A deterministic one-line summary of a permission request's tool input —
 * the "input summary" the Interruption carries and the key a re-issued call
 * is matched on. The same event yields the same summary on both sides of a
 * park, which is what makes the match safe: an answer is only ever replayed
 * into a call that asks for the same thing.
 */
export function summarizeToolInput(event: RuntimeEvent): string {
	const data = event.data as Record<string, unknown>;
	const input = data['tool_input'];
	if (typeof input !== 'object' || input === null) return '(no input)';
	const record = input as Record<string, unknown>;
	for (const key of PREFERRED_INPUT_KEYS) {
		const value = record[key];
		if (typeof value === 'string' && value.trim().length > 0) {
			return truncate(value);
		}
	}
	const pairs = Object.entries(record)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}=${JSON.stringify(value)}`);
	if (pairs.length === 0) return '(no input)';
	return truncate(pairs.join(' '));
}

/** The call as a parked `question` Interruption names it: `<tool>: <summary>`. */
export function describeCall(toolName: string, inputSummary: string): string {
	return `${toolName}: ${inputSummary}`;
}

/**
 * The "deferred" result a held permission is refused with once the grace
 * window elapses: a deny whose reason tells the agent the call was not
 * refused on its merits — the Run is parking for a human, and the call is to
 * be re-issued on continue.
 */
export function deferredPermissionDecision(input: {
	toolName: string;
	graceMs: number;
}): RuntimeDecision {
	const window =
		input.graceMs > 0
			? `no answer within the ${formatGrace(input.graceMs)} grace window`
			: 'no hub attached to answer';
	return {
		type: 'json',
		source: 'timeout',
		intent: {
			kind: 'permission_deny',
			reason: `deferred: ${window} — the run is parking until a human answers this ${input.toolName} request; it will be re-issued on continue`,
		},
	};
}

function formatGrace(ms: number): string {
	return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}

/**
 * Does a re-issued call ask for the same thing the Run parked on? True only
 * for a `question` Interruption that carries a request id (a deferred
 * permission) whose recorded call equals `<tool>: <summary>` of the new one.
 */
export function matchesParkedCall(
	parked: Interruption | undefined,
	toolName: string,
	inputSummary: string,
): parked is Extract<Interruption, {kind: 'question'}> & {requestId: string} {
	return (
		parked?.kind === 'question' &&
		typeof parked.requestId === 'string' &&
		parked.question === describeCall(toolName, inputSummary)
	);
}

/** How a stored answer reads in a notice: `allow`, `deny`, or its intent kind. */
export function describeAnswer(decision: RuntimeDecision): string {
	const intent = decision.intent;
	if (!intent) return decision.type;
	if (intent.kind === 'permission_allow') return 'allow';
	if (intent.kind === 'permission_deny') return 'deny';
	return intent.kind;
}

/** The `RuntimeDecision` a `--answer=allow|deny` given on the command line stands for. */
export function localAnswerDecision(answer: 'allow' | 'deny'): RuntimeDecision {
	return answer === 'allow'
		? {type: 'json', source: 'user', intent: {kind: 'permission_allow'}}
		: {
				type: 'json',
				source: 'user',
				intent: {
					kind: 'permission_deny',
					reason: 'denied by a human on drisp run --continue --answer=deny',
				},
			};
}
