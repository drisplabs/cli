import {describe, expect, it} from 'vitest';
import {
	buildPlainTextQuestionAnswer,
	parseQuestionAnswer,
	parseVerdict,
} from './verdict';

describe('parseVerdict', () => {
	it.each([
		['yes abcde', 'allow', 'abcde'],
		['no abcde', 'deny', 'abcde'],
		['y abcde', 'allow', 'abcde'],
		['n abcde', 'deny', 'abcde'],
		['  yes abcde  ', 'allow', 'abcde'],
		['Yes abcde', 'allow', 'abcde'],
		['NO abcde', 'deny', 'abcde'],
		['Yes Abcde', 'allow', 'abcde'],
	])('parses %j as %s %s', (input, behavior, id) => {
		const result = parseVerdict(input);
		expect(result).toEqual({channelRequestId: id, behavior});
	});

	it.each([
		'',
		'yes',
		'abcde',
		'maybe abcde',
		'yes abcd1', // digit in id
		'yes lloyd', // 'l' is excluded from the alphabet
		'yes abcdef', // 6 chars
		'yes abcd', // 4 chars
		'random message',
	])('rejects %j', input => {
		expect(parseVerdict(input)).toBeNull();
	});
});

describe('parseQuestionAnswer', () => {
	it('parses a single text answer for the first question key', () => {
		const result = parseQuestionAnswer('answer abcde push main', [
			'Which branch?',
		]);

		expect(result).toEqual({
			channelRequestId: 'abcde',
			answers: {'Which branch?': 'push main'},
		});
	});

	it('parses JSON answers', () => {
		const result = parseQuestionAnswer(
			'answer abcde {"Which branch?":"main","Confirm?":"yes"}',
			['Which branch?', 'Confirm?'],
		);

		expect(result).toEqual({
			channelRequestId: 'abcde',
			answers: {'Which branch?': 'main', 'Confirm?': 'yes'},
		});
	});

	it.each([
		'answer',
		'answer abcde',
		'answer abcd1 yes',
		'answer lloyd yes',
		'yes abcde',
	])('rejects %j', input => {
		expect(parseQuestionAnswer(input, ['Question?'])).toBeNull();
	});
});

describe('buildPlainTextQuestionAnswer', () => {
	it('uses the full message as the first question answer', () => {
		expect(
			buildPlainTextQuestionAnswer('abcde', 'Yes allow it', [
				'May I continue?',
			]),
		).toEqual({
			channelRequestId: 'abcde',
			answers: {'May I continue?': 'Yes allow it'},
		});
	});

	it('rejects empty messages or missing question keys', () => {
		expect(
			buildPlainTextQuestionAnswer('abcde', '   ', ['Question?']),
		).toBeNull();
		expect(buildPlainTextQuestionAnswer('abcde', 'yes', [])).toBeNull();
	});
});
