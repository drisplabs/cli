import {describe, it, expect} from 'vitest';
import {getInteractionHints} from '../interactionRules';

describe('getInteractionHints', () => {
	it('returns correct hints for known event types', () => {
		const perm = getInteractionHints('permission.request');
		expect(perm.expectsDecision).toBe(true);
		expect(perm.canBlock).toBe(true);
		expect(perm.defaultTimeoutMs).toBeNull();

		const pre = getInteractionHints('tool.pre');
		expect(pre.expectsDecision).toBe(true);
		expect(pre.defaultTimeoutMs).toBeNull();

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
		const ask = getInteractionHints('tool.pre', 'AskUserQuestion');
		expect(ask.expectsDecision).toBe(true);
		expect(ask.canBlock).toBe(true);
		expect(ask.defaultTimeoutMs).toBeNull();
	});

	it('non-AskUserQuestion tool.pre also waits indefinitely', () => {
		const bashPre = getInteractionHints('tool.pre', 'Bash');
		expect(bashPre.defaultTimeoutMs).toBeNull();
	});

	it('compact.pre is decision-bearing and blockable, with a finite timeout', () => {
		// Handover interception (ADR 0014). Both claims are required — canBlock
		// alone leaves the event off the decision-waiting path. The timeout must
		// stay finite: it is the degrade-to-vendor-compaction safety fallback.
		const compactPre = getInteractionHints('compact.pre');
		expect(compactPre.expectsDecision).toBe(true);
		expect(compactPre.canBlock).toBe(true);
		expect(compactPre.defaultTimeoutMs).toBe(4000);
	});

	it('elicitation requests wait indefinitely', () => {
		const elicitation = getInteractionHints('elicitation.request');
		expect(elicitation.expectsDecision).toBe(true);
		expect(elicitation.canBlock).toBe(true);
		expect(elicitation.defaultTimeoutMs).toBeNull();
	});
});
