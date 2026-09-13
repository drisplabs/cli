import {expect, it} from 'vitest';
import {createCodexTurnEventCollector} from './turnRunner';
import type {RuntimeEvent} from '../../../core/runtime/types';

it('accounts every request in a Turn without billing earlier Turns or duplicate notifications', () => {
	const collector = createCodexTurnEventCollector();
	function report(total: number, last: number) {
		collector.handle({
			kind: 'usage.update',
			data: {
				usage: {total, input: total},
				delta: {total: last, input: last, contextSize: last},
			},
		} as RuntimeEvent);
	}
	report(1100, 100); // The previous Turn used 1000.
	report(1300, 200); // This invocation has now used 300.
	report(1300, 200); // Duplicate notification.
	expect(collector.result().tokens).toMatchObject({
		total: 300,
		input: 300,
		contextSize: 200,
		openingContextSize: 100,
	});
});

it('ignores usage replayed by thread resume before the new Turn starts', () => {
	const collector = createCodexTurnEventCollector();
	const report = (id: string, total: number, last: number) =>
		collector.handle({
			kind: 'usage.update',
			data: {
				turn_id: id,
				usage: {total, input: total},
				delta: {total: last, input: last, contextSize: last},
			},
		} as RuntimeEvent);
	report('old', 1000, 200);
	expect(collector.result().tokens.total).toBeNull();
	collector.handle({
		kind: 'turn.start',
		data: {turn_id: 'new'},
	} as RuntimeEvent);
	report('new', 1100, 100);
	expect(collector.result().tokens.total).toBe(100);
});
