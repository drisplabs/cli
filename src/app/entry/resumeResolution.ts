import crypto from 'node:crypto';
import {
	getLatestRunForSession,
	getMostRecentAthenaSession,
	getSessionMeta,
} from '../../infra/sessions/index';
import type {AthenaSession} from '../../infra/sessions/index';

/**
 * Shared resume-target resolution for the interactive and headless entry
 * points. Both modes translate their CLI flags into a {@link ResumeRequest} and
 * resolve it here, so the fresh / explicit / most-recent branches and the
 * `adapterSessionIds.at(-1)` handoff live in one place.
 *
 * The single knob where the two modes deliberately differ is
 * {@link MissingRecentPolicy}: when a "resume most recent" request finds no
 * prior Athena session, headless exec errors and interactive starts fresh.
 * Historically that divergence was an accident of two hand-rolled resolvers;
 * it is now an explicit parameter each mode selects on purpose.
 */

export type MissingRecentPolicy = 'error' | 'fresh';

export type ResumeRequest =
	| {kind: 'fresh'}
	| {kind: 'most-recent'}
	| {kind: 'explicit'; sessionId: string};

export type ResumeTarget = {
	athenaSessionId: string;
	adapterResumeSessionId: string | undefined;
	/**
	 * Set when the resumed session's most recent Workflow Run is suspended in
	 * `awaiting_attention` (ADR 0014): the Runner reuses this run id so the
	 * suspended Run itself returns to `running` instead of a new run row
	 * appearing beside a forever-suspended one.
	 */
	resumeRunId?: string;
};

export type ResumeResolutionMessages = {
	/** Logged when an explicit session id is not found (always an error). */
	unknownExplicit: (sessionId: string) => string;
	/**
	 * Logged when a most-recent resume finds no prior session — under both
	 * policies (before erroring, or before falling back to a fresh session).
	 */
	missingRecent: string;
};

export type ResolveResumeTargetInput = {
	projectDir: string;
	request: ResumeRequest;
	missingRecentPolicy: MissingRecentPolicy;
	messages: ResumeResolutionMessages;
	logError: (message: string) => void;
	createSessionId?: () => string;
	getSessionMetaFn?: typeof getSessionMeta;
	getMostRecentSessionFn?: typeof getMostRecentAthenaSession;
	getLatestRunFn?: typeof getLatestRunForSession;
};

export function resolveResumeTarget(
	input: ResolveResumeTargetInput,
): ResumeTarget | undefined {
	const createSessionId = input.createSessionId ?? crypto.randomUUID;
	const getSessionMetaFn = input.getSessionMetaFn ?? getSessionMeta;
	const getMostRecentSessionFn =
		input.getMostRecentSessionFn ?? getMostRecentAthenaSession;
	const getLatestRunFn = input.getLatestRunFn ?? getLatestRunForSession;

	// A session whose most recent Workflow Run is suspended in
	// `awaiting_attention` resumes THAT Run's Agent Session (the one that
	// asked), not merely the last adapter session observed — and carries the
	// run id so the suspended Run returns to `running` (ADR 0014 §6).
	function toTarget(meta: AthenaSession): ResumeTarget {
		const latestRun = getLatestRunFn(meta.id);
		if (latestRun?.status === 'awaiting_attention') {
			return {
				athenaSessionId: meta.id,
				adapterResumeSessionId:
					latestRun.adapterSessionId ?? meta.adapterSessionIds.at(-1),
				resumeRunId: latestRun.id,
			};
		}
		return {
			athenaSessionId: meta.id,
			adapterResumeSessionId: meta.adapterSessionIds.at(-1),
		};
	}

	const {request} = input;

	if (request.kind === 'fresh') {
		return {
			athenaSessionId: createSessionId(),
			adapterResumeSessionId: undefined,
		};
	}

	if (request.kind === 'explicit') {
		const meta = getSessionMetaFn(request.sessionId);
		if (!meta) {
			input.logError(input.messages.unknownExplicit(request.sessionId));
			return undefined;
		}
		return toTarget(meta);
	}

	// request.kind === 'most-recent'
	const recent = getMostRecentSessionFn(input.projectDir);
	if (!recent) {
		input.logError(input.messages.missingRecent);
		if (input.missingRecentPolicy === 'fresh') {
			return {
				athenaSessionId: createSessionId(),
				adapterResumeSessionId: undefined,
			};
		}
		return undefined;
	}
	return toTarget(recent);
}
