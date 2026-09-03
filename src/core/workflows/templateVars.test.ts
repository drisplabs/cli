import {describe, it, expect} from 'vitest';
import {substituteVariables} from './templateVars';

describe('substituteVariables', () => {
	it('substitutes {input}', () => {
		expect(substituteVariables('Execute: {input}', {input: 'ship it'})).toBe(
			'Execute: ship it',
		);
	});

	it('substitutes {sessionId} and <session_id>', () => {
		const text = 'Path: .athena/{sessionId}/journal.md and <session_id>';
		expect(substituteVariables(text, {sessionId: 'abc-123'})).toBe(
			'Path: .athena/abc-123/journal.md and abc-123',
		);
	});

	it('substitutes {journalPath}', () => {
		expect(
			substituteVariables('Read {journalPath}', {
				journalPath: '.athena/abc/journal.md',
			}),
		).toBe('Read .athena/abc/journal.md');
	});

	it('substitutes the legacy {trackerPath} placeholder with the journal path for one release', () => {
		expect(
			substituteVariables('Read {trackerPath} then {journalPath}', {
				journalPath: '.athena/abc/journal.md',
			}),
		).toBe('Read .athena/abc/journal.md then .athena/abc/journal.md');
	});

	it('substitutes all variables together', () => {
		const text = '{input} at {journalPath} in {sessionId}';
		expect(
			substituteVariables(text, {
				input: 'hello',
				sessionId: 's1',
				journalPath: '/t.md',
			}),
		).toBe('hello at /t.md in s1');
	});

	it('replaces all occurrences of each variable', () => {
		expect(
			substituteVariables('{sessionId} and {sessionId}', {sessionId: 'x'}),
		).toBe('x and x');
	});

	it('leaves text unchanged when context fields are undefined', () => {
		expect(substituteVariables('{input} {sessionId}', {})).toBe(
			'{input} {sessionId}',
		);
	});
});
