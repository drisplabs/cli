/**
 * SessionRegistry — dispatch turn correlation.
 *
 * Mints a `dispatchId` when a channel inbound is routed to the runtime, parks
 * the originating `ChannelLocation` together with the Registered runtime the
 * turn was dispatched to, and resolves the entry on `session.turn.complete` so
 * the gateway can relay the reply back on the correct channel.
 *
 * The registry owns dispatch-turn authorization: only the runtime a turn was
 * dispatched to may complete it, and the parked location — not the completion
 * payload — is the source of truth for where the reply goes.
 *
 * Runtime registration and connection binding are owned by RuntimeBindingStore.
 */

import {randomUUID} from 'node:crypto';
import type {ChannelLocation} from '../shared/gateway-protocol';

export type DispatchEntry = {
	dispatchId: string;
	sessionKey: string;
	agentId: string;
	/** Registered runtime authorized to complete this turn. */
	runtimeId: string;
	/** Attachment slot the turn was dispatched to (undefined = legacy slot). */
	attachmentKey?: string;
	location: ChannelLocation;
	createdAt: number;
};

export type CompleteDispatchResult =
	| {kind: 'completed'; entry: DispatchEntry}
	| {kind: 'unknown'}
	| {kind: 'runtime_mismatch'; entry: DispatchEntry};

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
		runtimeId: string;
		attachmentKey?: string;
		location: ChannelLocation;
	}): DispatchEntry {
		const dispatchId = this.idFactory();
		const entry: DispatchEntry = {
			dispatchId,
			sessionKey: input.sessionKey,
			agentId: input.agentId,
			runtimeId: input.runtimeId,
			...(input.attachmentKey !== undefined
				? {attachmentKey: input.attachmentKey}
				: {}),
			location: input.location,
			createdAt: this.now(),
		};
		this.dispatches.set(dispatchId, entry);
		return entry;
	}

	/**
	 * Resolve a parked turn for the runtime claiming to complete it. The entry is
	 * consumed only when the claiming runtime matches the one the turn was
	 * dispatched to — a mismatched runtime cannot cancel or steal another
	 * runtime's turn, and an unknown id is reported rather than thrown.
	 */
	completeDispatch(
		dispatchId: string,
		by: {runtimeId: string},
	): CompleteDispatchResult {
		const entry = this.dispatches.get(dispatchId);
		if (!entry) {
			return {kind: 'unknown'};
		}
		if (entry.runtimeId !== by.runtimeId) {
			return {kind: 'runtime_mismatch', entry};
		}
		this.dispatches.delete(dispatchId);
		return {kind: 'completed', entry};
	}

	pendingDispatchCount(): number {
		return this.dispatches.size;
	}

	clearDispatches(): void {
		this.dispatches.clear();
	}
}
