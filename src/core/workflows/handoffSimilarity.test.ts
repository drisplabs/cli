import {describe, expect, it} from 'vitest';
import {handoffSimilarity} from './handoffSimilarity';
import {HANDOFF_NO_PROGRESS_SIMILARITY} from './types';

const BASE = [
	'# Handoff',
	'',
	'## Task and status',
	'Migrate the billing service to the new ledger API. The adapter compiles;',
	'the contract tests still fail on refunds because the ledger rejects a',
	'negative amount. Decided to model a refund as a reversal entry instead.',
	'',
	'## Files touched',
	'src/billing/adapter.ts, src/billing/adapter.test.ts, docs/ledger.md',
	'',
	'## Open questions',
	'Whether partial refunds need two reversal entries or one with a ratio.',
].join('\n');

describe('handoffSimilarity (word-3-gram Jaccard, ADR 0018 §1)', () => {
	it('identical texts are fully similar', () => {
		expect(handoffSimilarity(BASE, BASE)).toBe(1);
	});

	it('disjoint texts share nothing', () => {
		expect(
			handoffSimilarity(
				'alpha beta gamma delta epsilon zeta',
				'one two three four five six',
			),
		).toBe(0);
	});

	it('is insensitive to case, punctuation and whitespace', () => {
		expect(
			handoffSimilarity(
				'Hello, World!  Fold the   handoff.',
				'hello world fold the handoff',
			),
		).toBe(1);
	});

	it('a near-duplicate with a few changed lines lands above the no-progress threshold', () => {
		const nearDuplicate = BASE.replace(
			'The adapter compiles;',
			'The adapter still compiles;',
		).replace('two reversal entries or one', 'two reversal entries, or one');
		const similarity = handoffSimilarity(BASE, nearDuplicate);
		expect(similarity).toBeGreaterThanOrEqual(HANDOFF_NO_PROGRESS_SIMILARITY);
		expect(similarity).toBeLessThan(1);
	});

	it('an ordinary rewrite after real work lands below the threshold', () => {
		const rewrite = [
			'# Handoff',
			'',
			'## Task and status',
			'Refunds are modelled as reversal entries and the contract tests pass.',
			'Started on the reconciliation report; the nightly job needs a cursor',
			'over ledger pages, which the client library does not expose yet.',
			'',
			'## Files touched',
			'src/billing/reversal.ts, src/reports/reconcile.ts, src/ledger/client.ts',
			'',
			'## Open questions',
			'Page size for the cursor, and whether to back-fill last month.',
		].join('\n');
		expect(handoffSimilarity(BASE, rewrite)).toBeLessThan(
			HANDOFF_NO_PROGRESS_SIMILARITY,
		);
	});

	it('degrades gracefully on texts too short to shingle', () => {
		expect(handoffSimilarity('', '')).toBe(1);
		expect(handoffSimilarity('one word', '')).toBe(0);
		expect(handoffSimilarity('two words', 'two words')).toBe(1);
		expect(handoffSimilarity('two words', 'other things')).toBe(0);
	});

	it('is symmetric', () => {
		const a = 'the quick brown fox jumps over the lazy dog';
		const b = 'the quick brown cat jumps over the lazy dog';
		expect(handoffSimilarity(a, b)).toBe(handoffSimilarity(b, a));
	});
});
