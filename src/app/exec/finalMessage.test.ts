import {describe, it, expect} from 'vitest';
import {findLastMappedAgentMessage, resolveFinalMessage} from './finalMessage';
import type {FeedEvent} from '../../core/feed/types';

const agentMsg = (message: string): FeedEvent =>
	({
		kind: 'agent.message',
		data: {message, source: 'hook', scope: 'root'},
	}) as unknown as FeedEvent;

const otherEvent = (): FeedEvent =>
	({kind: 'notification', data: {message: 'x'}}) as unknown as FeedEvent;

describe('findLastMappedAgentMessage', () => {
	it('returns the last agent.message in order', () => {
		const feed = [otherEvent(), agentMsg('first'), agentMsg('second')];
		expect(findLastMappedAgentMessage(feed)).toBe('second');
	});

	it('returns null on empty feed', () => {
		expect(findLastMappedAgentMessage([])).toBeNull();
	});

	it('returns null when feed contains no agent.message events', () => {
		expect(findLastMappedAgentMessage([otherEvent(), otherEvent()])).toBeNull();
	});

	it('skips whitespace-only agent.message entries and returns the last non-empty one', () => {
		const feed = [agentMsg('real'), agentMsg('   '), agentMsg('\n\t')];
		expect(findLastMappedAgentMessage(feed)).toBe('real');
	});

	it('returns null when all agent.message entries are whitespace-only', () => {
		const feed = [agentMsg('  '), agentMsg('\n')];
		expect(findLastMappedAgentMessage(feed)).toBeNull();
	});
});

describe('resolveFinalMessage', () => {
	it('prefers stream-derived message', () => {
		expect(
			resolveFinalMessage({streamMessage: 'stream', mappedMessage: 'mapped'}),
		).toEqual({message: 'stream', source: 'stream'});
	});

	it('falls back to mapped message when stream is null', () => {
		expect(
			resolveFinalMessage({streamMessage: null, mappedMessage: 'mapped'}),
		).toEqual({message: 'mapped', source: 'mapped'});
	});

	it('returns empty when both are null', () => {
		expect(
			resolveFinalMessage({streamMessage: null, mappedMessage: null}),
		).toEqual({message: '', source: 'empty'});
	});

	it('treats whitespace-only stream as absent and falls through to mapped', () => {
		expect(
			resolveFinalMessage({streamMessage: '   ', mappedMessage: 'mapped'}),
		).toEqual({message: 'mapped', source: 'mapped'});
	});

	it('treats whitespace-only mapped as absent and returns empty', () => {
		expect(
			resolveFinalMessage({streamMessage: null, mappedMessage: '\n\t'}),
		).toEqual({message: '', source: 'empty'});
	});

	it('treats whitespace-only stream and whitespace-only mapped as empty', () => {
		expect(
			resolveFinalMessage({streamMessage: ' ', mappedMessage: ' '}),
		).toEqual({message: '', source: 'empty'});
	});
});
