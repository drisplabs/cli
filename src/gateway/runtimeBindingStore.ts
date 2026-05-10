/**
 * RuntimeBindingStore — owns the registered-runtime binding state machine.
 *
 * States: absent → active → stale → (active | absent)
 *
 * A gateway hosts at most one Athena runtime at a time. This store tracks
 * the registered runtime identity, the current connection binding, and the
 * optional grace-period timer that holds the slot open when the TCP/UDS
 * connection drops so the runtime can reconnect without losing queued inbound.
 *
 * Observer callbacks are emitted synchronously from the mutating methods so
 * the caller can update ancillary state (e.g. clearing the push handle) in
 * the same turn.
 */

export type RegisteredRuntime = {
	runtimeId: string;
	defaultAgentId: string;
	pid: number;
	registeredAt: number;
	/**
	 * Optional binding to a dashboard-side **Attachment** (one runner attached
	 * to this instance). Today this is unset and the gateway hosts one runtime
	 * total; once `job_assignment` carries `attachmentId`, multi-runtime
	 * support keys the binding map on it. See
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

export class RuntimeBindingStore {
	private current: RegisteredRuntime | null = null;
	private bindingState: RuntimeConnectionBinding | null = null;
	private staleTimer: NodeJS.Timeout | null = null;
	private staleSince: number | null = null;
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
	}): {registeredAt: number} {
		const previous = this.bindingState;
		const wasStale = previous?.state === 'stale';
		const staleSince = wasStale
			? (previous as {staleSince: number}).staleSince
			: null;

		if (!this.current) {
			this.current = {
				runtimeId: input.runtimeId,
				defaultAgentId: input.defaultAgentId,
				pid: input.pid,
				registeredAt: this.now(),
			};
		} else if (this.current.runtimeId === input.runtimeId) {
			this.current = {
				...this.current,
				defaultAgentId: input.defaultAgentId,
				pid: input.pid,
			};
		} else {
			throw new AlreadyRegisteredError(this.current);
		}

		const now = this.now();
		const isRebind =
			previous !== null &&
			(previous.state === 'stale' ||
				previous.connectionId !== input.connectionId);
		const lastRebindAt = isRebind ? now : previous?.lastRebindAt;
		const epoch = previous ? previous.epoch + (isRebind ? 1 : 0) : 1;
		this.bindingState = {
			state: 'active',
			connectionId: input.connectionId,
			boundAt: now,
			epoch,
			...maybeLastRebindAt(lastRebindAt),
		};

		this.clearStaleTimer();

		if (wasStale && staleSince !== null) {
			this.observers.onRuntimeRebind?.({
				runtimeId: input.runtimeId,
				gapMs: now - staleSince,
				epoch: this.bindingState.epoch,
			});
		}

		return {registeredAt: this.current.registeredAt};
	}

	/** Fully unregister a runtime. Throws NotRegisteredError if id does not match. */
	unbind(runtimeId: string): void {
		if (!this.current || this.current.runtimeId !== runtimeId) {
			throw new NotRegisteredError();
		}
		this.current = null;
		this.bindingState = null;
		this.clearStaleTimer();
	}

	/**
	 * Called when the transport connection closes.
	 * Returns the runtimeId if the close was for the current binding (caller should
	 * clear the push handle); returns null if the connectionId was not recognised.
	 */
	notifyConnectionClosed(connectionId: string): string | null {
		if (
			!this.current ||
			!this.bindingState ||
			this.bindingState.connectionId !== connectionId
		) {
			return null;
		}

		const runtimeId = this.current.runtimeId;
		const now = this.now();
		this.bindingState = {
			state: 'stale',
			connectionId,
			staleSince: now,
			epoch: this.bindingState.epoch,
			...maybeLastRebindAt(this.bindingState.lastRebindAt),
		};

		if (this.gracePeriodMs <= 0) {
			this.current = null;
			this.bindingState = null;
			this.observers.onRuntimeConnectionLost?.({runtimeId, graceful: false});
			return runtimeId;
		}

		this.staleSince = now;
		this.staleTimer = setTimeout(() => {
			this.expireStaleBinding(runtimeId);
		}, this.gracePeriodMs);
		return runtimeId;
	}

	stop(): void {
		this.clearStaleTimer();
	}

	// ── reads ─────────────────────────────────────────────────

	hasActiveBinding(runtimeId?: string): boolean {
		if (
			!this.current ||
			!this.bindingState ||
			this.bindingState.state !== 'active'
		) {
			return false;
		}
		return runtimeId === undefined || this.current.runtimeId === runtimeId;
	}

	getCurrent(): RegisteredRuntime | null {
		return this.current;
	}

	getBinding(): RuntimeConnectionBinding | null {
		return this.bindingState;
	}

	getRuntimeIdByConnection(connectionId: string): string | null {
		if (!this.current || !this.bindingState) return null;
		return this.bindingState.connectionId === connectionId
			? this.current.runtimeId
			: null;
	}

	// ── private ───────────────────────────────────────────────

	private expireStaleBinding(runtimeId: string): void {
		this.staleTimer = null;
		const since = this.staleSince;
		this.staleSince = null;
		if (
			!this.current ||
			this.current.runtimeId !== runtimeId ||
			this.hasActiveBinding(runtimeId)
		) {
			return;
		}
		this.current = null;
		this.bindingState = null;
		this.observers.onRuntimeConnectionLost?.({runtimeId, graceful: false});
		if (since !== null) {
			this.observers.onRuntimeExpired?.({runtimeId, gapMs: this.now() - since});
		}
	}

	private clearStaleTimer(): void {
		if (this.staleTimer) {
			clearTimeout(this.staleTimer);
			this.staleTimer = null;
		}
		this.staleSince = null;
	}
}
