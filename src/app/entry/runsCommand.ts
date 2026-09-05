/**
 * `drisp runs` — the human-facing inbox for parked Workflow Runs (ADR 0014
 * §7). Lists every Run currently in `awaiting_attention`, with why it parked
 * — which ask rule fired, or the `NEEDS_HUMAN` reason (#189) — and the exact
 * command that wakes it.
 *
 * This is the chosen human-resume entrypoint (issue #144): a CLI command,
 * matching the CLI-first shape of the tool. A dashboard inbox can layer on
 * the same registry read later.
 */

import {
	listAwaitingAttentionRuns,
	type AwaitingAttentionRun,
} from '../../infra/sessions/index';
import {deserializeRunMemory} from '../../core/workflows/runMachine';

export type RunsCommandInput = {
	/** Restrict to Runs whose session belongs to this project directory. */
	projectDir?: string;
	json: boolean;
	log?: (message: string) => void;
	listRunsFn?: typeof listAwaitingAttentionRuns;
};

function formatAge(nowMs: number, thenMs: number): string {
	const minutes = Math.max(0, Math.round((nowMs - thenMs) / 60_000));
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

/** The Run's cumulative token total, when its persisted memory carries one (ADR 0018 §10). */
function cumulativeTokensOf(run: AwaitingAttentionRun): number | undefined {
	const total = deserializeRunMemory(run.runMemoryJson)?.cumulativeTokens;
	return typeof total === 'number' ? total : undefined;
}

function formatRun(run: AwaitingAttentionRun, nowMs: number): string {
	const lines: string[] = [];
	lines.push(
		`● ${run.workflowName ?? '(no workflow)'} — Parked, awaiting attention (${formatAge(
			nowMs,
			run.sessionUpdatedAt,
		)})`,
	);
	lines.push(`  session: ${run.athenaSessionId}`);
	lines.push(`  project: ${run.projectDir}`);
	if (run.stopReason) {
		lines.push(`  reason:  ${run.stopReason}`);
	}
	// Burn so far, budget or no budget (ADR 0018 §10).
	const tokens = cumulativeTokensOf(run);
	if (tokens !== undefined) {
		lines.push(`  tokens:  ${tokens.toLocaleString('en-US')}`);
	}
	// A Run parked on a deferred question (#190) shows what was asked and
	// which request an answer addresses; the wake command then carries the
	// answer, which is replayed into the re-asked call without a prompt.
	const question =
		run.interruption?.kind === 'question' ? run.interruption : undefined;
	if (question?.question) {
		lines.push(`  question: ${question.question}`);
	}
	if (question?.requestId) {
		lines.push(`  request:  ${question.requestId}`);
	}
	const answerFlag = question?.requestId ? ' --answer=allow' : '';
	lines.push(
		`  wake it: drisp run --continue=${run.athenaSessionId}${answerFlag} "<your reply>"`,
	);
	return lines.join('\n');
}

export function runRunsCommand(input: RunsCommandInput): number {
	const log = input.log ?? console.log;
	const listRunsFn = input.listRunsFn ?? listAwaitingAttentionRuns;
	const runs = listRunsFn(input.projectDir);

	if (input.json) {
		const awaitingAttention = runs.map(run => {
			const cumulativeTokens = cumulativeTokensOf(run);
			return cumulativeTokens === undefined ? run : {...run, cumulativeTokens};
		});
		log(JSON.stringify({awaitingAttention}, null, 2));
		return 0;
	}

	if (runs.length === 0) {
		log('No workflow runs are parked awaiting attention.');
		return 0;
	}

	const now = Date.now();
	log(
		`${runs.length} workflow run${runs.length === 1 ? '' : 's'} parked, awaiting attention:\n`,
	);
	for (const run of runs) {
		log(formatRun(run, now) + '\n');
	}
	return 0;
}
