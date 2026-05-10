/**
 * RelayCoordinator — broadcasts permission/question relay requests to every
 * registered channel adapter that advertises the corresponding capability,
 * races the per-adapter promises, and propagates cancellation to losers.
 *
 * Replaces the legacy in-host PermissionRelay/QuestionRelay/ChannelRegistry
 * trio. The coordinator does not own the adapters; the gateway daemon's
 * `ChannelManager` does. We accept an iterator factory so the coordinator
 * picks up adapters added after construction.
 *
 * Cancellation semantics:
 *   - Each broadcast spawns one AbortController per relay-capable adapter
 *     and awaits the first promise to resolve with a `verdict`/`answer`.
 *     All other controllers are aborted with the cancel reason; results
 *     coming back from those adapters after abort are ignored.
 *   - `cancel(channelRequestId, reason)` looks up the broadcast and aborts
 *     every controller. The pending request resolves with
 *     `{kind: 'cancelled', reason}`.
 *   - The internal TTL timer aborts all controllers and resolves the
 *     request with `{kind: 'cancelled', reason: 'timeout'}`.
 *
 * No relay-capable adapters? `request*` resolves with `{kind: 'no_relay'}`
 * so the caller can fall back to local-only resolution.
 *
 * Internal seams:
 *   - `PendingRegistry` (./pendingRegistry) owns the channelRequestId map,
 *     collision detection, settle, runtime-scoped cancel, and disposeAll.
 *   - The private `broadcast` helper owns the AbortController fanout, the
 *     TTL timer, the per-adapter promise wiring, and entry registration —
 *     parameterised so the two public methods specialise only the target
 *     filter, the request shape, and the success-shape extraction.
 */

import type {
	ChannelAdapter,
	PermissionRelayRequest,
	PermissionRelayResult,
	QuestionRelayRequest,
	QuestionRelayResult,
	RelayCancelReason,
} from '../../shared/gateway-protocol';
import {generateChannelRequestId} from '../../shared/gateway-protocol/channelRequestId';
import {
	PendingRegistry,
	collisionMessage,
	type AnyRelayResult,
	type PendingKind,
} from './pendingRegistry';

export const DEFAULT_RELAY_TTL_MS = 5 * 60_000;

export type AdapterSource = () => ReadonlyArray<ChannelAdapter>;

export type RelayCoordinatorOptions = {
	adapters: AdapterSource;
	defaultTtlMs?: number;
	now?: () => number;
	idFactory?: () => string;
	log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
};

export type PermissionBroadcast = {
	channelRequestId: string;
	result: Promise<PermissionRelayResult>;
};

export type QuestionBroadcast = {
	channelRequestId: string;
	result: Promise<QuestionRelayResult>;
};

export class RelayCoordinator {
	private readonly adapters: AdapterSource;
	private readonly defaultTtlMs: number;
	private readonly idFactory: () => string;
	private readonly log: RelayCoordinatorOptions['log'];
	private readonly registry = new PendingRegistry();

	constructor(opts: RelayCoordinatorOptions) {
		this.adapters = opts.adapters;
		this.defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_RELAY_TTL_MS;
		this.idFactory = opts.idFactory ?? generateChannelRequestId;
		this.log = opts.log;
	}

	requestPermission(
		req: Omit<PermissionRelayRequest, 'channelRequestId'> & {
			channelRequestId?: string;
			ttlMs?: number | null;
			runtimeId?: string;
		},
	): PermissionBroadcast {
		const channelRequestId = req.channelRequestId ?? this.idFactory();
		const targets = this.adapters().filter(
			a =>
				a.capabilities.relayPermission &&
				typeof a.requestPermissionVerdict === 'function',
		);
		if (targets.length === 0) {
			return {channelRequestId, result: Promise.resolve({kind: 'no_relay'})};
		}
		const fingerprint = permissionFingerprint(req);
		const inspect = this.registry.inspect(
			channelRequestId,
			'permission',
			fingerprint,
			req.runtimeId,
		);
		if (inspect.kind === 'collision') {
			throw new Error(
				collisionMessage(channelRequestId, inspect.reason, 'permission'),
			);
		}
		if (inspect.kind === 'attach') {
			return {
				channelRequestId,
				result: inspect.entry.result as Promise<PermissionRelayResult>,
			};
		}
		const fullReq: PermissionRelayRequest = {
			channelRequestId,
			toolName: req.toolName,
			description: req.description,
			inputPreview: req.inputPreview,
		};
		const result = this.broadcast({
			kind: 'permission',
			channelRequestId,
			ttlMs: req.ttlMs === null ? null : (req.ttlMs ?? this.defaultTtlMs),
			runtimeId: req.runtimeId,
			fingerprint,
			targets,
			perAdapter: async (adapter, signal) => {
				const res = await adapter.requestPermissionVerdict!(fullReq, signal);
				return res.kind === 'verdict' ? {...res, channelId: adapter.id} : null;
			},
		});
		return {channelRequestId, result: result as Promise<PermissionRelayResult>};
	}

