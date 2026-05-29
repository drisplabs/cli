/**
 * RuntimeBindingStore — owns the registered-runtime binding state machine.
 *
 * States per attachment slot: absent → active → stale → (active | absent)
 *
 * The store hosts one runtime per **attachment slot**, keyed by `attachmentId`.
 * Frames that arrive without an `attachmentId` hit the single fallback slot
 * keyed by `undefined`. Each slot tracks its own runtime identity, connection
 * binding, and optional grace-period timer.
 *
 * Observer callbacks are emitted synchronously from the mutating methods so
 * the caller can update ancillary state (e.g. clearing the push handle) in
 * the same turn.
 *
 * See `docs/adr/0001-attachment-supervisor.md`.
 */

export type RegisteredRuntime = {
	runtimeId: string;
	defaultAgentId: string;
	pid: number;
	registeredAt: number;
	/**
	 * Optional binding to a dashboard-side **Attachment** (one runner attached
	 * to this instance). When unset, the runtime occupies the single fallback
	 * slot used by frames that arrive without an `attachmentId`. See
	 * `docs/adr/0001-attachment-supervisor.md`.
	 */
	attachmentId?: string;
};

export type RuntimeConnectionBinding =
	| {
			state: 'active';
			connectionId: string;
			boundAt: number;
			epoch: number;
			lastRebindAt?: number;
	  }
	| {
			state: 'stale';
			connectionId: string;
			staleSince: number;
			epoch: number;
			lastRebindAt?: number;
	  };

export class AlreadyRegisteredError extends Error {
	readonly code = 'already_registered' as const;
	constructor(existing: RegisteredRuntime) {
		super(
			`gateway already has a registered runtime (pid=${existing.pid}, runtimeId=${existing.runtimeId})`,
		);
		this.name = 'AlreadyRegisteredError';
	}
}

export class NotRegisteredError extends Error {
	readonly code = 'not_registered' as const;
	constructor() {
		super('no runtime registered with gateway');
		this.name = 'NotRegisteredError';
	}
}

export function maybeLastRebindAt(value: number | undefined): {
	lastRebindAt?: number;
} {
	return value !== undefined ? {lastRebindAt: value} : {};
}

export type RuntimeBindingObservers = {
	onRuntimeRebind?: (e: {
		runtimeId: string;
		gapMs: number;
		epoch: number;
	}) => void;
	onRuntimeExpired?: (e: {runtimeId: string; gapMs: number}) => void;
	onRuntimeConnectionLost?: (e: {runtimeId: string; graceful: boolean}) => void;
};

export type RuntimeBindingStoreOptions = {
	gracePeriodMs?: number;
	observers?: RuntimeBindingObservers;
	now?: () => number;
};

type AttachmentKey = string | undefined;

type Slot = {
	runtime: RegisteredRuntime;
	binding: RuntimeConnectionBinding | null;
	staleTimer: NodeJS.Timeout | null;
	staleSince: number | null;
};

export class RuntimeBindingStore {
	private readonly slots: Map<AttachmentKey, Slot> = new Map();
	private readonly gracePeriodMs: number;
	private readonly observers: RuntimeBindingObservers;
	private readonly now: () => number;

	constructor(opts: RuntimeBindingStoreOptions = {}) {
		this.gracePeriodMs = opts.gracePeriodMs ?? 0;
		this.observers = opts.observers ?? {};
		this.now = opts.now ?? Date.now;
	}

	// ── lifecycle ─────────────────────────────────────────────

	/** Register a runtime and bind its connection in one atomic step. */
	bind(input: {
		runtimeId: string;
		defaultAgentId: string;
		pid: number;
		connectionId: string;
		attachmentId?: string;
	}): {registeredAt: number} {
		const key: AttachmentKey = input.attachmentId;
		const existing = this.slots.get(key);
		const previousBinding = existing?.binding ?? null;
		const wasStale = previousBinding?.state === 'stale';
		const staleSince = wasStale
			? (previousBinding as {staleSince: number}).staleSince
			: null;

		let runtime: RegisteredRuntime;
		if (!existing) {
			runtime = {
				runtimeId: input.runtimeId,
				defaultAgentId: input.defaultAgentId,
				pid: input.pid,
				registeredAt: this.now(),
				...(input.attachmentId !== undefined
					? {attachmentId: input.attachmentId}
					: {}),
			};
		} else if (existing.runtime.runtimeId === input.runtimeId) {
			runtime = {
				...existing.runtime,
				defaultAgentId: input.defaultAgentId,
				pid: input.pid,
			};
		} else {
			throw new AlreadyRegisteredError(existing.runtime);
		}

		const now = this.now();
		const isRebind =
			previousBinding !== null &&
			(previousBinding.state === 'stale' ||
				previousBinding.connectionId !== input.connectionId);
		const lastRebindAt = isRebind ? now : previousBinding?.lastRebindAt;
		const epoch = previousBinding
			? previousBinding.epoch + (isRebind ? 1 : 0)
			: 1;
		const newBinding: RuntimeConnectionBinding = {
			state: 'active',
			connectionId: input.connectionId,
			boundAt: now,
			epoch,
			...maybeLastRebindAt(lastRebindAt),
		};

		const slot: Slot = existing
			? {...existing, runtime, binding: newBinding}
			: {runtime, binding: newBinding, staleTimer: null, staleSince: null};
		this.clearStaleTimerForSlot(slot);
		this.slots.set(key, slot);

		if (wasStale && staleSince !== null) {
			this.observers.onRuntimeRebind?.({
				runtimeId: input.runtimeId,
				gapMs: now - staleSince,
				epoch: newBinding.epoch,
			});
		}

		return {registeredAt: runtime.registeredAt};
	}

