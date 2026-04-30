import {describe, expect, it, vi} from 'vitest';
import {QuestionRelay} from './questionRelay';
import type {
	Runtime,
	RuntimeDecision,
	RuntimeEvent,
} from '../core/runtime/types';

function makeRuntime(): Runtime & {
	emitDecision: (eventId: string, decision: RuntimeDecision) => void;
} {
	const decisionHandlers = new Set<(id: string, d: RuntimeDecision) => void>();
	return {
		start: vi.fn(),
		stop: vi.fn(),
		getStatus: vi.fn(() => 'running'),
		getLastError: vi.fn(() => null),
		onEvent: vi.fn(() => () => {}),
		onDecision: vi.fn((handler: (id: string, d: RuntimeDecision) => void) => {
			decisionHandlers.add(handler);
			return () => {
				decisionHandlers.delete(handler);
			};
		}),
		sendDecision: vi.fn(),
		emitDecision: (eventId: string, decision: RuntimeDecision) => {
			for (const h of decisionHandlers) h(eventId, decision);
		},
	} as unknown as Runtime & {
		emitDecision: (eventId: string, decision: RuntimeDecision) => void;
	};
}

function makeQuestionEvent(id: string): RuntimeEvent {
	return {
		id,
		timestamp: 0,
		kind: 'tool.pre',
		data: {
			tool_name: 'AskUserQuestion',
			tool_input: {
				questions: [{question: 'Continue?', header: 'Confirm', options: []}],
			},
		},
		hookName: 'PreToolUse',
		sessionId: 's',
		toolName: 'AskUserQuestion',
		context: {cwd: '/', transcriptPath: ''},
		interaction: {expectsDecision: true},
		payload: {},
	};
}

describe('QuestionRelay', () => {
	it('registers and resolves by channel request id', () => {
		const runtime = makeRuntime();
		const relay = new QuestionRelay({runtime});

		relay.register(makeQuestionEvent('q1'), 'abcde', ['Continue?']);

		expect(relay.resolveByChannelId('abcde')).toEqual(
			expect.objectContaining({
				runtimeEventId: 'q1',
				channelRequestId: 'abcde',
				questionKeys: ['Continue?'],
			}),
		);
		relay.dispose();
	});

	it('only allows the first claimant to resolve', () => {
		const runtime = makeRuntime();
		const relay = new QuestionRelay({runtime});
		const onClaimed = vi.fn();
		relay.setOnClaimed(onClaimed);
		relay.register(makeQuestionEvent('q1'), 'abcde', ['Continue?']);

		expect(
			relay.tryClaim('q1', 'channel', {
				answers: {'Continue?': 'yes'},
				resolvingChannelName: 'telegram',
			}),
		).toBe(true);
		expect(
			relay.tryClaim('q1', 'local', {
				answers: {'Continue?': 'no'},
				resolvingChannelName: null,
			}),
		).toBe(false);
		expect(onClaimed).toHaveBeenCalledTimes(1);
		relay.dispose();
	});

	it('runtime question_answer decision claims pending entries automatically', () => {
		const runtime = makeRuntime();
		const relay = new QuestionRelay({runtime});
		relay.register(makeQuestionEvent('q1'), 'abcde', ['Continue?']);

		runtime.emitDecision('q1', {
			type: 'json',
			source: 'user',
			intent: {kind: 'question_answer', answers: {'Continue?': 'yes'}},
		});

		expect(relay.tryClaim('q1', 'channel')).toBe(false);
		relay.dispose();
	});
});
