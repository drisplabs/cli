import type {FeedEvent} from '../../core/feed/types';

export function findLastMappedAgentMessage(
	feedEvents: FeedEvent[],
): string | null {
	for (let i = feedEvents.length - 1; i >= 0; i--) {
		const event = feedEvents[i];
		if (event.kind !== 'agent.message') continue;
		const message = event.data.message;
		if (typeof message === 'string' && message.trim().length > 0) {
			return message;
		}
	}
	return null;
}

export function resolveFinalMessage(input: {
	streamMessage: string | null;
	mappedMessage: string | null;
}): {
	message: string;
	source: 'stream' | 'mapped' | 'empty';
} {
	if (input.streamMessage && input.streamMessage.trim().length > 0) {
		return {message: input.streamMessage, source: 'stream'};
	}

	if (input.mappedMessage && input.mappedMessage.trim().length > 0) {
		return {message: input.mappedMessage, source: 'mapped'};
	}

	return {message: '', source: 'empty'};
}