	requestQuestion(
		req: Omit<QuestionRelayRequest, 'channelRequestId'> & {
			channelRequestId?: string;
			ttlMs?: number | null;
			runtimeId?: string;
		},
	): QuestionBroadcast {
		const channelRequestId = req.channelRequestId ?? this.idFactory();
		const targets = this.adapters().filter(
			a =>
				a.capabilities.relayQuestion &&
				typeof a.requestQuestionAnswer === 'function',
		);
		if (targets.length === 0) {
			return {channelRequestId, result: Promise.resolve({kind: 'no_relay'})};
		}
		const fingerprint = questionFingerprint(req);
		const inspect = this.registry.inspect(
			channelRequestId,
			'question',
			fingerprint,
			req.runtimeId,
		);
		if (inspect.kind === 'collision') {
			throw new Error(
				collisionMessage(channelRequestId, inspect.reason, 'question'),
			);
		}
		if (inspect.kind === 'attach') {
			return {
				channelRequestId,
				result: inspect.entry.result as Promise<QuestionRelayResult>,
			};
		}
		const fullReq: QuestionRelayRequest = {
			channelRequestId,
			title: req.title,
			questions: req.questions,
		};
		const result = this.broadcast({
			kind: 'question',
			channelRequestId,
			ttlMs: req.ttlMs === null ? null : (req.ttlMs ?? this.defaultTtlMs),
			runtimeId: req.runtimeId,
			fingerprint,
			targets,
			perAdapter: async (adapter, signal) => {
				const res = await adapter.requestQuestionAnswer!(fullReq, signal);
				return res.kind === 'answer' ? {...res, channelId: adapter.id} : null;
			},
		});
		return {channelRequestId, result: result as Promise<QuestionRelayResult>};
	}

	cancel(
		channelRequestId: string,
		reason: RelayCancelReason,
		expectedRuntimeId?: string,
	): boolean {
		return this.registry.cancel(channelRequestId, reason, expectedRuntimeId);
	}

	pendingCount(): number {
		return this.registry.count();
	}

	disposeAll(reason: RelayCancelReason = 'auto_resolved'): void {
		this.registry.disposeAll(reason);
	}

	private broadcast(args: {
		kind: PendingKind;
		channelRequestId: string;
		// null = no broadcast timeout (human-in-the-loop, e.g. AskUserQuestion).
		ttlMs: number | null;
		runtimeId: string | undefined;
		fingerprint: string;
		targets: ReadonlyArray<ChannelAdapter>;
		perAdapter: (
			adapter: ChannelAdapter,
			signal: AbortSignal,
		) => Promise<AnyRelayResult | null>;
	}): Promise<AnyRelayResult> {
		const {
			kind,
			channelRequestId,
			ttlMs,
			runtimeId,
			fingerprint,
			targets,
			perAdapter,
		} = args;
		const controllers = targets.map(() => new AbortController());
		let resolveFn!: (result: AnyRelayResult) => void;
		const result = new Promise<AnyRelayResult>(resolve => {
			resolveFn = resolve;
		});
		const timer =
			ttlMs === null
				? undefined
				: setTimeout(() => {
						this.registry.settle(channelRequestId, {
							kind: 'cancelled',
							reason: 'timeout',
						});
					}, ttlMs);
		if (timer && typeof timer.unref === 'function') timer.unref();
		this.registry.register({
			kind,
			channelRequestId,
			fingerprint,
			runtimeId,
			controllers,
			timer,
			resolve: resolveFn,
			result,
			settled: false,
		});

		targets.forEach((adapter, idx) => {
			const ctrl = controllers[idx]!;
			Promise.resolve()
				.then(() => perAdapter(adapter, ctrl.signal))
				.then(res => {
					if (res !== null) {
						this.registry.settle(channelRequestId, res);
					}
				})
				.catch(err => {
					this.log?.(
						'warn',
						`adapter ${adapter.id} ${kind} relay failed: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				});
		});

		return result;
	}
}

function permissionFingerprint(req: {
	toolName: string;
	description: string;
	inputPreview: string;
}): string {
	return JSON.stringify([req.toolName, req.description, req.inputPreview]);
}

function questionFingerprint(req: {
	title: string;
	questions: QuestionRelayRequest['questions'];
}): string {
	return JSON.stringify([req.title, req.questions]);
}
