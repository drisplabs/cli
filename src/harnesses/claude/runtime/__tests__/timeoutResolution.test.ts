import {describe, it, expect} from 'vitest';
import {resolveAdapterTimeoutMs} from '../timeoutResolution';

describe('resolveAdapterTimeoutMs', () => {
	const FALLBACK = 270_000;

	it('returns the explicit timeout when a number is provided', () => {
		expect(
			resolveAdapterTimeoutMs({defaultTimeoutMs: 1000} as never, FALLBACK),
		).toBe(1000);
	});

	it('returns the fallback when defaultTimeoutMs is undefined', () => {
		expect(resolveAdapterTimeoutMs({} as never, FALLBACK)).toBe(FALLBACK);
	});

	it('returns null when defaultTimeoutMs is null (wait indefinitely)', () => {
		// Null signals human-in-the-loop. The caller must NOT schedule an
		// auto-decision timer — Claude waits until the human answers.
		expect(
			resolveAdapterTimeoutMs({defaultTimeoutMs: null} as never, FALLBACK),
		).toBeNull();
	});
});
