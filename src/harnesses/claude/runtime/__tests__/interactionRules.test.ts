import {describe, it, expect} from 'vitest';
import {getInteractionHints} from '../interactionRules';

describe('getInteractionHints', () => {
	it('returns correct hints for known event types', () => {
		const perm = getInteractionHints('permission.request');
		expect(perm.expectsDecision).toBe(true);
		expect(perm.canBlock).toBe(true);
		expect(perm.defaultTimeoutMs).toBe(300_000);

		const pre = getInteractionHints('tool.pre');
		expect(pre.expectsDecision).toBe(true);
		expect(pre.defaultTimeoutMs).toBe(300_000);

		const post = getInteractionHints('tool.post');
		expect(post.expectsDecision).toBe(false);
		expect(post.canBlock).toBe(false);

		const stop = getInteractionHints('stop.request');
		expect(stop.expectsDecision).toBe(true);
		expect(stop.canBlock).toBe(true);
		expect(stop.defaultTimeoutMs).toBe(4000);
	});

	it('returns safe defaults for unknown events', () => {
		const unknown = getInteractionHints('FutureNewEvent');
		expect(unknown.expectsDecision).toBe(false);
		expect(unknown.canBlock).toBe(false);
		expect(unknown.defaultTimeoutMs).toBe(4000);
	});

	it('AskUserQuestion waits indefinitely (no auto-passthrough)', () => {
		// AskUserQuestion is the human-in-the-loop tool. Sharing the 5-minute
		// permission timeout caused the runtime to fire a passthrough decision
		// before the user could answer, after which Claude exited and the
		// workflow loop ticked a fresh iteration that lost the question.
		const ask = getInteractionHints('tool.pre', 'AskUserQuestion');
		expect(ask.expectsDecision).toBe(true);
		expect(ask.canBlock).toBe(true);
		expect(ask.defaultTimeoutMs).toBeNull();
	});

	it('non-AskUserQuestion tool.pre keeps the permission timeout', () => {
		const bashPre = getInteractionHints('tool.pre', 'Bash');
		expect(bashPre.defaultTimeoutMs).toBe(300_000);
	});
});
