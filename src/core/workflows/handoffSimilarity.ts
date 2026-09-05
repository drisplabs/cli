/**
 * Handoff similarity (ADR 0018 §1): how much a new Handoff file restates the
 * previous one in the chain. The Handoff is the session's own distillation,
 * so two consecutive near-identical distillations mean the session between
 * them produced nothing worth carrying — a signal the Journal hash cannot
 * give once the seed prompt has the fresh Turn edit the Journal anyway.
 *
 * Word-3-gram Jaccard: lower-case word tokens, shingled into 3-grams, the
 * intersection over the union of the two shingle sets. Pure and cheap; the
 * threshold that turns the number into a verdict is
 * `HANDOFF_NO_PROGRESS_SIMILARITY` in `types.ts`, with its measured basis.
 */

const SHINGLE_SIZE = 3;

function tokens(text: string): string[] {
	return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function shingles(words: string[], size: number): Set<string> {
	const out = new Set<string>();
	for (let i = 0; i + size <= words.length; i++) {
		out.add(words.slice(i, i + size).join(' '));
	}
	return out;
}

/**
 * Similarity of two Handoff texts in `[0, 1]`: 1 for identical text, 0 for
 * texts sharing no 3-gram. Texts too short to shingle at 3 degrade to the
 * largest shingle both can form, so two identical one-line Handoffs still
 * read as identical and two different ones as different.
 */
export function handoffSimilarity(a: string, b: string): number {
	const wordsA = tokens(a);
	const wordsB = tokens(b);
	const size = Math.min(SHINGLE_SIZE, wordsA.length, wordsB.length);
	if (size === 0) return wordsA.length === wordsB.length ? 1 : 0;
	const setA = shingles(wordsA, size);
	const setB = shingles(wordsB, size);
	let shared = 0;
	for (const shingle of setA) if (setB.has(shingle)) shared++;
	const union = setA.size + setB.size - shared;
	return union === 0 ? 1 : shared / union;
}
