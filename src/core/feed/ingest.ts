/**
 * Feed ingest core.
 *
 * Concentrates the controller-rule-match → mapper-projection →
 * persist-with-degradation sequence that exec mode and the interactive UI
 * both run on every RuntimeEvent / RuntimeDecision. Callers retain ownership
 * of the runtime subscription and any side channels (JSONL output, perf
 * cycles, UI store push, queue dequeues), but no longer reproduce the
 * matching/mapping/persist trio.
 *
 * On a persistence failure, the store is marked degraded and the same
 * formatted message is forwarded to `onPersistFailure` if provided. Callers
 * that surface failures elsewhere (exec → output.warn) supply that callback;
 * the UI hook ignores it because `isDegraded` propagates via the store.
 */

import {
	handleEvent,
	type ControllerCallbacks,
} from '../controller/runtimeController';
import type {RuntimeDecision, RuntimeEvent} from '../runtime/types';
import type {SessionStore} from '../../infra/sessions/store';
import type {FeedMapper} from './mapper';
import type {FeedEvent} from './types';

export type IngestEventContext = {
	mapper: FeedMapper;
	store?: SessionStore | undefined;
	controllerCallbacks: ControllerCallbacks;
	onPersistFailure?: (message: string) => void;
};

export type IngestEventResult = {
	feedEvents: FeedEvent[];
	/**
	 * Decision derived from rule matching. The caller is responsible for
	 * forwarding it to `runtime.sendDecision(event.id, decision)` — the ingest
	 * core has no runtime handle.
	 */
	decision: RuntimeDecision | null;
};

export function ingestRuntimeEvent(
	event: RuntimeEvent,
	ctx: IngestEventContext,
): IngestEventResult {
	const controllerResult = handleEvent(event, ctx.controllerCallbacks);
	const feedEvents = ctx.mapper.mapEvent(event);
	if (ctx.store) {
		persistOrDegrade(
			ctx.store,
			() => ctx.store!.recordEvent(event, feedEvents),
			'recordEvent failed',
			ctx.onPersistFailure,
		);
	}
	return {
		feedEvents,
		decision:
			controllerResult.handled && controllerResult.decision
				? controllerResult.decision
				: null,
	};
}

export type IngestDecisionContext = {
	mapper: FeedMapper;
	store?: SessionStore | undefined;
	onPersistFailure?: (message: string) => void;
};

export function ingestRuntimeDecision(
	eventId: string,
	decision: RuntimeDecision,
	ctx: IngestDecisionContext,
): FeedEvent | null {
	const feedEvent = ctx.mapper.mapDecision(eventId, decision);
	if (feedEvent && ctx.store) {
		persistOrDegrade(
			ctx.store,
			() => ctx.store!.recordFeedEvents([feedEvent]),
			'recordFeedEvents failed',
			ctx.onPersistFailure,
		);
	}
	return feedEvent;
}

function persistOrDegrade(
	store: SessionStore,
	action: () => void,
	label: string,
	onFailure: ((message: string) => void) | undefined,
): void {
	try {
		action();
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		const message = `${label}: ${reason}`;
		store.markDegraded(message);
		onFailure?.(message);
	}
}
