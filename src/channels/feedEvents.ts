/**
 * Channel-side payloads forwarded to a host-supplied push callback. The
 * channels layer never builds full FeedEvents itself — useFeed owns seq
 * allocation and session/run lookup.
 */

import type {
	ChannelChatInboundData,
	ChannelPermissionRelayedData,
	ChannelPermissionResolvedData,
	ChannelQuestionRelayedData,
	ChannelQuestionResolvedData,
} from '../core/feed/types';

export type ChannelFeedEventInput =
	| {kind: 'channel.permission.relayed'; data: ChannelPermissionRelayedData}
	| {kind: 'channel.permission.resolved'; data: ChannelPermissionResolvedData}
	| {kind: 'channel.question.relayed'; data: ChannelQuestionRelayedData}
	| {kind: 'channel.question.resolved'; data: ChannelQuestionResolvedData}
	| {kind: 'channel.chat.inbound'; data: ChannelChatInboundData};

export type PushChannelFeedEvent = (input: ChannelFeedEventInput) => void;
