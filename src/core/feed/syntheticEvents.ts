/**
 * Synthetic `RuntimeEvent` builders — for callers that need to feed a
 * harness-neutral event through `FeedMapper.mapEvent()` without an
 * originating hook payload. Mirrors `buildSyntheticNotificationEvent` in
 * `src/app/providers/useFeed.ts`, the first such precedent.
 *
 * Used by the Tracker → task-tool projection (ADR 0015 §7): the Runner
 * parses the Tracker's `## Units` table plus each unit record's frontmatter
 * (see `trackerReader.ts`'s `projectTrackerTasks`) and the app layer turns
 * that into `task.created`/`task.completed` events through this module, so
 * they flow through exactly the same `mapper.mapEvent()` path a live
 * `TodoWrite`/`TaskCreate`/`TaskUpdate` tool call would take.
 */

import {generateId} from '../../shared/utils/id';
import type {RuntimeEvent} from '../runtime/types';

export type SyntheticTaskEventKind = 'task.created' | 'task.completed';

export type SyntheticTaskEventData = {
	task_id: string;
	task_subject: string;
};

const HOOK_NAME_BY_KIND: Record<SyntheticTaskEventKind, string> = {
	'task.created': 'TaskCreated',
	'task.completed': 'TaskCompleted',
};

/**
 * Build a synthetic `task.created`/`task.completed` `RuntimeEvent` for a
 * task that did not arrive through a real tool call — e.g. one projected
 * from the Tracker's Dossier. Never persisted here; the caller decides
 * whether to record the resulting `FeedEvent[]` (e.g. via
 * `SessionStore.recordFeedEvents`).
 */
export function buildSyntheticTaskEvent(
	kind: SyntheticTaskEventKind,
	sessionId: string,
	data: SyntheticTaskEventData,
): RuntimeEvent {
	const hookName = HOOK_NAME_BY_KIND[kind];
	return {
		id: `${kind}-${generateId()}`,
		timestamp: Date.now(),
		kind,
		data,
		hookName,
		sessionId,
		context: {cwd: '', transcriptPath: ''},
		interaction: {expectsDecision: false},
		payload: {
			hook_event_name: hookName,
			session_id: sessionId,
			transcript_path: '',
			cwd: '',
			...data,
		},
	};
}
