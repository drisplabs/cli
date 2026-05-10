/**
 * PendingRegistry — internal seam owned by RelayCoordinator.
 *
 * Owns the `channelRequestId → PendingEntry` map and the rules around it:
 * collision detection (kind / payload / owner), settle (resolve + clean up
 * controllers and timer), runtime-scoped cancel, and bulk dispose.
 *
 * The registry knows nothing about adapters, broadcast fanout, or fingerprint
 * derivation. It is the place where a pending entry's invariants live —
 * "an entry settles at most once", "settling clears the timer and aborts every
 * controller", "cancel respects runtime ownership when supplied".
 */

import type {
	PermissionRelayResult,
	QuestionRelayResult,
	RelayCancelReason,
} from '../../shared/gateway-protocol';

export type PendingKind = 'permission' | 'question';

export type AnyRelayResult = PermissionRelayResult | QuestionRelayResult;

export type PendingEntry = {
	kind: PendingKind;
	channelRequestId: string;
	fingerprint: string;
	runtimeId: string | undefined;
	controllers: AbortController[];
	// undefined when ttlMs was null (no broadcast timeout, e.g. AskUserQuestion).
	timer: NodeJS.Timeout | undefined;
	resolve: (result: AnyRelayResult) => void;
	result: Promise<AnyRelayResult>;
	settled: boolean;
};

export type InspectResult =
	| {kind: 'absent'}
	| {kind: 'attach'; entry: PendingEntry}
	| {kind: 'collision'; reason: 'kind' | 'payload' | 'owner'};

export class PendingRegistry {
	private readonly entries = new Map<string, PendingEntry>();

	inspect(
		channelRequestId: string,
		kind: PendingKind,
		fingerprint: string,
		runtimeId: string | undefined,
	): InspectResult {
		const existing = this.entries.get(channelRequestId);
		if (!existing) return {kind: 'absent'};
		if (existing.kind !== kind) return {kind: 'collision', reason: 'kind'};
		if (existing.fingerprint !== fingerprint) {
			return {kind: 'collision', reason: 'payload'};
		}
		if (existing.runtimeId !== runtimeId) {
			return {kind: 'collision', reason: 'owner'};
		}
		return {kind: 'attach', entry: existing};
	}

	register(entry: PendingEntry): void {
		this.entries.set(entry.channelRequestId, entry);
	}

	settle(channelRequestId: string, result: AnyRelayResult): boolean {
		const entry = this.entries.get(channelRequestId);
		if (!entry || entry.settled) return false;
		entry.settled = true;
		this.entries.delete(channelRequestId);
		clearTimeout(entry.timer);
		for (const ctrl of entry.controllers) {
			if (!ctrl.signal.aborted) ctrl.abort();
		}
		entry.resolve(result);
		return true;
	}

	cancel(
		channelRequestId: string,
		reason: RelayCancelReason,
		expectedRuntimeId: string | undefined,
	): boolean {
		const entry = this.entries.get(channelRequestId);
		if (!entry) return false;
		if (
			expectedRuntimeId !== undefined &&
			entry.runtimeId !== undefined &&
			entry.runtimeId !== expectedRuntimeId
		) {
			return false;
		}
		return this.settle(channelRequestId, {kind: 'cancelled', reason});
	}

	disposeAll(reason: RelayCancelReason): void {
		for (const id of [...this.entries.keys()]) {
			this.cancel(id, reason, undefined);
		}
	}

	count(): number {
		return this.entries.size;
	}
}

export function collisionMessage(
	channelRequestId: string,
	reason: 'kind' | 'payload' | 'owner',
	newKind: PendingKind,
): string {
	if (reason === 'owner') {
		return `channel_request_owner_mismatch: ${channelRequestId} owned by a different runtime`;
	}
	if (reason === 'kind') {
		const otherKind = newKind === 'permission' ? 'question' : 'permission';
		return `channel_request_id_collision: ${channelRequestId} is bound to a ${otherKind} relay`;
	}
	return `channel_request_id_collision: ${channelRequestId} payload mismatch`;
}
