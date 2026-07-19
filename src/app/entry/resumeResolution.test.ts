import {describe, expect, it, vi} from 'vitest';
import {resolveResumeTarget} from './resumeResolution';
import type {AthenaSession} from '../../infra/sessions/types';

function makeSession(overrides: Partial<AthenaSession> = {}): AthenaSession {
	return {
		id: overrides.id ?? 'athena-1',
		projectDir: overrides.projectDir ?? '/tmp',
		createdAt: overrides.createdAt ?? 0,
		updatedAt: overrides.updatedAt ?? 0,
		adapterSessionIds: overrides.adapterSessionIds ?? [
			'adapter-1',
			'adapter-2',
		],
	};
}

const MESSAGES = {
	unknownExplicit: (id: string) => `unknown: ${id}`,
	missingRecent: 'no recent session',
};

describe('resolveResumeTarget', () => {
	it('starts a fresh session for a fresh request', () => {
		const result = resolveResumeTarget({
			projectDir: '/tmp',
			request: {kind: 'fresh'},
			missingRecentPolicy: 'error',
			messages: MESSAGES,
			logError: vi.fn(),
			createSessionId: () => 'fresh-id',
		});

		expect(result).toEqual({
			athenaSessionId: 'fresh-id',
			adapterResumeSessionId: undefined,
		});
	});

	it('resolves an explicit session id to its last adapter session', () => {
		const result = resolveResumeTarget({
			projectDir: '/tmp',
			request: {kind: 'explicit', sessionId: 'athena-x'},
			missingRecentPolicy: 'error',
			messages: MESSAGES,
			logError: vi.fn(),
			getSessionMetaFn: () =>
				makeSession({id: 'athena-x', adapterSessionIds: ['a-1', 'a-2']}),
		});

		expect(result).toEqual({
			athenaSessionId: 'athena-x',
			adapterResumeSessionId: 'a-2',
		});
	});

	it('errors on an unknown explicit session id under either policy', () => {
		for (const policy of ['error', 'fresh'] as const) {
			const logError = vi.fn();
			const result = resolveResumeTarget({
				projectDir: '/tmp',
				request: {kind: 'explicit', sessionId: 'missing'},
				missingRecentPolicy: policy,
				messages: MESSAGES,
				logError,
				getSessionMetaFn: () => null,
			});

			expect(result).toBeUndefined();
			expect(logError).toHaveBeenCalledWith('unknown: missing');
		}
	});

	it('resolves the most recent session to its last adapter session', () => {
		const result = resolveResumeTarget({
			projectDir: '/tmp',
			request: {kind: 'most-recent'},
			missingRecentPolicy: 'error',
			messages: MESSAGES,
			logError: vi.fn(),
			getMostRecentSessionFn: () =>
				makeSession({id: 'athena-recent', adapterSessionIds: ['r-1']}),
		});

		expect(result).toEqual({
			athenaSessionId: 'athena-recent',
			adapterResumeSessionId: 'r-1',
		});
	});

	// ── The explicit resume-policy divergence (the named fix) ──
	// Both modes reach the SAME "resume-most-recent, none found" branch; they
	// only differ in this one policy parameter. Interactive chooses 'fresh',
	// headless exec chooses 'error'. Before this parameter existed the two
	// behaviours were hand-rolled in separate functions and diverged by accident.

	it('under the error policy, a missing most-recent session logs and returns undefined', () => {
		const logError = vi.fn();
		const result = resolveResumeTarget({
			projectDir: '/tmp',
			request: {kind: 'most-recent'},
			missingRecentPolicy: 'error',
			messages: MESSAGES,
			logError,
			createSessionId: () => 'should-not-be-used',
			getMostRecentSessionFn: () => null,
		});

		expect(result).toBeUndefined();
		expect(logError).toHaveBeenCalledWith('no recent session');
	});

	it('under the fresh policy, a missing most-recent session logs and starts a new session', () => {
		const logError = vi.fn();
		const result = resolveResumeTarget({
			projectDir: '/tmp',
			request: {kind: 'most-recent'},
			missingRecentPolicy: 'fresh',
			messages: MESSAGES,
			logError,
			createSessionId: () => 'fresh-after-miss',
			getMostRecentSessionFn: () => null,
		});

		expect(result).toEqual({
			athenaSessionId: 'fresh-after-miss',
			adapterResumeSessionId: undefined,
		});
		expect(logError).toHaveBeenCalledWith('no recent session');
	});
});
