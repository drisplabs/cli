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
	it('prints the suspended-run inbox with reason and the wake command', () => {
		const lines: string[] = [];
		const exitCode = runRunsCommand({
			json: false,
			log: message => lines.push(message),
			listRunsFn: () => [makeRun()],
		});

		const output = lines.join('\n');
		expect(exitCode).toBe(0);
		expect(output).toContain('1 workflow run awaiting attention');
		expect(output).toContain('default — awaiting attention');
		expect(output).toContain('session: athena-1');
		expect(output).toContain('which env?');
		expect(output).toContain(
			'athena-flow exec --continue=athena-1 "<your reply>"',
		);
	});

	it('says so when nothing awaits attention', () => {
		const lines: string[] = [];
		runRunsCommand({
			json: false,
			log: message => lines.push(message),
			listRunsFn: () => [],
		});
		expect(lines.join('\n')).toContain(
			'No workflow runs are awaiting attention.',
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
