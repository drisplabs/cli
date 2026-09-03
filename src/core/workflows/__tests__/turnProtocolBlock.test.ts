import {describe, expect, it} from 'vitest';
import {createPhaseTracker, parseTurnProtocolBlock} from '../turnProtocolBlock';

const block = (...lines: string[]): string =>
	['<!-- TURN_PROTOCOL', ...lines, '-->'].join('\n');

const journal = (...parts: string[]): string =>
	['# Journal', '', '## Status', 'Working.', '', ...parts, ''].join('\n');

describe('parseTurnProtocolBlock', () => {
	it('reports a journal with no block as missing', () => {
		expect(parseTurnProtocolBlock(journal())).toEqual({kind: 'missing'});
		expect(parseTurnProtocolBlock('')).toEqual({kind: 'missing'});
	});

	it('parses the step name, index, and total', () => {
		const parsed = parseTurnProtocolBlock(
			journal(block('step: Build', 'step_index: 3', 'step_total: 5')),
		);
		expect(parsed).toEqual({
			kind: 'ok',
			step: {name: 'Build', index: 3, total: 5},
		});
	});

	it('parses a step with no index or total', () => {
		expect(parseTurnProtocolBlock(journal(block('step: Orient')))).toEqual({
			kind: 'ok',
			step: {name: 'Orient'},
		});
	});

	it('tolerates surrounding whitespace, a closing marker on the last line, and unknown keys', () => {
		const content = journal(
			'  <!-- TURN_PROTOCOL  ',
			'   step:   Verify the fix   ',
			'note: free text the runner ignores',
			'step_index: 4 -->',
		);
		expect(parseTurnProtocolBlock(content)).toEqual({
			kind: 'ok',
			step: {name: 'Verify the fix', index: 4},
		});
	});

	it('takes the last block when the journal carries more than one', () => {
		const content = journal(
			block('step: Orient', 'step_index: 1'),
			'',
			block('step: Build', 'step_index: 2'),
		);
		expect(parseTurnProtocolBlock(content)).toEqual({
			kind: 'ok',
			step: {name: 'Build', index: 2},
		});
	});

	it.each([
		['no step line', block('step_index: 2'), /step/],
		['an empty step name', block('step:   '), /step/],
		[
			'a non-integer index',
			block('step: Build', 'step_index: two'),
			/step_index/,
		],
		['a zero index', block('step: Build', 'step_index: 0'), /step_index/],
		['a negative total', block('step: Build', 'step_total: -1'), /step_total/],
		[
			'an index past the total',
			block('step: Build', 'step_index: 6', 'step_total: 5'),
			/step_index.*step_total/,
		],
		['an unterminated block', '<!-- TURN_PROTOCOL\nstep: Build\n', /closed/],
	])('reports %s as malformed', (_label, text, reason) => {
		const parsed = parseTurnProtocolBlock(journal(text));
		expect(parsed.kind).toBe('malformed');
		if (parsed.kind !== 'malformed') throw new Error('unreachable');
		expect(parsed.reason).toMatch(reason);
	});
});

describe('createPhaseTracker', () => {
	it('reports a new step the first time it is named and nothing while it stays the same', () => {
		const tracker = createPhaseTracker();
		expect(
			tracker.observe(journal(block('step: Orient', 'step_index: 1'))),
		).toEqual({kind: 'new_step', step: {name: 'Orient', index: 1}});
		expect(
			tracker.observe(journal(block('step: Orient', 'step_index: 1'))),
		).toEqual({kind: 'same_step'});
	});

	it('reports a change of step name or index, not of total alone', () => {
		const tracker = createPhaseTracker();
		tracker.observe(
			journal(block('step: Build', 'step_index: 2', 'step_total: 4')),
		);
		expect(
			tracker.observe(
				journal(block('step: Build', 'step_index: 2', 'step_total: 5')),
			),
		).toEqual({kind: 'same_step'});
		expect(
			tracker.observe(
				journal(block('step: Build', 'step_index: 3', 'step_total: 5')),
			),
		).toEqual({
			kind: 'new_step',
			step: {name: 'Build', index: 3, total: 5},
		});
		expect(
			tracker.observe(
				journal(block('step: Verify', 'step_index: 3', 'step_total: 5')),
			),
		).toEqual({
			kind: 'new_step',
			step: {name: 'Verify', index: 3, total: 5},
		});
	});

	it('reports a missing block silently', () => {
		const tracker = createPhaseTracker();
		expect(tracker.observe(journal())).toEqual({kind: 'no_block'});
		expect(tracker.observe(journal())).toEqual({kind: 'no_block'});
	});

	it('warns once for a malformed block and keeps the last good step', () => {
		const tracker = createPhaseTracker();
		tracker.observe(journal(block('step: Build', 'step_index: 2')));

		const first = tracker.observe(journal(block('step_index: 3')));
		expect(first.kind).toBe('malformed');
		if (first.kind !== 'malformed') throw new Error('unreachable');
		expect(first.warning).toMatch(/TURN_PROTOCOL/);
		expect(first.warning).toMatch(/step/);

		// The same malformed block on the next Turn is not warned about again.
		const again = tracker.observe(journal(block('step_index: 3')));
		expect(again).toEqual({
			kind: 'malformed',
			reason: first.reason,
			warning: null,
		});

		// A different defect is a new warning.
		const other = tracker.observe(
			journal(block('step: Build', 'step_index: x')),
		);
		expect(other.kind).toBe('malformed');
		if (other.kind !== 'malformed') throw new Error('unreachable');
		expect(other.warning).not.toBeNull();

		// Repaired to the step already seen: no new phase.
		expect(
			tracker.observe(journal(block('step: Build', 'step_index: 2'))),
		).toEqual({kind: 'same_step'});
	});
});
