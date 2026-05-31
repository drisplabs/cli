import {describe, it, expect} from 'vitest';
import {
	HANDOFF_COMPACT_INSTRUCTIONS,
	HANDOFF_COMPACT_PROMPT,
} from './handoffInstructions';

describe('handoff compact instructions', () => {
	it('both variants are non-empty', () => {
		expect(HANDOFF_COMPACT_INSTRUCTIONS.trim().length).toBeGreaterThan(0);
		expect(HANDOFF_COMPACT_PROMPT.trim().length).toBeGreaterThan(0);
	});

	it('cover the handoff framing: task, decisions, files, next steps, secrets', () => {
		for (const text of [HANDOFF_COMPACT_INSTRUCTIONS, HANDOFF_COMPACT_PROMPT]) {
			expect(text).toMatch(/handoff/i);
			expect(text).toMatch(/decision/i);
			expect(text).toMatch(/open question/i);
			expect(text).toMatch(/next steps/i);
			expect(text).toMatch(/redact/i);
		}
	});

	it('the Claude variant augments rather than restates the summarizer', () => {
		// Phrased as an instruction to apply to "this conversation".
		expect(HANDOFF_COMPACT_INSTRUCTIONS).toMatch(/this conversation/i);
	});
});
