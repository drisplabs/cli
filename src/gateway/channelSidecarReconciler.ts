import {
	loadChannelSidecars,
	type ChannelSidecar,
	type LoadSidecarsResult,
} from '../infra/config/channels';
import {instantiateAdapter as defaultInstantiateAdapter} from './adapters/factory';
import type {InstantiateResult} from './adapters/factory';
import type {ChannelManager} from './channelManager';
import type {ChannelReloadResult} from '../shared/gateway-protocol';
import {
	planChannelReconciliation,
	type ChannelReconcileAction,
} from './channelReconcilePlan';

type ChannelSidecarLoader = (home?: string) => LoadSidecarsResult;
type ChannelSidecarInstantiator = (
	sidecar: ChannelSidecar,
) => InstantiateResult;

export type ChannelSidecarReconcilerOptions = {
	channelManager: ChannelManager;
	home?: string;
	loadSidecars?: ChannelSidecarLoader;
	instantiateAdapter?: ChannelSidecarInstantiator;
	stdout?: (message: string) => void;
	stderr?: (message: string) => void;
};

export type ChannelSidecarReconcileOptions = {
	unregisterStale: boolean;
	logFailures?: boolean;
	logRegistrations?: boolean;
};

export type ChannelSidecarReconcileResult = {
	results: ChannelReloadResult[];
};

export class ChannelSidecarReconciler {
	private readonly channelManager: ChannelManager;
	private readonly home: string | undefined;
	private readonly loadSidecars: ChannelSidecarLoader;
	private readonly instantiateAdapter: ChannelSidecarInstantiator;
	private readonly stdout: (message: string) => void;
	private readonly stderr: (message: string) => void;

	constructor(opts: ChannelSidecarReconcilerOptions) {
		this.channelManager = opts.channelManager;
		this.home = opts.home;
		this.loadSidecars = opts.loadSidecars ?? loadChannelSidecars;
		this.instantiateAdapter =
			opts.instantiateAdapter ?? defaultInstantiateAdapter;
		this.stdout = opts.stdout ?? (message => process.stdout.write(message));
		this.stderr = opts.stderr ?? (message => process.stderr.write(message));
	}

	async reconcile(
		opts: ChannelSidecarReconcileOptions,
	): Promise<ChannelSidecarReconcileResult> {
		const {sidecars, errors} = this.loadSidecars(this.home);
		const plan = planChannelReconciliation({
			desired: sidecars,
			currentChannelIds: this.channelManager
				.listChannels()
				.map(channel => channel.id),
			loadErrors: errors,
			unregisterStale: opts.unregisterStale,
		});

		const outcomes: ReconcileOutcome[] = [];
		for (const action of plan.actions) {
			outcomes.push(await this.executeAction(action));
		}

		// Operator-facing output is a projection of the reconciliation outcomes,
		// emitted in plan order once execution has settled.
		for (const outcome of outcomes) {
			if (!outcome.log) continue;
			const enabled =
				outcome.log.stream === 'err' ? opts.logFailures : opts.logRegistrations;
			if (!enabled) continue;
			const write = outcome.log.stream === 'err' ? this.stderr : this.stdout;
			write(outcome.log.message);
		}

		return {results: outcomes.map(outcome => outcome.result)};
	}

	private async executeAction(
		action: ChannelReconcileAction,
	): Promise<ReconcileOutcome> {
		switch (action.kind) {
			case 'load-error':
				return {
					result: {
						id: action.id,
						ok: false,
						action: 'failed',
						reason: action.reason,
					},
					log: {
						stream: 'err',
						message: `athena-gateway: skipping ${action.path}: ${action.reason}\n`,
					},
				};
			case 'unregister-stale':
				return this.executeUnregisterStale(action.id);
			case 'replace':
				return this.executeApply(action.sidecar, true);
			case 'register':
				return this.executeApply(action.sidecar, false);
		}
	}

	private async executeUnregisterStale(id: string): Promise<ReconcileOutcome> {
		try {
			await this.channelManager.unregister(id, 'shutdown');
			return {result: {id, ok: true, action: 'unregistered'}};
		} catch (err) {
			const reason = errorReason(err);
			return {
				result: {id, ok: false, action: 'failed', reason},
				log: {
					stream: 'err',
					message: `athena-gateway: unregister ${id} failed: ${reason}\n`,
				},
			};
		}
	}

	private async executeApply(
		sidecar: ChannelSidecar,
		existed: boolean,
	): Promise<ReconcileOutcome> {
		const id = sidecar.instanceId;
		if (existed) {
			try {
				await this.channelManager.unregister(id, 'shutdown');
			} catch (err) {
				const reason = errorReason(err);
				return {
					result: {id, ok: false, action: 'failed', reason},
					log: {
						stream: 'err',
						message: `athena-gateway: unregister ${id} failed: ${reason}\n`,
					},
				};
			}
		}

		const built = this.instantiateAdapter(sidecar);
		if (!built.ok) {
			return {
				result: {id, ok: false, action: 'failed', reason: built.reason},
				log: {
					stream: 'err',
					message: `athena-gateway: ${id}: ${built.reason}\n`,
				},
			};
		}

		try {
			await this.channelManager.register(
				built.adapter,
				sidecar.attachmentId !== undefined
					? {attachmentId: sidecar.attachmentId}
					: {},
			);
			return {
				result: {id, ok: true, action: existed ? 'replaced' : 'registered'},
				log: {
					stream: 'out',
					message: `athena-gateway: registered ${id}\n`,
				},
			};
		} catch (err) {
			const reason = errorReason(err);
			return {
				result: {id, ok: false, action: 'failed', reason},
				log: {
					stream: 'err',
					message: `athena-gateway: register ${id} failed: ${reason}\n`,
				},
			};
		}
	}
}

type ReconcileOutcome = {
	result: ChannelReloadResult;
	log?: {stream: 'out' | 'err'; message: string};
};

function errorReason(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
