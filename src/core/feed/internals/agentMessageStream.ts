// src/core/feed/internals/agentMessageStream.ts

import type {RuntimeEvent} from '../../runtime/types';
import type {
	FeedEvent,
	FeedEventCause,
	FeedEventKind,
	FeedEventLevel,
	AgentMessageData,
} from '../types';
import type {TranscriptReader} from '../transcript';
import {readString} from './projection';

export type EventBuilder = (
	kind: FeedEventKind,
	level: FeedEventLevel,
	actorId: string,
	data: unknown,
	runtimeEvent: RuntimeEvent,
	cause?: Partial<FeedEventCause>,
) => FeedEvent;

export type MessageScope = 'root' | 'subagent';

/**
 * Owns assistant-message buffering, deduplication, transcript replay, and
 * reasoning-summary accumulation.
 *
 * Dedup is per (actorId, scope) pair: identical normalized text from the same
 * actor scope is suppressed once. Reset when a new run begins (so the first
 * message of a new run never collides with the last message of the previous
 * run) and on explicit dedup reset.
 *
 * Pending messages buffer streaming `message.delta` events keyed by item_id
 * (or a legacy single-bucket fallback). A `message.complete` for the same
 * key flushes that bucket; a `turn.complete` flushes all buckets.
 */
export type AgentMessageStream = {
	emit(args: {
		runtimeEvent: RuntimeEvent;
		actorId: string;
		scope: MessageScope;
		message: string;
		source: 'hook' | 'transcript';
		cause?: Partial<FeedEventCause>;
		model?: string;
	}): FeedEvent | null;
	appendPendingDelta(
		itemId: string | undefined,
		delta: string,
		defaultActorId: string,
		defaultScope: MessageScope,
	): void;
	emitCompleted(args: {
		itemId: string | undefined;
		messageText: string | undefined;
		fallbackActorId: string;
		fallbackScope: MessageScope;
		runtimeEvent: RuntimeEvent;
	}): FeedEvent | null;
	flushPending(runtimeEvent: RuntimeEvent): FeedEvent[];
	emitTranscriptMessages(
		transcriptPath: string,
		runtimeEvent: RuntimeEvent,
		actorId: string,
		scope: MessageScope,
	): FeedEvent[];
	/**
	 * Replays new transcript assistant messages that belong BEFORE this hook
	 * event, so an emitted agent.message gets a lower seq than the event's own
	 * FeedEvents (e.g. tool.pre). Stop events are skipped here — they drain the
	 * transcript and fall back to last_assistant_message via {@link emitStopFallback}
	 * to avoid flush-timing duplicates. Returns [] when there is no transcript.
	 */
	replayBeforeEvent(
		runtimeEvent: RuntimeEvent,
		actorId: string,
		scope: MessageScope,
	): FeedEvent[];
	/**
	 * Stop-event message timing: drains the transcript (advancing the byte offset
	 * so the next event won't re-emit the same text), then emits a single fallback
	 * assistant message from `last_assistant_message` — unless an agent.message was
	 * already produced for this event (no duplication). The fallback is parented to
	 * the prior event of `parentKind` when present.
	 */
	emitStopFallback(
		runtimeEvent: RuntimeEvent,
		opts: {
			actorId: string;
			scope: MessageScope;
			parentKind: FeedEventKind;
			priorResults: readonly FeedEvent[];
		},
	): FeedEvent[];
	drainTranscript(transcriptPath: string): void;
	appendReasoningSummary(
		itemId: string | undefined,
		index: number | undefined,
		chunk: string,
	): string;
	clearPending(): void;
	resetDeduper(): void;
	resetForNewRun(): void;
};

function normalizeAgentMessage(message: string): string {
	return message.replace(/\r\n/g, '\n').trimEnd();
}

function agentMessageKey(actorId: string, scope: MessageScope): string {
	return `${actorId}\0${scope}`;
}

function isStopEvent(kind: RuntimeEvent['kind']): boolean {
	return kind === 'stop.request' || kind === 'subagent.stop';
}

