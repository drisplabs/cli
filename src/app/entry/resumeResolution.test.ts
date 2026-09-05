import {describe, expect, it, vi} from 'vitest';
import {resolveResumeTarget} from './resumeResolution';
import type {AthenaSession} from '../../infra/sessions/types';
import {serializeRunMemory} from '../../core/workflows/runMachine';
import type {RunMemory} from '../../core/workflows/runMachine';

function memoryJson(overrides: Partial<RunMemory> = {}): string {
	return serializeRunMemory({
		iteration: 3,
		nudgeStreak: 0,
		retryStreak: 0,
		lastJournalHash: null,
		lastStopPrompt: 'x',
		lastStopContinuation: {mode: 'fresh'},
		pendingSteers: [],
		lastHandoffSizeBytes: null,
		parkedAfterHandover: false,
		...overrides,
	});
}

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

	it('targets a suspended run: its Agent Session id and run id (ADR 0014)', () => {
		const result = resolveResumeTarget({
			projectDir: '/tmp',
			request: {kind: 'explicit', sessionId: 'athena-x'},
			missingRecentPolicy: 'error',
			messages: MESSAGES,
			logError: vi.fn(),
			getSessionMetaFn: () =>
				makeSession({id: 'athena-x', adapterSessionIds: ['a-1', 'a-2']}),
			getLatestRunFn: () => ({
				id: 'run-suspended',
				sessionId: 'athena-x',
				startedAt: 0,
				iteration: 3,
				maxIterations: 20,
				status: 'awaiting_attention',
				stopReason: 'agent declared WORKFLOW_BLOCKED: which env?',
				// The run's own captured session — deliberately NOT the last
				// adapter session observed on the Athena Session.
				adapterSessionId: 'a-1',
			}),
		});

		expect(result).toEqual({
			athenaSessionId: 'athena-x',
			adapterResumeSessionId: 'a-1',
			resumeRunId: 'run-suspended',
		});
	});

	it('wakes a run parked right after a Handover into a fresh Agent Session, keeping its run id (ADR 0018 §9)', () => {
		const result = resolveResumeTarget({
			projectDir: '/tmp',
			request: {kind: 'explicit', sessionId: 'athena-x'},
			missingRecentPolicy: 'error',
			messages: MESSAGES,
			logError: vi.fn(),
			getSessionMetaFn: () =>
				makeSession({id: 'athena-x', adapterSessionIds: ['a-1', 'a-2']}),
			getLatestRunFn: () => ({
				id: 'run-parked-after-handover',
				sessionId: 'athena-x',
				startedAt: 0,
				iteration: 3,
				maxIterations: 3,
				status: 'awaiting_attention',
				stopReason:
					'iteration ceiling reached: 3 iterations (maxIterations) used without a terminal marker',
				// The captured session is the killed one (or the fork): at its
				// context bound, so resuming it would re-trip compaction at once.
				adapterSessionId: 'a-2',
				runMemoryJson: memoryJson({parkedAfterHandover: true}),
			}),
		});

		expect(result).toEqual({
			athenaSessionId: 'athena-x',
			adapterResumeSessionId: undefined,
			resumeRunId: 'run-parked-after-handover',
		});
	});

	it('keeps resuming the captured session for a run parked on any other row', () => {
		const result = resolveResumeTarget({
			projectDir: '/tmp',
			request: {kind: 'explicit', sessionId: 'athena-x'},
			missingRecentPolicy: 'error',
			messages: MESSAGES,
			logError: vi.fn(),
			getSessionMetaFn: () =>
				makeSession({id: 'athena-x', adapterSessionIds: ['a-1', 'a-2']}),
			getLatestRunFn: () => ({
				id: 'run-parked',
				sessionId: 'athena-x',
				startedAt: 0,
				iteration: 3,
				maxIterations: 20,
				status: 'awaiting_attention',
				stopReason:
					'nudge cap reached: 3 nudges (nudgeCap) without journal progress or a terminal marker',
				adapterSessionId: 'a-1',
				runMemoryJson: memoryJson({parkedAfterHandover: false}),
			}),
		});

		expect(result).toEqual({
			athenaSessionId: 'athena-x',
			adapterResumeSessionId: 'a-1',
			resumeRunId: 'run-parked',
		});
	});

	it('falls back to the last adapter session when the suspended run captured no id', () => {
		const result = resolveResumeTarget({
			projectDir: '/tmp',
			request: {kind: 'most-recent'},
			missingRecentPolicy: 'error',
			messages: MESSAGES,
			logError: vi.fn(),
			getMostRecentSessionFn: () =>
				makeSession({id: 'athena-r', adapterSessionIds: ['r-1', 'r-2']}),
			getLatestRunFn: () => ({
				id: 'run-suspended',
				sessionId: 'athena-r',
				startedAt: 0,
				iteration: 1,
				maxIterations: 20,
				status: 'awaiting_attention',
			}),
		});

		expect(result).toEqual({
			athenaSessionId: 'athena-r',
			adapterResumeSessionId: 'r-2',
			resumeRunId: 'run-suspended',
		});
	});

	it('ignores a non-suspended latest run (plain resume keeps its behaviour)', () => {
		const result = resolveResumeTarget({
			projectDir: '/tmp',
			request: {kind: 'explicit', sessionId: 'athena-x'},
			missingRecentPolicy: 'error',
			messages: MESSAGES,
			logError: vi.fn(),
			getSessionMetaFn: () =>
				makeSession({id: 'athena-x', adapterSessionIds: ['a-1', 'a-2']}),
			getLatestRunFn: () => ({
				id: 'run-done',
				sessionId: 'athena-x',
				startedAt: 0,
				iteration: 2,
				maxIterations: 20,
				status: 'completed',
				adapterSessionId: 'a-1',
			}),
		});

		expect(result).toEqual({
			athenaSessionId: 'athena-x',
			adapterResumeSessionId: 'a-2',
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
