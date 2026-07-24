import {describe, expect, it} from 'vitest';
import {classifyTurnFailure} from './failureTaxonomy';

describe('classifyTurnFailure', () => {
	it.each([
		['API Error: 429 {"error":{"type":"rate_limit_error"}}', 'rate_limit'],
		['Rate limit exceeded, retry after 60s', 'rate_limit'],
		['API Error: 529 {"error":{"type":"overloaded_error"}}', 'overloaded'],
		['upstream overloaded, try again later', 'overloaded'],
		['API Error: 500 internal server error', 'server_error'],
		['502 Bad Gateway', 'server_error'],
		['503 Service Unavailable', 'server_error'],
		['fetch failed: ECONNRESET', 'network'],
		['getaddrinfo ENOTFOUND api.anthropic.com', 'network'],
		['socket hang up', 'network'],
	])('classifies %j as transient/%s', (message, code) => {
		expect(classifyTurnFailure({errorMessage: message})).toEqual({
			kind: 'transient',
			code,
		});
	});

	it.each([
		['API Error: 401 {"error":{"type":"authentication_error"}}', 'auth'],
		['Invalid API key. Please run /login', 'auth'],
		['OAuth token has expired', 'auth'],
		['API Error: 402 payment required', 'billing'],
		['Your credit balance is too low', 'billing'],
		['model claude-nonexistent not found', 'model_not_found'],
		[
			'API Error: 400 {"error":{"type":"invalid_request_error"}}',
			'invalid_request',
		],
	])('classifies %j as hard/%s', (message, code) => {
		expect(classifyTurnFailure({errorMessage: message})).toEqual({
			kind: 'hard',
			code,
		});
	});

	it('treats an unclassifiable failure as hard — escalate, do not retry blindly', () => {
		expect(
			classifyTurnFailure({errorMessage: 'something inexplicable happened'}),
		).toEqual({kind: 'hard', code: 'unclassified'});
		expect(classifyTurnFailure({})).toEqual({
			kind: 'hard',
			code: 'unclassified',
		});
	});

	it('reads stderr when the error message alone is uninformative', () => {
		expect(
			classifyTurnFailure({
				errorMessage: 'Process exited with code 1',
				lastStderr: 'API Error: 429 rate_limit_error',
			}),
		).toEqual({kind: 'transient', code: 'rate_limit'});
	});

	it('specific hard classes win over generic status patterns', () => {
		// 401 inside a message that also says "request" must be auth, not
		// invalid_request; billing language wins over a bare 400.
		expect(
			classifyTurnFailure({errorMessage: '401 unauthorized invalid request'}),
		).toEqual({kind: 'hard', code: 'auth'});
		expect(
			classifyTurnFailure({
				errorMessage: '400 insufficient credits for this request',
			}),
		).toEqual({kind: 'hard', code: 'billing'});
	});
});
