import {describe, expect, it} from 'vitest';
import {getCodexUsageDelta, getCodexUsageTotals} from './tokenUsage';

describe('Codex token usage mapping', () => {
	it('maps total billing tokens and derives current context usage', () => {
		const usage = getCodexUsageTotals({
			total: {
				totalTokens: 240_000,
				inputTokens: 200_000,
				cachedInputTokens: 12_000,
				outputTokens: 40_000,
				reasoningOutputTokens: 6_400,
			},
			last: {
				totalTokens: 0,
				inputTokens: 0,
				cachedInputTokens: 0,
				outputTokens: 0,
				reasoningOutputTokens: 0,
			},
			modelContextWindow: 200_000,
		});

		expect(usage).toEqual({
			input: 188_000,
			output: 40_000,
			cacheRead: 12_000,
			cacheWrite: null,
			total: 240_000,
			contextSize: 0,
			contextWindowSize: 200_000,
		});
	});

	it('maps last-turn deltas with current context occupancy', () => {
		const usage = getCodexUsageDelta({
			total: {
				totalTokens: 0,
				inputTokens: 0,
				cachedInputTokens: 0,
				outputTokens: 0,
				reasoningOutputTokens: 0,
			},
			last: {
				totalTokens: 1_300,
				inputTokens: 900,
				cachedInputTokens: 100,
				outputTokens: 400,
				reasoningOutputTokens: 100,
			},
			modelContextWindow: 400_000,
		});

		expect(usage).toEqual({
			input: 800,
			output: 400,
			cacheRead: 100,
			cacheWrite: null,
			total: 1_300,
			contextSize: 900,
			contextWindowSize: 400_000,
		});
	});
});

it('preserves native compaction context estimates with no token components', () => {
	const compacted = {
		totalTokens: 24090,
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningOutputTokens: 0,
	};
	expect(
		getCodexUsageDelta({
			total: compacted,
			last: compacted,
			modelContextWindow: 100000,
		}).contextSize,
	).toBe(24090);
});

it('normalizes the observed live request without double counting subsets', () => {
	const request = {
		totalTokens: 25329,
		inputTokens: 25083,
		cachedInputTokens: 5504,
		outputTokens: 246,
		reasoningOutputTokens: 22,
	};
	expect(
		getCodexUsageDelta({
			total: request,
			last: request,
			modelContextWindow: 100000,
		}),
	).toMatchObject({
		input: 19579,
		cacheRead: 5504,
		output: 246,
		total: 25329,
		contextSize: 25083,
	});
});
