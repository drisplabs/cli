/**
 * Marketplace plugin resolver — public entry points for plugin and workflow
 * source resolution. Implementation primitives live in `marketplaceShared.ts`,
 * `versionedPluginResolution.ts`, and `workflowResolver.ts`; this module
 * re-exports the public surface.
 */

import {
	buildMarketplacePluginResolution,
	ensureRepo,
	isMarketplaceRef,
	isMarketplaceSlug,
	parseRef,
	requireGitForMarketplace,
	resolvePluginDirFromManifest,
	resolvePluginManifestPath,
	resolvePluginVersionFromDir,
	type MarketplaceEntry,
	type MarketplaceManifest,
	type MarketplacePluginTarget,
} from './marketplaceShared';
import {
	MarketplaceRefreshError,
	refreshMarketplaceRepo,
} from './marketplaceRefresh';
import {
	pluginNpmPackageName,
	refreshVersionedMarketplacePluginTarget,
	resolveVersionedMarketplacePluginTarget,
	resolveVersionedPluginDir,
} from './versionedPluginResolution';
import {
	findMarketplaceRepoDir,
	formatWorkflowListingSource,
	listMarketplaceWorkflows,
	listMarketplaceWorkflowsFromRepo,
	resolveMarketplaceWorkflow,
	resolveWorkflowManifestPath,
	resolveWorkflowMarketplaceSource,
	type MarketplaceWorkflowListing,
	type WorkflowListingSource,
	type WorkflowMarketplaceSource,
} from './workflowResolver';

/**
 * Pull latest changes for a cached marketplace repo, self-healing a recoverable
 * cache failure. Throws a {@link MarketplaceRefreshError} with a
 * marketplace-named, classified cause when no clean checkout can be produced.
 * Call this explicitly when the user requests an update.
 *
 * Prefer {@link refreshMarketplaceRepo} when you want to consume the classified
 * outcome without exception handling.
 */
export function pullMarketplaceRepo(owner: string, repo: string): void {
	const outcome = refreshMarketplaceRepo(owner, repo);
	if (!outcome.ok) {
		throw new MarketplaceRefreshError(outcome);
	}
}

export function resolveMarketplacePlugin(ref: string): string {
	requireGitForMarketplace('plugins');

	const {pluginName, owner, repo} = parseRef(ref);
	const repoDir = ensureRepo(owner, repo);
	return resolvePluginDirFromManifest(
		pluginName,
		repoDir,
		resolvePluginManifestPath(repoDir),
	);
}

export function resolveMarketplacePluginTarget(
	ref: string,
): MarketplacePluginTarget {
	requireGitForMarketplace('plugins');

	const {owner, repo} = parseRef(ref);
	const repoDir = ensureRepo(owner, repo);
	const directTarget = buildMarketplacePluginResolution(
		ref,
		repoDir,
		resolvePluginManifestPath(repoDir),
	);
	const pluginVersion = resolvePluginVersionFromDir(directTarget.pluginDir);
	if (!pluginVersion) {
		return directTarget;
	}

	return resolveVersionedMarketplacePluginTarget(ref, pluginVersion, repoDir);
}

export function resolveMarketplacePluginFromRepo(
	ref: string,
	repoDir: string,
): string {
	return resolveMarketplacePluginTargetFromRepo(ref, repoDir).pluginDir;
}

export function resolveMarketplacePluginTargetFromRepo(
	ref: string,
	repoDir: string,
): MarketplacePluginTarget {
	return buildMarketplacePluginResolution(
		ref,
		repoDir,
		resolvePluginManifestPath(repoDir),
	);
}

export {
	findMarketplaceRepoDir,
	formatWorkflowListingSource,
	isMarketplaceRef,
	isMarketplaceSlug,
	listMarketplaceWorkflows,
	listMarketplaceWorkflowsFromRepo,
	pluginNpmPackageName,
	refreshVersionedMarketplacePluginTarget,
	resolveMarketplaceWorkflow,
	resolveVersionedMarketplacePluginTarget,
	resolveVersionedPluginDir,
	resolveWorkflowManifestPath,
	resolveWorkflowMarketplaceSource,
};

export {
	resolveWorkflowInstall,
	gatherMarketplaceWorkflowSources,
	type ResolvedWorkflowSource,
} from './workflowResolver';
export {
	WorkflowAmbiguityError,
	WorkflowNotFoundError,
	WorkflowVersionNotFoundError,
	type WorkflowAmbiguityCandidate,
} from './workflowSourceErrors';

export {
	classifyGitFailure,
	MarketplaceRefreshError,
	refreshMarketplaceRepo,
	type MarketplaceRefreshFailureKind,
	type MarketplaceRefreshOutcome,
} from './marketplaceRefresh';

export type {
	MarketplaceEntry,
	MarketplaceManifest,
	MarketplacePluginTarget,
	MarketplaceWorkflowListing,
	WorkflowListingSource,
	WorkflowMarketplaceSource,
};