export function createAgentMessageStream(
	eventBuilder: EventBuilder,
	transcriptReader: TranscriptReader,
): AgentMessageStream {
	const pendingMessages = new Map<
		string,
		{message: string; actorId: string; scope: MessageScope}
	>();
	const lastAgentMessageByActorScope = new Map<string, string>();
	const reasoningSummaryByKey = new Map<string, string>();

	function emit(args: {
		runtimeEvent: RuntimeEvent;
		actorId: string;
		scope: MessageScope;
		message: string;
		source: 'hook' | 'transcript';
		cause?: Partial<FeedEventCause>;
		model?: string;
	}): FeedEvent | null {
		const normalized = normalizeAgentMessage(args.message);
		if (!normalized) return null;

		const key = agentMessageKey(args.actorId, args.scope);
		if (lastAgentMessageByActorScope.get(key) === normalized) return null;

		const data: AgentMessageData = {
			message: normalized,
			source: args.source,
			scope: args.scope,
			...(args.model ? {model: args.model} : {}),
		};
		const event = eventBuilder(
			'agent.message',
			'info',
			args.actorId,
			data,
			args.runtimeEvent,
			args.cause,
		);
		lastAgentMessageByActorScope.set(key, normalized);
		return event;
	}

	function emitTranscriptMessages(
		transcriptPath: string,
		runtimeEvent: RuntimeEvent,
		actorId: string,
		scope: MessageScope,
	): FeedEvent[] {
		const msgs = transcriptReader.readNewAssistantMessages(transcriptPath);
		const out: FeedEvent[] = [];
		for (const msg of msgs) {
			const ev = emit({
				runtimeEvent,
				actorId,
				scope,
				message: msg.text,
				source: 'transcript',
				model: msg.model,
			});
			if (ev) out.push(ev);
		}
		return out;
	}

	function drainTranscript(transcriptPath: string): void {
		transcriptReader.readNewAssistantMessages(transcriptPath);
	}

	return {
		emit,
		appendPendingDelta(itemId, delta, defaultActorId, defaultScope) {
			if (!delta) return;
			const key = itemId ?? '__legacy_root__';
			const existing = pendingMessages.get(key);
			if (existing) {
				existing.message += delta;
				return;
			}
			pendingMessages.set(key, {
				message: delta,
				actorId: defaultActorId,
				scope: defaultScope,
			});
		},
		emitCompleted({
			itemId,
			messageText,
			fallbackActorId,
			fallbackScope,
			runtimeEvent,
		}) {
			const key = itemId ?? '__legacy_root__';
			const pending = pendingMessages.get(key);
			const message = messageText ?? pending?.message ?? '';
			pendingMessages.delete(key);
			if (!message) return null;
			const actorId = pending?.actorId ?? fallbackActorId;
			const scope = pending?.scope ?? fallbackScope;
			return emit({
				runtimeEvent,
				actorId,
				scope,
				message,
				source: 'hook',
			});
		},
		flushPending(runtimeEvent) {
			const out: FeedEvent[] = [];
			for (const [key, pending] of pendingMessages) {
				if (pending.message) {
					const ev = emit({
						runtimeEvent,
						actorId: pending.actorId,
						scope: pending.scope,
						message: pending.message,
						source: 'hook',
					});
					if (ev) out.push(ev);
				}
				pendingMessages.delete(key);
			}
			return out;
		},
		emitTranscriptMessages,
		replayBeforeEvent(runtimeEvent, actorId, scope) {
			const transcriptPath = runtimeEvent.context.transcriptPath;
			if (!transcriptPath || isStopEvent(runtimeEvent.kind)) return [];
			return emitTranscriptMessages(
				transcriptPath,
				runtimeEvent,
				actorId,
				scope,
			);
		},
		emitStopFallback(runtimeEvent, opts) {
			const transcriptPath = runtimeEvent.context.transcriptPath;
			if (transcriptPath) drainTranscript(transcriptPath);
			if (opts.priorResults.some(r => r.kind === 'agent.message')) return [];
			const message = readString(
				(runtimeEvent.data as Record<string, unknown>)[
					'last_assistant_message'
				],
			);
			if (!message) return [];
			const parent = opts.priorResults.find(r => r.kind === opts.parentKind);
			const ev = emit({
				runtimeEvent,
				actorId: opts.actorId,
				scope: opts.scope,
				message,
				source: 'hook',
				cause: parent ? {parent_event_id: parent.event_id} : undefined,
			});
			return ev ? [ev] : [];
		},
		drainTranscript,
		appendReasoningSummary(itemId, index, chunk) {
			const key = `${itemId ?? ''}:${index ?? 0}`;
			const next = `${reasoningSummaryByKey.get(key) ?? ''}${chunk}`;
			reasoningSummaryByKey.set(key, next);
			return next;
		},
		clearPending() {
			pendingMessages.clear();
		},
		resetDeduper() {
			lastAgentMessageByActorScope.clear();
		},
		resetForNewRun() {
			// Note: pendingMessages is intentionally NOT cleared here. The original
			// ensureRunArray only reset dedup + reasoning state on run rollover; the
			// orchestrator clears pendingMessages explicitly in session.start /
			// session.end / turn.start. Clearing here would drop in-flight Codex
			// message.delta buffers when a rollover fires mid-stream.
			lastAgentMessageByActorScope.clear();
			reasoningSummaryByKey.clear();
		},
	};
}
