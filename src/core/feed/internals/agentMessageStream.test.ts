import {describe, it, expect} from 'vitest';
import {
	createAgentMessageStream,
	type EventBuilder,
} from './agentMessageStream';
import type {RuntimeEvent} from '../../runtime/types';
import type {FeedEvent} from '../types';
import type {TranscriptMessage, TranscriptReader} from '../transcript';

let seq = 0;

function buildEvent(): EventBuilder {
	return (kind, level, actorId, data, runtimeEvent, cause) => {
		seq++;
		return {
			event_id: `evt-${seq}`,
			seq,
			ts: runtimeEvent.timestamp,
			session_id: runtimeEvent.sessionId,
			run_id: 'cs-1:R1',
			kind,
			level,
			actor_id: actorId,
			cause: {hook_request_id: runtimeEvent.id, ...cause},
			title: '',
			data,
		} as unknown as FeedEvent;
	};
}

function fakeTranscript(messages: TranscriptMessage[] = []): TranscriptReader {
	let drained = false;
	return {
		readNewAssistantMessages() {
			if (drained) return [];
			drained = true;
			return messages;
		},
		getOffset() {
			return 0;
		},
	};
}

function makeRuntimeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
	return {
		id: 'rt-1',
		timestamp: 1000,
		kind: 'message.delta',
		data: {},
		hookName: undefined,
		sessionId: 'cs-1',
		context: {cwd: '/tmp', transcriptPath: '/tmp/t.jsonl'},
		interaction: {expectsDecision: false},
		payload: {},
		...overrides,
	} as RuntimeEvent;
}

