import {
	loadChannelSidecars,
	type ChannelSidecar,
	type LoadSidecarsResult,
} from '../infra/config/channels';
import {instantiateAdapter as defaultInstantiateAdapter} from './adapters/factory';
import type {InstantiateResult} from './adapters/factory';
import type {ChannelManager} from './channelManager';
import type {ChannelReloadResult} from '../shared/gateway-protocol';

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
		const results: ChannelReloadResult[] = [];
		const {sidecars, errors} = this.loadSidecars(this.home);

		for (const err of errors) {
			const id = pathIdFromSidecarPath(err.path);
			results.push({
				id,
				ok: false,
				action: 'failed',
				reason: err.reason,
			});
			if (opts.logFailures) {
				this.stderr(`athena-gateway: skipping ${err.path}: ${err.reason}\n`);
			}
		}

		if (opts.unregisterStale) {
			const sidecarIds = new Set(sidecars.map(sidecar => sidecar.instanceId));
			for (const channel of this.channelManager.listChannels()) {
				if (sidecarIds.has(channel.id)) continue;
				try {
					await this.channelManager.unregister(channel.id, 'shutdown');
					results.push({
						id: channel.id,
						ok: true,
						action: 'unregistered',
					});
				} catch (err) {
					const reason = errorReason(err);
					results.push({
						id: channel.id,
						ok: false,
						action: 'failed',
						reason,
					});
					if (opts.logFailures) {
						this.stderr(
							`athena-gateway: unregister ${channel.id} failed: ${reason}\n`,
						);
					}
				}
			}
		}

		for (const sidecar of sidecars) {
			const existed = this.channelManager
				.listChannels()
				.some(channel => channel.id === sidecar.instanceId);
			if (existed) {
				try {
					await this.channelManager.unregister(sidecar.instanceId, 'shutdown');
				} catch (err) {
					const reason = errorReason(err);
					results.push({
						id: sidecar.instanceId,
						ok: false,
						action: 'failed',
						reason,
					});
					if (opts.logFailures) {
						this.stderr(
							`athena-gateway: unregister ${sidecar.instanceId} failed: ${reason}\n`,
						);
					}
					continue;
				}
			}

			const built = this.instantiateAdapter(sidecar);
			if (!built.ok) {
				results.push({
					id: sidecar.instanceId,
					ok: false,
					action: 'failed',
					reason: built.reason,
				});
				if (opts.logFailures) {
					this.stderr(
						`athena-gateway: ${sidecar.instanceId}: ${built.reason}\n`,
					);
				}
				continue;
			}

			try {
				await this.channelManager.register(
					built.adapter,
					sidecar.attachmentId !== undefined
						? {attachmentId: sidecar.attachmentId}
						: {},
				);
				results.push({
					id: sidecar.instanceId,
					ok: true,
					action: existed ? 'replaced' : 'registered',
				});
				if (opts.logRegistrations) {
					this.stdout(`athena-gateway: registered ${sidecar.instanceId}\n`);
				}
			} catch (err) {
				const reason = errorReason(err);
				results.push({
					id: sidecar.instanceId,
					ok: false,
					action: 'failed',
					reason,
				});
				if (opts.logFailures) {
					this.stderr(
						`athena-gateway: register ${sidecar.instanceId} failed: ${reason}\n`,
					);
				}
			}
		}

		return {results};
	}
}

function pathIdFromSidecarPath(filePath: string): string {
	const base = filePath.split(/[\\/]/).pop() ?? filePath;
	return base.endsWith('.json') ? base.slice(0, -'.json'.length) : base;
}

function errorReason(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
