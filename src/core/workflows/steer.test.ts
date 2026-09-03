import {describe, expect, it, vi} from 'vitest';
import {
	buildSteerBlock,
	createSteerQueue,
	formatSteerJournalEntry,
	prependSteerBlock,
	STEER_BLOCK_END,
	STEER_BLOCK_OPEN,
	type QueuedSteer,
} from './steer';

const HUB_STEER: QueuedSteer = {
	text: 'use the other branch',
	origin: 'hub',
	receivedAt: Date.UTC(2026, 8, 3, 10, 0, 0),
};
const LOCAL_STEER: QueuedSteer = {
	text: 'and skip the docs',
	origin: 'local',
	receivedAt: Date.UTC(2026, 8, 3, 10, 5, 0),
};

describe('buildSteerBlock', () => {
	it('labels a single steer with its origin and delimits it', () => {
		const block = buildSteerBlock([HUB_STEER]);
		expect(block.startsWith(STEER_BLOCK_OPEN)).toBe(true);
		expect(block).toContain('via hub');
		expect(block).toContain('2026-09-03T10:00:00.000Z');
		expect(block).toContain('use the other branch');
		expect(block).toContain(STEER_BLOCK_END);
	});

	it('numbers several steers in arrival order', () => {
		const block = buildSteerBlock([HUB_STEER, LOCAL_STEER]);
		expect(block).toContain('1 of 2, via hub');
		expect(block).toContain('2 of 2, via local');
		expect(block.indexOf('use the other branch')).toBeLessThan(
			block.indexOf('and skip the docs'),
		);
	});
});

describe('prependSteerBlock', () => {
	it('puts the block at the head and the original prompt after it, unmerged', () => {
		const prompt = prependSteerBlock('Continue the workflow.', [HUB_STEER]);
		expect(prompt.startsWith(STEER_BLOCK_OPEN)).toBe(true);
		expect(prompt.endsWith('Continue the workflow.')).toBe(true);
		expect(prompt.indexOf(STEER_BLOCK_END)).toBeLessThan(
			prompt.indexOf('Continue the workflow.'),
		);
	});

	it('leaves a prompt untouched when there is nothing to deliver', () => {
		expect(prependSteerBlock('Continue.', [])).toBe('Continue.');
	});
});

describe('formatSteerJournalEntry', () => {
	it('records the origin, receipt time, delivered Turn, and the text', () => {
		const entry = formatSteerJournalEntry(HUB_STEER, 3);
		expect(entry).toContain('Human steer (via hub)');
		expect(entry).toContain('Turn 3');
		expect(entry).toContain('2026-09-03T10:00:00.000Z');
		expect(entry).toContain('> use the other branch');
	});

	it('quotes every line of a multi-line steer', () => {
		const entry = formatSteerJournalEntry(
			{...HUB_STEER, text: 'first\nsecond'},
			1,
		);
		expect(entry).toContain('> first\n> second');
	});
});

describe('createSteerQueue', () => {
	it('buffers steers pushed before anyone subscribes and flushes them in order', () => {
		const queue = createSteerQueue();
		queue.push(HUB_STEER);
		queue.push(LOCAL_STEER);
		const listener = vi.fn();
		queue.subscribe(listener);
		expect(listener.mock.calls.map(c => c[0])).toEqual([
			HUB_STEER,
			LOCAL_STEER,
		]);
	});

	it('delivers live to the subscriber and buffers again after unsubscribe', () => {
		const queue = createSteerQueue();
		const listener = vi.fn();
		const unsubscribe = queue.subscribe(listener);
		queue.push(HUB_STEER);
		expect(listener).toHaveBeenCalledTimes(1);
		unsubscribe();
		queue.push(LOCAL_STEER);
		expect(listener).toHaveBeenCalledTimes(1);
		const next = vi.fn();
		queue.subscribe(next);
		expect(next).toHaveBeenCalledWith(LOCAL_STEER);
	});
});
