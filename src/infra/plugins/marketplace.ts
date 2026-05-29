/**
 * Marketplace plugin resolver — public entry points for plugin and workflow
 * source resolution. Implementation primitives live in `marketplaceShared.ts`,
 * `versionedPluginResolution.ts`, and `workflowResolver.ts`; this module
 * re-exports the public surface.
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {
	buildMarketplacePluginResolution,
	ensureRepo,
	isMarketplaceRef,
	isMarketplaceSlug,
	marketplaceRepoCacheDir,
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
 * Pull latest changes for a cached marketplace repo.
 * Call this explicitly when user requests an update.
 */
export function pullMarketplaceRepo(owner: string, repo: string): void {
	const repoDir = marketplaceRepoCacheDir(owner, repo);
	const repoUrl = `https://github.com/${owner}/${repo}.git`;

	if (!fs.existsSync(repoDir)) {
		cloneMarketplaceRepo(owner, repo, repoUrl, repoDir);
		return;
	}

	try {
		execFileSync('git', ['pull', '--ff-only'], {
			cwd: repoDir,
			stdio: 'ignore',
		});
		return;
	} catch (pullError) {
		const backupDir = `${repoDir}.backup-${Date.now()}`;
		try {
			fs.renameSync(repoDir, backupDir);
			cloneMarketplaceRepo(owner, repo, repoUrl, repoDir);
		} catch (recoveryError) {
			throw new Error(
				`Failed to refresh marketplace repo ${owner}/${repo}: ${(pullError as Error).message}. Recovery clone failed: ${(recoveryError as Error).message}. Preserved previous cache at ${backupDir}.`,
			);
		}
	}
}

function cloneMarketplaceRepo(
	owner: string,
	repo: string,
	repoUrl: string,
	repoDir: string,
): void {
	fs.mkdirSync(repoDir, {recursive: true});
	try {
		execFileSync('git', ['clone', '--depth', '1', repoUrl, repoDir], {
			stdio: 'ignore',
		});
	} catch (error) {
		fs.rmSync(repoDir, {recursive: true, force: true});
		throw new Error(
			`Failed to clone marketplace repo ${owner}/${repo}: ${(error as Error).message}`,
		);
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

export type {
	MarketplaceEntry,
	MarketplaceManifest,
	MarketplacePluginTarget,
	MarketplaceWorkflowListing,
	WorkflowListingSource,
	WorkflowMarketplaceSource,
};
