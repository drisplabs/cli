import {
	HardFailureCodeSchema,
	type ExhaustedCap,
	type Interruption,
} from '@drisp/protocol';

/**
 * Classify the Runner's `run.suspended` stop reason into the Interruption a
 * `needs_human` frame carries.
 *
 * The Runner reports why a Workflow Run parked in `awaiting_attention` as one
 * human sentence (`terminalOutcome.ts`, `runMachine.ts`, `exec/runner.ts`
 * each own a family of them). This is the one place that reads those
 * sentences back into the protocol's structured shape, so a wording change
 * there is caught by this module's tests rather than silently degrading the
 * hub's view of the Run.
 *
 * Anything unrecognised is reported as `blocked` with the raw sentence as its
 * reason: the Run did park for a human, and the message says why.
 */
const CAP_BY_BOUND: Record<string, ExhaustedCap> = {
	'retry cap': 'retry',
	'nudge cap': 'nudge',
	'iteration ceiling': 'iterations',
	'handover cap': 'handover',
};

/** A capture group that may not have participated in the match. */
function group(match: RegExpExecArray, index: number): string | undefined {
	return match[index];
}

export function interruptionFromSuspension(
	stopReason: string | null | undefined,
): Interruption {
	const message = stopReason?.trim() || 'workflow run awaiting attention';

	// `NEEDS_HUMAN` is the marker; `WORKFLOW_BLOCKED` is its pre-0.6 spelling,
	// still accepted by the Runner for one release.
	const blocked =
		/^agent declared (?:NEEDS_HUMAN|WORKFLOW_BLOCKED)(?::\s*(.*))?$/s.exec(
			message,
		);
	if (blocked) {
		const reason = group(blocked, 1)?.trim();
		return {kind: 'blocked', message, ...(reason ? {reason} : {})};
	}

	const question =
		/^agent asked a question with no human attached to answer(?::\s*(.*))?$/s.exec(
			message,
		);
	if (question) {
		const text = group(question, 1)?.trim();
		return {kind: 'question', message, ...(text ? {question: text} : {})};
	}
	if (/^agent requested sandbox approval\b/.test(message)) {
		return {kind: 'question', message};
	}

	// A permission held for the grace window and then deferred (#190), or an
	// ask rule that claimed one (#189): a question for a human about a tool
	// call. The call itself sits between the deferral clause and the wake hint.
	const deferred =
		/^permission request \((.+?)\) (?:unanswered within the grace window \([^)]*\); deferred|deferred immediately \([^)]*\)): (.*?)(?: — wake with .*)?$/s.exec(
			message,
		) ??
		/^ask rule ".*?" fired on (\S+?)(?: unanswered within the grace window \([^)]*\); deferred| deferred immediately \([^)]*\)): (.*?)(?: — wake with .*)?$/s.exec(
			message,
		);
	if (deferred) {
		const tool = group(deferred, 1);
		const call = group(deferred, 2)?.trim();
		return {
			kind: 'question',
			message,
			...(tool && call ? {question: `${tool}: ${call}`} : {}),
		};
	}
	if (/^ask rule ".*?" fired on \S+ — needs a human$/.test(message)) {
		return {kind: 'question', message};
	}

	const hard = /^hard failure \(([a-z_]+)\)/.exec(message);
	if (hard) {
		const parsed = HardFailureCodeSchema.safeParse(group(hard, 1));
		return {
			kind: 'hard_failure',
			message,
			code: parsed.success ? parsed.data : 'unclassified',
		};
	}

	// Every exhausted bound opens with its name and its limit as the first
	// integer (`terminalOutcome.ts`, `runMachine.ts`); the Handover cap joined
	// the family in ADR 0018.
	const cap =
		/^(retry cap|nudge cap|iteration ceiling|handover cap) reached:\s*(\d+)\b/.exec(
			message,
		);
	if (cap) {
		const limit = Number.parseInt(group(cap, 2) ?? '', 10);
		return {
			kind: 'cap_exhausted',
			message,
			cap: CAP_BY_BOUND[group(cap, 1) ?? ''] ?? 'iterations',
			...(Number.isFinite(limit) && limit > 0 ? {limit} : {}),
		};
	}

	return {kind: 'blocked', message, reason: message};
}
