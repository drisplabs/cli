import {describe, expect, it} from 'vitest';
import {getCodexInteractionHints} from '../interactionRules';

describe('getCodexInteractionHints', () => {
	it('waits indefinitely for approval and user-input decisions', () => {
		const hints = getCodexInteractionHints(true);
		expect(hints.expectsDecision).toBe(true);
		expect(hints.canBlock).toBe(true);
		expect(hints.defaultTimeoutMs).toBeNull();
	});

	it('keeps the short default for non-decision events', () => {
		const hints = getCodexInteractionHints(false);
		expect(hints.expectsDecision).toBe(false);
		expect(hints.canBlock).toBe(false);
		expect(hints.defaultTimeoutMs).toBe(4_000);
	});
});
