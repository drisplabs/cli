/**
 * `athena-flow runs` — the human-facing inbox for suspended Workflow Runs
 * (ADR 0014 §7). Lists every Run currently in `awaiting_attention`, with why
 * it suspended and the exact command that wakes it.
 *
 * This is the chosen human-resume entrypoint (issue #144): a CLI command,
 * matching the CLI-first shape of the tool. A dashboard inbox can layer on
 * the same registry read later.
 */

import {
	listAwaitingAttentionRuns,
	type AwaitingAttentionRun,
} from '../../infra/sessions/index';

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

function formatRun(run: AwaitingAttentionRun, nowMs: number): string {
	const lines: string[] = [];
	lines.push(
		`● ${run.workflowName ?? '(no workflow)'} — awaiting attention (${formatAge(
			nowMs,
			run.sessionUpdatedAt,
		)})`,
	);
	lines.push(`  session: ${run.athenaSessionId}`);
	lines.push(`  project: ${run.projectDir}`);
	if (run.stopReason) {
		lines.push(`  reason:  ${run.stopReason}`);
	}
	lines.push(
		`  wake it: athena-flow exec --continue=${run.athenaSessionId} "<your reply>"`,
	);
	return lines.join('\n');
}

export function runRunsCommand(input: RunsCommandInput): number {
	const log = input.log ?? console.log;
	const listRunsFn = input.listRunsFn ?? listAwaitingAttentionRuns;
	const runs = listRunsFn(input.projectDir);

	if (input.json) {
		log(JSON.stringify({awaitingAttention: runs}, null, 2));
		return 0;
	}

	if (runs.length === 0) {
		log('No workflow runs are awaiting attention.');
		return 0;
	}

	const now = Date.now();
	log(
		`${runs.length} workflow run${runs.length === 1 ? '' : 's'} awaiting attention:\n`,
	);
	for (const run of runs) {
		log(formatRun(run, now) + '\n');
	}
	return 0;
}