describe('agentMessageStream', () => {
	describe('emit', () => {
		it('returns null for an empty message', () => {
			const ams = createAgentMessageStream(buildEvent(), fakeTranscript());
			expect(
				ams.emit({
					runtimeEvent: makeRuntimeEvent(),
					actorId: 'agent:root',
					scope: 'root',
					message: '   \n',
					source: 'hook',
				}),
			).toBeNull();
		});

		it('emits an agent.message FeedEvent for a fresh message', () => {
			const ams = createAgentMessageStream(buildEvent(), fakeTranscript());
			const ev = ams.emit({
				runtimeEvent: makeRuntimeEvent(),
				actorId: 'agent:root',
				scope: 'root',
				message: 'hello world',
				source: 'hook',
			});
			expect(ev?.kind).toBe('agent.message');
			expect((ev?.data as {message: string}).message).toBe('hello world');
		});

		it('dedups identical normalized text from the same actor scope', () => {
			const ams = createAgentMessageStream(buildEvent(), fakeTranscript());
			const args = {
				runtimeEvent: makeRuntimeEvent(),
				actorId: 'agent:root',
				scope: 'root' as const,
				message: 'hello\r\n',
				source: 'hook' as const,
			};
			expect(ams.emit(args)).not.toBeNull();
			expect(ams.emit(args)).toBeNull();
		});

		it('does not dedup across different actor scopes', () => {
			const ams = createAgentMessageStream(buildEvent(), fakeTranscript());
			expect(
				ams.emit({
					runtimeEvent: makeRuntimeEvent(),
					actorId: 'agent:root',
					scope: 'root',
					message: 'shared',
					source: 'hook',
				}),
			).not.toBeNull();
			expect(
				ams.emit({
					runtimeEvent: makeRuntimeEvent(),
					actorId: 'subagent:foo',
					scope: 'subagent',
					message: 'shared',
					source: 'hook',
				}),
			).not.toBeNull();
		});

		it('resetDeduper allows the same text to be emitted again', () => {
			const ams = createAgentMessageStream(buildEvent(), fakeTranscript());
			const args = {
				runtimeEvent: makeRuntimeEvent(),
				actorId: 'agent:root',
				scope: 'root' as const,
				message: 'hi',
				source: 'hook' as const,
			};
			ams.emit(args);
			ams.resetDeduper();
			expect(ams.emit(args)).not.toBeNull();
		});
	});

	describe('pending message buffering', () => {
		it('appendPendingDelta then emitCompleted flushes the buffered message', () => {
			const ams = createAgentMessageStream(buildEvent(), fakeTranscript());
			ams.appendPendingDelta('item-1', 'hel', 'agent:root', 'root');
			ams.appendPendingDelta('item-1', 'lo', 'agent:root', 'root');
			const ev = ams.emitCompleted({
				itemId: 'item-1',
				messageText: undefined,
				fallbackActorId: 'agent:root',
				fallbackScope: 'root',
				runtimeEvent: makeRuntimeEvent(),
			});
			expect((ev?.data as {message: string}).message).toBe('hello');
		});

		it('emitCompleted with explicit messageText overrides the buffer', () => {
			const ams = createAgentMessageStream(buildEvent(), fakeTranscript());
			ams.appendPendingDelta('item-1', 'buffered', 'agent:root', 'root');
			const ev = ams.emitCompleted({
				itemId: 'item-1',
				messageText: 'override',
				fallbackActorId: 'agent:root',
				fallbackScope: 'root',
				runtimeEvent: makeRuntimeEvent(),
			});
			expect((ev?.data as {message: string}).message).toBe('override');
		});

		it('emitCompleted clears the buffer regardless of whether it emitted', () => {
			const ams = createAgentMessageStream(buildEvent(), fakeTranscript());
			ams.appendPendingDelta('item-1', 'first', 'agent:root', 'root');
			ams.emitCompleted({
				itemId: 'item-1',
				messageText: 'first',
				fallbackActorId: 'agent:root',
				fallbackScope: 'root',
				runtimeEvent: makeRuntimeEvent(),
			});
			// A second emitCompleted on the same itemId with no text yields nothing.
			expect(
				ams.emitCompleted({
					itemId: 'item-1',
					messageText: undefined,
					fallbackActorId: 'agent:root',
					fallbackScope: 'root',
					runtimeEvent: makeRuntimeEvent(),
				}),
			).toBeNull();
		});

		it('flushPending emits all buffered messages and clears them', () => {
			const ams = createAgentMessageStream(buildEvent(), fakeTranscript());
			ams.appendPendingDelta('item-1', 'one', 'agent:root', 'root');
			ams.appendPendingDelta('item-2', 'two', 'agent:root', 'root');
			const out = ams.flushPending(makeRuntimeEvent());
			expect(out).toHaveLength(2);
			// Subsequent flush is empty.
			expect(ams.flushPending(makeRuntimeEvent())).toEqual([]);
		});

		it('appendPendingDelta with no item_id falls into the legacy bucket', () => {
			const ams = createAgentMessageStream(buildEvent(), fakeTranscript());
			ams.appendPendingDelta(undefined, 'a', 'agent:root', 'root');
			ams.appendPendingDelta(undefined, 'b', 'agent:root', 'root');
			const ev = ams.emitCompleted({
				itemId: undefined,
				messageText: undefined,
				fallbackActorId: 'agent:root',
				fallbackScope: 'root',
				runtimeEvent: makeRuntimeEvent(),
			});
			expect((ev?.data as {message: string}).message).toBe('ab');
		});

		it('clearPending drops buffered text without emitting', () => {
			const ams = createAgentMessageStream(buildEvent(), fakeTranscript());
			ams.appendPendingDelta('item-1', 'lost', 'agent:root', 'root');
			ams.clearPending();
			expect(
				ams.emitCompleted({
					itemId: 'item-1',
					messageText: undefined,
					fallbackActorId: 'agent:root',
					fallbackScope: 'root',
					runtimeEvent: makeRuntimeEvent(),
				}),
			).toBeNull();
		});
	});

	describe('transcript replay', () => {
		it('emits one agent.message per transcript message returned', () => {
			const ams = createAgentMessageStream(
				buildEvent(),
				fakeTranscript([{text: 'first', model: 'opus'}, {text: 'second'}]),
			);
			const out = ams.emitTranscriptMessages(
				'/tmp/t.jsonl',
				makeRuntimeEvent(),
				'agent:root',
				'root',
			);
			expect(out).toHaveLength(2);
			expect((out[0]!.data as {model?: string}).model).toBe('opus');
		});

		it('drainTranscript advances the offset without emitting', () => {
			const ams = createAgentMessageStream(
				buildEvent(),
				fakeTranscript([{text: 'drained'}]),
			);
			ams.drainTranscript('/tmp/t.jsonl');
			// After draining, transcript reader is exhausted.
			expect(
				ams.emitTranscriptMessages(
					'/tmp/t.jsonl',
					makeRuntimeEvent(),
					'agent:root',
					'root',
				),
			).toEqual([]);
		});
	});

	describe('reasoning summary', () => {
		it('accumulates chunks per (item_id, index) and returns the cumulative text', () => {
			const ams = createAgentMessageStream(buildEvent(), fakeTranscript());
			expect(ams.appendReasoningSummary('item-1', 0, 'Plan: ')).toBe('Plan: ');
			expect(ams.appendReasoningSummary('item-1', 0, 'do X')).toBe(
				'Plan: do X',
			);
		});

		it('keeps independent buffers per (item, index) pair', () => {
			const ams = createAgentMessageStream(buildEvent(), fakeTranscript());
			ams.appendReasoningSummary('item-1', 0, 'A');
			ams.appendReasoningSummary('item-1', 1, 'B');
			expect(ams.appendReasoningSummary('item-1', 0, 'A2')).toBe('AA2');
			expect(ams.appendReasoningSummary('item-1', 1, 'B2')).toBe('BB2');
		});
	});

	describe('resetForNewRun', () => {
		it('clears dedup and reasoning, but preserves in-flight pending deltas', () => {
			const ams = createAgentMessageStream(buildEvent(), fakeTranscript());
			ams.appendPendingDelta('item-1', 'pending', 'agent:root', 'root');
			ams.emit({
				runtimeEvent: makeRuntimeEvent(),
				actorId: 'agent:root',
				scope: 'root',
				message: 'first',
				source: 'hook',
			});
			ams.appendReasoningSummary('item-1', 0, 'thinking');

			ams.resetForNewRun();

			// Pending survives — a Codex message.delta in flight when a run rolls
			// over still flushes correctly on its eventual message.complete.
			const ev = ams.emitCompleted({
				itemId: 'item-1',
				messageText: undefined,
				fallbackActorId: 'agent:root',
				fallbackScope: 'root',
				runtimeEvent: makeRuntimeEvent(),
			});
			expect((ev?.data as {message: string}).message).toBe('pending');
			// Dedup cleared — same message can emit again.
			expect(
				ams.emit({
					runtimeEvent: makeRuntimeEvent(),
					actorId: 'agent:root',
					scope: 'root',
					message: 'first',
					source: 'hook',
				}),
			).not.toBeNull();
			// Reasoning summary reset to empty.
			expect(ams.appendReasoningSummary('item-1', 0, 'fresh')).toBe('fresh');
		});
	});

	describe('replayBeforeEvent (transcript-before-event timing)', () => {
		it('replays transcript assistant messages for a non-stop event', () => {
			const ams = createAgentMessageStream(
				buildEvent(),
				fakeTranscript([{text: 'from transcript', model: 'opus'}]),
			);
			const out = ams.replayBeforeEvent(
				makeRuntimeEvent({kind: 'pre_tool_use'} as Partial<RuntimeEvent>),
				'agent:root',
				'root',
			);
			expect(out).toHaveLength(1);
			expect(out[0]?.kind).toBe('agent.message');
			expect((out[0]?.data as {message: string}).message).toBe(
				'from transcript',
			);
		});

		it('does NOT replay for a stop.request event (it drains + falls back instead)', () => {
			const ams = createAgentMessageStream(
				buildEvent(),
				fakeTranscript([{text: 'should not surface', model: 'opus'}]),
			);
			expect(
				ams.replayBeforeEvent(
					makeRuntimeEvent({kind: 'stop.request'} as Partial<RuntimeEvent>),
					'agent:root',
					'root',
				),
			).toEqual([]);
		});

		it('does NOT replay for a subagent.stop event', () => {
			const ams = createAgentMessageStream(
				buildEvent(),
				fakeTranscript([{text: 'should not surface', model: 'opus'}]),
			);
			expect(
				ams.replayBeforeEvent(
					makeRuntimeEvent({kind: 'subagent.stop'} as Partial<RuntimeEvent>),
					'subagent:foo',
					'subagent',
				),
			).toEqual([]);
		});

		it('returns [] when the event has no transcript path', () => {
			const ams = createAgentMessageStream(
				buildEvent(),
				fakeTranscript([{text: 'from transcript', model: 'opus'}]),
			);
			expect(
				ams.replayBeforeEvent(
					makeRuntimeEvent({
						kind: 'pre_tool_use',
						context: {cwd: '/tmp', transcriptPath: undefined},
					} as Partial<RuntimeEvent>),
					'agent:root',
					'root',
				),
			).toEqual([]);
		});
	});

	describe('emitStopFallback (stop-event drain + fallback)', () => {
		const stopEvent = (lastMessage?: string): RuntimeEvent =>
			makeRuntimeEvent({
				kind: 'stop.request',
				data: lastMessage ? {last_assistant_message: lastMessage} : {},
			} as Partial<RuntimeEvent>);

		it('emits a fallback agent.message from last_assistant_message', () => {
			const ams = createAgentMessageStream(buildEvent(), fakeTranscript());
			const out = ams.emitStopFallback(stopEvent('hi there'), {
				actorId: 'agent:root',
				scope: 'root',
				parentKind: 'stop.request',
				priorResults: [],
			});
			expect(out).toHaveLength(1);
			expect(out[0]?.kind).toBe('agent.message');
			expect((out[0]?.data as {message: string}).message).toBe('hi there');
		});

		it('parents the fallback to the prior event of parentKind', () => {
			const ams = createAgentMessageStream(buildEvent(), fakeTranscript());
			const parent = {
				event_id: 'stop-evt-1',
				kind: 'stop.request',
			} as unknown as FeedEvent;
			const out = ams.emitStopFallback(stopEvent('done'), {
				actorId: 'agent:root',
				scope: 'root',
				parentKind: 'stop.request',
				priorResults: [parent],
			});
			expect(out[0]?.cause?.parent_event_id).toBe('stop-evt-1');
		});

		it('does not duplicate when an agent.message was already emitted', () => {
			const ams = createAgentMessageStream(buildEvent(), fakeTranscript());
			const already = {
				event_id: 'msg-1',
				kind: 'agent.message',
			} as unknown as FeedEvent;
			expect(
				ams.emitStopFallback(stopEvent('hi there'), {
					actorId: 'agent:root',
					scope: 'root',
					parentKind: 'stop.request',
					priorResults: [already],
				}),
			).toEqual([]);
		});

		it('returns [] when there is no last_assistant_message', () => {
			const ams = createAgentMessageStream(buildEvent(), fakeTranscript());
			expect(
				ams.emitStopFallback(stopEvent(), {
					actorId: 'agent:root',
					scope: 'root',
					parentKind: 'stop.request',
					priorResults: [],
				}),
			).toEqual([]);
		});

		it('drains the transcript so a later replay does not re-surface the same text', () => {
			const ams = createAgentMessageStream(
				buildEvent(),
				fakeTranscript([{text: 'already streamed', model: 'opus'}]),
			);
			ams.emitStopFallback(stopEvent('hi there'), {
				actorId: 'agent:root',
				scope: 'root',
				parentKind: 'stop.request',
				priorResults: [],
			});
			// fakeTranscript yields its messages only once; draining consumed them.
			expect(
				ams.replayBeforeEvent(
					makeRuntimeEvent({kind: 'pre_tool_use'} as Partial<RuntimeEvent>),
					'agent:root',
					'root',
				),
			).toEqual([]);
		});
	});
});