	/** Fully unregister a runtime. Throws NotRegisteredError if id does not match. */
	unbind(runtimeId: string): void {
		const entry = this.findSlotByRuntimeId(runtimeId);
		if (!entry) {
			throw new NotRegisteredError();
		}
		this.clearStaleTimerForSlot(entry.slot);
		this.slots.delete(entry.key);
		this.observers.onRuntimeConnectionLost?.({runtimeId, graceful: true});
	}

	/**
	 * Called when the transport connection closes.
	 * Returns the runtimeId if the close was for a current binding (caller should
	 * clear the push handle); returns null if the connectionId was not recognised.
	 */
	notifyConnectionClosed(connectionId: string): string | null {
		const entry = this.findSlotByConnectionId(connectionId);
		if (!entry) return null;

		const {key, slot} = entry;
		const runtimeId = slot.runtime.runtimeId;
		const now = this.now();
		const previousBinding = slot.binding!;
		slot.binding = {
			state: 'stale',
			connectionId,
			staleSince: now,
			epoch: previousBinding.epoch,
			...maybeLastRebindAt(previousBinding.lastRebindAt),
		};

		if (this.gracePeriodMs <= 0) {
			this.slots.delete(key);
			this.observers.onRuntimeConnectionLost?.({runtimeId, graceful: false});
			return runtimeId;
		}

		slot.staleSince = now;
		slot.staleTimer = setTimeout(() => {
			this.expireStaleBinding(key, runtimeId);
		}, this.gracePeriodMs);
		return runtimeId;
	}

	stop(): void {
		for (const slot of this.slots.values()) {
			this.clearStaleTimerForSlot(slot);
		}
	}

	// ── reads ─────────────────────────────────────────────────

	hasActiveBinding(runtimeId?: string): boolean {
		const slot = this.slots.get(undefined);
		if (!slot || !slot.binding || slot.binding.state !== 'active') return false;
		return runtimeId === undefined || slot.runtime.runtimeId === runtimeId;
	}

	hasActiveBindingForAttachment(key: string | undefined): boolean {
		const slot = this.slots.get(key);
		return !!slot && !!slot.binding && slot.binding.state === 'active';
	}

	getCurrent(): RegisteredRuntime | null {
		return this.slots.get(undefined)?.runtime ?? null;
	}

	getCurrentByAttachment(
		attachmentId: string | undefined,
	): RegisteredRuntime | null {
		return this.slots.get(attachmentId)?.runtime ?? null;
	}

	getBinding(): RuntimeConnectionBinding | null {
		return this.slots.get(undefined)?.binding ?? null;
	}

	getRuntimeIdByConnection(connectionId: string): string | null {
		const entry = this.findSlotByConnectionId(connectionId);
		return entry ? entry.slot.runtime.runtimeId : null;
	}

	/**
	 * Returns the attachment slot key (or `undefined` for the legacy slot) that
	 * holds the given runtime, or `null` if no slot does. Lets callers
	 * route per-attachment side-state (like push handles) keyed the same way
	 * as the binding map.
	 */
	getAttachmentKeyByRuntimeId(runtimeId: string): {
		key: string | undefined;
		runtime: RegisteredRuntime;
	} | null {
		const entry = this.findSlotByRuntimeId(runtimeId);
		return entry ? {key: entry.key, runtime: entry.slot.runtime} : null;
	}

	// ── private ───────────────────────────────────────────────

	private expireStaleBinding(key: AttachmentKey, runtimeId: string): void {
		const slot = this.slots.get(key);
		if (!slot) return;
		slot.staleTimer = null;
		const since = slot.staleSince;
		slot.staleSince = null;
		if (slot.runtime.runtimeId !== runtimeId) return;
		if (slot.binding?.state === 'active') return;
		this.slots.delete(key);
		this.observers.onRuntimeConnectionLost?.({runtimeId, graceful: false});
		if (since !== null) {
			this.observers.onRuntimeExpired?.({runtimeId, gapMs: this.now() - since});
		}
	}

	private clearStaleTimerForSlot(slot: Slot): void {
		if (slot.staleTimer) {
			clearTimeout(slot.staleTimer);
			slot.staleTimer = null;
		}
		slot.staleSince = null;
	}

	private findSlotByRuntimeId(
		runtimeId: string,
	): {key: AttachmentKey; slot: Slot} | null {
		for (const [key, slot] of this.slots) {
			if (slot.runtime.runtimeId === runtimeId) return {key, slot};
		}
		return null;
	}

	private findSlotByConnectionId(
		connectionId: string,
	): {key: AttachmentKey; slot: Slot} | null {
		for (const [key, slot] of this.slots) {
			if (slot.binding?.connectionId === connectionId) return {key, slot};
		}
		return null;
	}
}
