/**
 * Console channel adapter — WIP skeleton. Real implementation lands in
 * tasks K3–K7.
 */

import type {
	AdapterContext,
	ChannelAdapter,
	ChannelCapabilities,
	OutboundMessage,
	PermissionRelayRequest,
	PermissionRelayResult,
	ProbeResult,
	QuestionRelayRequest,
	QuestionRelayResult,
	SendResult,
	StopReason,
} from '../../../shared/gateway-protocol';
import type {ConsoleAdapterOptions} from './types';

export class ConsoleAdapter implements ChannelAdapter {
	readonly id = 'console';
	readonly capabilities: ChannelCapabilities = {
		chat: true,
		threads: true,
		relayPermission: true,
		relayQuestion: true,
	};

	constructor(private readonly opts: ConsoleAdapterOptions) {
		void this.opts;
	}

	async start(_ctx: AdapterContext): Promise<void> {
		throw new Error('console adapter: not yet implemented');
	}

	async stop(_reason: StopReason): Promise<void> {
		throw new Error('console adapter: not yet implemented');
	}

	async send(_msg: OutboundMessage): Promise<SendResult> {
		throw new Error('console adapter: not yet implemented');
	}

	async probe(): Promise<ProbeResult> {
		return {ok: false, detail: 'not yet implemented', checkedAt: Date.now()};
	}

	async requestPermissionVerdict(
		_req: PermissionRelayRequest,
		_signal: AbortSignal,
	): Promise<PermissionRelayResult> {
		return {kind: 'no_relay'};
	}

	async requestQuestionAnswer(
		_req: QuestionRelayRequest,
		_signal: AbortSignal,
	): Promise<QuestionRelayResult> {
		return {kind: 'no_relay'};
	}
}
