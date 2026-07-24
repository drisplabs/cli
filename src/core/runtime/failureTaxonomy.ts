/**
 * Failure taxonomy for Turn failures (ADR 0014 §4).
 *
 * A Turn result carries only a bare `Error`, an exit code, and a stderr line —
 * nothing distinguishes a rate limit from an auth failure, and
 * `HarnessProcessFailureCode` covers only spawn/startup faults. This module
 * classifies the harness's error output so the Runner can act on the class:
 *
 * - **transient** (`rate_limit` / `overloaded` / `server_error` / `network`)
 *   → wait a backoff, then resume the same Agent Session; the Run stays
 *   `running`.
 * - **hard** (`auth` / `billing` / `invalid_request` / `model_not_found`)
 *   → suspend to `awaiting_attention` immediately, no retry.
 * - **unclassifiable** → treated as hard (`unclassified`): escalate to a
 *   human rather than retry blindly.
 */

export type TransientFailureCode =
	| 'rate_limit'
	| 'overloaded'
	| 'server_error'
	| 'network';

export type HardFailureCode =
	| 'auth'
	| 'billing'
	| 'invalid_request'
	| 'model_not_found'
	| 'unclassified';

export type TurnFailureClassification =
	| {kind: 'transient'; code: TransientFailureCode}
	| {kind: 'hard'; code: HardFailureCode};

/**
 * Ordered rules: the first match wins, so specific classes are listed before
 * the generic status-code patterns they could collide with (e.g. `billing`
 * mentions of "credit" before a bare `4xx`, `model_not_found` before generic
 * `invalid_request`).
 */
const RULES: ReadonlyArray<{
	pattern: RegExp;
	classification: TurnFailureClassification;
}> = [
	// ── hard, specific ──
	{
		pattern:
			/\b401\b|authentication_error|unauthorized|invalid.?api.?key|api key.*(invalid|revoked|expired)|oauth token.*(expired|revoked)|not.?logged.?in|please.*log ?in/i,
		classification: {kind: 'hard', code: 'auth'},
	},
	{
		pattern:
			/\b402\b|billing|credit balance|insufficient.?(funds|credits?|quota)|payment required|plan limit/i,
		classification: {kind: 'hard', code: 'billing'},
	},
	{
		pattern: /model.{0,20}not.?(found|supported|available)|no such model/i,
		classification: {kind: 'hard', code: 'model_not_found'},
	},
	// ── transient ──
	{
		pattern: /\b429\b|rate.?limit/i,
		classification: {kind: 'transient', code: 'rate_limit'},
	},
	{
		pattern: /\b529\b|overloaded/i,
		classification: {kind: 'transient', code: 'overloaded'},
	},
	{
		pattern:
			/\b(500|502|503|504)\b|internal server error|bad gateway|service unavailable|gateway timeout|server_error|api_error/i,
		classification: {kind: 'transient', code: 'server_error'},
	},
	{
		pattern:
			/econnrefused|econnreset|etimedout|enotfound|eai_again|epipe|socket hang up|fetch failed|network error|connection (error|closed|refused|reset)/i,
		classification: {kind: 'transient', code: 'network'},
	},
	// ── hard, generic (after the specific hard + transient rules) ──
	{
		pattern: /\b400\b|invalid_request_error|invalid request|malformed request/i,
		classification: {kind: 'hard', code: 'invalid_request'},
	},
];

/**
 * Classify a failed Turn from its harness error output. Unclassifiable
 * failures are hard (`unclassified`) — escalate, don't retry blindly.
 */
export function classifyTurnFailure(input: {
	errorMessage?: string | null;
	lastStderr?: string | null;
}): TurnFailureClassification {
	const haystack = [input.errorMessage, input.lastStderr]
		.filter((part): part is string => typeof part === 'string')
		.join('\n');

	for (const rule of RULES) {
		if (rule.pattern.test(haystack)) {
			return rule.classification;
		}
	}
	return {kind: 'hard', code: 'unclassified'};
}
