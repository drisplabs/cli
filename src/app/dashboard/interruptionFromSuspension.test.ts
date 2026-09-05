import {describe, expect, it} from 'vitest';
import {InterruptionSchema} from '@drisp/protocol';
import {interruptionFromSuspension} from './interruptionFromSuspension';

describe('interruptionFromSuspension', () => {
	it.each([
		{
			stopReason: 'agent declared NEEDS_HUMAN',
			expected: {kind: 'blocked'},
		},
		{
			stopReason: 'agent declared NEEDS_HUMAN: need the staging creds',
			expected: {kind: 'blocked', reason: 'need the staging creds'},
		},
		{
			stopReason: 'agent declared WORKFLOW_BLOCKED: pre-0.6 marker spelling',
			expected: {kind: 'blocked', reason: 'pre-0.6 marker spelling'},
		},
		{
			stopReason: 'agent asked a question with no human attached to answer',
			expected: {kind: 'question'},
		},
		{
			stopReason:
				'agent asked a question with no human attached to answer: Which branch? | Ship now?',
			expected: {kind: 'question', question: 'Which branch? | Ship now?'},
		},
		{
			stopReason:
				'agent requested sandbox approval (Bash) with no human attached to answer — rerun with a more permissive --isolation, or wake with guidance',
			expected: {kind: 'question'},
		},
		{
			stopReason:
				'permission request (Bash) unanswered within the grace window (60s); deferred: git push origin main — wake with --answer=allow|deny, or rerun with --isolation autonomous',
			expected: {kind: 'question', question: 'Bash: git push origin main'},
		},
		{
			stopReason:
				'permission request (Edit) deferred immediately (no hub attached to answer): src/index.ts — wake with --answer=allow|deny, or rerun with --isolation autonomous',
			expected: {kind: 'question', question: 'Edit: src/index.ts'},
		},
		{
			stopReason:
				'ask rule "mcp__github__*" fired on mcp__github__create_pull_request unanswered within the grace window (500ms); deferred: title: Ship it — wake with --answer=allow|deny',
			expected: {
				kind: 'question',
				question: 'mcp__github__create_pull_request: title: Ship it',
			},
		},
		{
			stopReason: 'ask rule "Bash" fired on Bash — needs a human',
			expected: {kind: 'question'},
		},
		{
			stopReason:
				'hard failure (auth): 401 unauthorized — not retried; needs a human',
			expected: {kind: 'hard_failure', code: 'auth'},
		},
		{
			stopReason:
				'hard failure (something_new): boom — not retried; needs a human',
			expected: {kind: 'hard_failure', code: 'unclassified'},
		},
		{
			stopReason:
				'retry cap reached: 3 transient failures (retryCap); last (rate_limit): 429',
			expected: {kind: 'cap_exhausted', cap: 'retry', limit: 3},
		},
		{
			stopReason:
				'nudge cap reached: 2 nudges (nudgeCap) without tracker progress or a terminal marker',
			expected: {kind: 'cap_exhausted', cap: 'nudge', limit: 2},
		},
		{
			stopReason:
				'iteration ceiling reached: 20 iterations (maxIterations) used without a terminal marker',
			expected: {kind: 'cap_exhausted', cap: 'iterations', limit: 20},
		},
		{
			stopReason:
				"handover cap reached: 3 consecutive Handovers (handoverCap) without progress — journal unchanged. Raise loop.maxTurnTokenCount, shrink the workflow's baseline context, or shed the journal.",
			expected: {kind: 'cap_exhausted', cap: 'handover', limit: 3},
		},
	])('classifies "$stopReason"', ({stopReason, expected}) => {
		const interruption = interruptionFromSuspension(stopReason);
		expect(interruption).toMatchObject({...expected, message: stopReason});
		expect(InterruptionSchema.safeParse(interruption).success).toBe(true);
	});

	it('reports an unrecognised reason as blocked, keeping the sentence', () => {
		expect(
			interruptionFromSuspension('the moon is in the wrong phase'),
		).toEqual({
			kind: 'blocked',
			message: 'the moon is in the wrong phase',
			reason: 'the moon is in the wrong phase',
		});
	});

	it('tolerates a missing reason', () => {
		const interruption = interruptionFromSuspension(null);
		expect(interruption.kind).toBe('blocked');
		expect(interruption.message).toBe('workflow run awaiting attention');
		expect(InterruptionSchema.safeParse(interruption).success).toBe(true);
	});
});
