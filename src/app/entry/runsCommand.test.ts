import {describe, expect, it, vi} from 'vitest';
import {runRunsCommand} from './runsCommand';
import type {AwaitingAttentionRun} from '../../infra/sessions/index';

function makeRun(
	overrides: Partial<AwaitingAttentionRun> = {},
): AwaitingAttentionRun {
	return {
		athenaSessionId: 'athena-1',
		projectDir: '/proj/a',
		runId: 'run-1',
		workflowName: 'default',
		stopReason: 'agent declared WORKFLOW_BLOCKED: which env?',
		adapterSessionId: 'claude-sess-1',
		startedAt: Date.now() - 60_000,
		sessionUpdatedAt: Date.now() - 60_000,
		...overrides,
	};
}

describe('runRunsCommand', () => {
	it('prints the parked-run inbox with reason and the wake command', () => {
		const lines: string[] = [];
		const exitCode = runRunsCommand({
			json: false,
			log: message => lines.push(message),
			listRunsFn: () => [makeRun()],
		});

		const output = lines.join('\n');
		expect(exitCode).toBe(0);
		expect(output).toContain('1 workflow run parked, awaiting attention');
		expect(output).toContain('default — Parked, awaiting attention');
		expect(output).toContain('session: athena-1');
		expect(output).toContain('which env?');
		expect(output).toContain('drisp run --continue=athena-1 "<your reply>"');
	});

	it('shows which ask rule parked a Run (#189)', () => {
		const lines: string[] = [];
		runRunsCommand({
			json: false,
			log: message => lines.push(message),
			listRunsFn: () => [
				makeRun({
					stopReason:
						'ask rule "mcp__github__*" fired on mcp__github__create_pull_request — needs a human',
				}),
			],
		});
		const output = lines.join('\n');
		expect(output).toContain('Parked');
		expect(output).toContain('reason:  ask rule "mcp__github__*" fired on');
	});

	it('shows the pending question of a run parked on a deferred permission, and how to answer it (#190)', () => {
		const lines: string[] = [];
		runRunsCommand({
			json: false,
			log: message => lines.push(message),
			listRunsFn: () => [
				makeRun({
					stopReason:
						'permission request (Bash) unanswered within the grace window (60s); deferred: git push origin main',
					interruption: {
						kind: 'question',
						message:
							'permission request (Bash) unanswered within the grace window (60s); deferred: git push origin main',
						requestId: 'req-42',
						question: 'Bash: git push origin main',
					},
				}),
			],
		});

		const output = lines.join('\n');
		expect(output).toContain('question: Bash: git push origin main');
		expect(output).toContain('request:  req-42');
		// A stored answer is replayed into the re-asked call on continue.
		expect(output).toContain(
			'drisp run --continue=athena-1 --answer=allow "<your reply>"',
		);
	});

	it('says so when nothing is parked', () => {
		const lines: string[] = [];
		runRunsCommand({
			json: false,
			log: message => lines.push(message),
			listRunsFn: () => [],
		});
		expect(lines.join('\n')).toContain(
			'No workflow runs are parked awaiting attention.',
		);
	});

	it('emits machine-readable JSON with --json', () => {
		const log = vi.fn();
		runRunsCommand({
			json: true,
			log,
			listRunsFn: () => [makeRun()],
		});
		const parsed = JSON.parse(log.mock.calls[0]![0] as string) as {
			awaitingAttention: AwaitingAttentionRun[];
		};
		expect(parsed.awaitingAttention).toHaveLength(1);
		expect(parsed.awaitingAttention[0]!.runId).toBe('run-1');
	});
});
