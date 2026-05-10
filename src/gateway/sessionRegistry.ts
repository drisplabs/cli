/**
 * SessionRegistry — dispatch turn correlation.
 *
 * Mints a `dispatchId` when a channel inbound is routed to the runtime, parks
 * the originating `ChannelLocation` keyed by that id, and resolves the entry
 * on `session.turn.complete` so the gateway can relay the reply back on the
 * correct channel.
 *
 * Runtime registration and connection binding are owned by RuntimeBindingStore.
 */

import {randomUUID} from 'node:crypto';
import type {ChannelLocation} from '../shared/gateway-protocol';

export type DispatchEntry = {
	dispatchId: string;
	sessionKey: string;
	agentId: string;
	location: ChannelLocation;
	createdAt: number;
};

export class UnknownDispatchError extends Error {
	readonly code = 'unknown_dispatch' as const;
	constructor(id: string) {
		super(`unknown dispatchId: ${id}`);
		this.name = 'UnknownDispatchError';
	}
}

export type SessionRegistryOptions = {
	idFactory?: () => string;
	now?: () => number;
};

export class SessionRegistry {
	private readonly dispatches = new Map<string, DispatchEntry>();
	private readonly idFactory: () => string;
	private readonly now: () => number;

	constructor(opts: SessionRegistryOptions = {}) {
		this.idFactory = opts.idFactory ?? randomUUID;
		this.now = opts.now ?? Date.now;
	}

	beginDispatch(input: {
		sessionKey: string;
		agentId: string;
		location: ChannelLocation;
	}): DispatchEntry {
		const dispatchId = this.idFactory();
		const entry: DispatchEntry = {
			dispatchId,
			sessionKey: input.sessionKey,
			agentId: input.agentId,
			location: input.location,
			createdAt: this.now(),
		};
		this.dispatches.set(dispatchId, entry);
		return entry;
	}

	completeDispatch(dispatchId: string): DispatchEntry {
		const entry = this.dispatches.get(dispatchId);
		if (!entry) {
			throw new UnknownDispatchError(dispatchId);
		}
		this.dispatches.delete(dispatchId);
		return entry;
	}

	pendingDispatchCount(): number {
		return this.dispatches.size;
	}

	clearDispatches(): void {
		this.dispatches.clear();
	}
}
