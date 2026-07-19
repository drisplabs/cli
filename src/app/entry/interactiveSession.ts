import {
	getMostRecentAthenaSession,
	getSessionMeta,
} from '../../infra/sessions/index';
import {resolveResumeTarget, type ResumeRequest} from './resumeResolution';

export type ResolveInteractiveSessionInput = {
	projectDir: string;
	resumeSessionId?: string;
	resumeMostRecent: boolean;
	logError?: (message: string) => void;
	createSessionId?: () => string;
	getSessionMetaFn?: typeof getSessionMeta;
	getMostRecentSessionFn?: typeof getMostRecentAthenaSession;
};

export type InteractiveSessionResolution = {
	athenaSessionId: string;
	initialSessionId: string | undefined;
};

export function resolveInteractiveSession(
	input: ResolveInteractiveSessionInput,
): InteractiveSessionResolution | undefined {
	const request: ResumeRequest = input.resumeSessionId
		? {kind: 'explicit', sessionId: input.resumeSessionId}
		: input.resumeMostRecent
			? {kind: 'most-recent'}
			: {kind: 'fresh'};

	const target = resolveResumeTarget({
		projectDir: input.projectDir,
		request,
		// Interactive falls back to a fresh session when resume-most-recent finds
		// no history — the terminal stays usable rather than exiting.
		missingRecentPolicy: 'fresh',
		messages: {
			unknownExplicit: sessionId =>
				`Unknown session ID: ${sessionId}\n` +
				`Use 'athena-flow sessions' to choose an available session.`,
			missingRecent: 'No previous sessions found. Starting new session.',
		},
		logError: input.logError ?? console.error,
		...(input.createSessionId ? {createSessionId: input.createSessionId} : {}),
		...(input.getSessionMetaFn
			? {getSessionMetaFn: input.getSessionMetaFn}
			: {}),
		...(input.getMostRecentSessionFn
			? {getMostRecentSessionFn: input.getMostRecentSessionFn}
			: {}),
	});

	if (!target) return undefined;
	return {
		athenaSessionId: target.athenaSessionId,
		initialSessionId: target.adapterResumeSessionId,
	};
}
