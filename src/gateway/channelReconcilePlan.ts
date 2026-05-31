/**
 * Pure reconciliation decision for channel sidecars.
 *
 * Given the desired sidecar set plus the channels currently registered with the
 * `ChannelManager`, decide the ordered list of actions that reconciles current
 * state toward desired state. This owns stale detection and replacement
 * ordering as a side-effect-free function so the decision can be tested as
 * `(desired sidecars + current registrations) -> plan` without constructing a
 * `ChannelManager` or instantiating adapters. The `ChannelSidecarReconciler`
 * executes the plan; `ChannelManager` stays focused on running adapters.
 */

import type {ChannelSidecar} from '../infra/config/channels';

export type ChannelSidecarLoadError = {path: string; reason: string};

export type ChannelReconcileAction =
	| {kind: 'load-error'; id: string; path: string; reason: string}
	| {kind: 'unregister-stale'; id: string}
	| {kind: 'replace'; sidecar: ChannelSidecar}
	| {kind: 'register'; sidecar: ChannelSidecar};

export type ChannelReconcilePlan = {
	actions: ChannelReconcileAction[];
};

export type PlanChannelReconciliationInput = {
	desired: ChannelSidecar[];
	currentChannelIds: readonly string[];
	loadErrors: ChannelSidecarLoadError[];
	unregisterStale: boolean;
};

export function planChannelReconciliation(
	input: PlanChannelReconciliationInput,
): ChannelReconcilePlan {
	const actions: ChannelReconcileAction[] = [];

	for (const error of input.loadErrors) {
		actions.push({
			kind: 'load-error',
			id: pathIdFromSidecarPath(error.path),
			path: error.path,
			reason: error.reason,
		});
	}

	if (input.unregisterStale) {
		const desiredIds = new Set(
			input.desired.map(sidecar => sidecar.instanceId),
		);
		for (const id of input.currentChannelIds) {
			if (desiredIds.has(id)) continue;
			actions.push({kind: 'unregister-stale', id});
		}
	}

	const currentIds = new Set(input.currentChannelIds);
	for (const sidecar of input.desired) {
		actions.push(
			currentIds.has(sidecar.instanceId)
				? {kind: 'replace', sidecar}
				: {kind: 'register', sidecar},
		);
	}

	return {actions};
}

export function pathIdFromSidecarPath(filePath: string): string {
	const base = filePath.split(/[\\/]/).pop() ?? filePath;
	return base.endsWith('.json') ? base.slice(0, -'.json'.length) : base;
}
