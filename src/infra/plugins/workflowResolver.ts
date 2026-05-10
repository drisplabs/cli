/**
 * Workflow source resolution — single source of truth.
 *
 * Owns: ref-shape detection, manifest traversal, version pinning, source
 * precedence, and ambiguity detection for workflow sources.
 *
 * Primitives that are shared with plugin resolution (readManifest, parseRef,
 * ensureRepo, …) remain in marketplaceShared.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
	ensureRepo,
	isMarketplaceRef,
	isMarketplaceSlug,
	parseRef,
	readManifest,
	requireGitForMarketplace,
	resolvePluginManifestPath,
	type MarketplaceEntry,
	type MarketplaceManifest,
} from './marketplaceShared';
import * as marketplaceShared from './marketplaceShared';
import {
	WorkflowAmbiguityError,
	WorkflowNotFoundError,
	WorkflowVersionNotFoundError,
	type WorkflowAmbiguityCandidate,
} from './workflowSourceErrors';

export {WorkflowVersionNotFoundError} from './workflowSourceErrors';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Origin of a workflow listing. Local listings intentionally have no
 * `name@owner/repo` marketplace ref: they aren't addressable via GitHub and
 * synthesising a fake `@local/<basename>` ref would mislead users.
 */
export type WorkflowListingSource =
	| {kind: 'remote'; slug: string; owner: string; repo: string}
	| {kind: 'local'; repoDir: string};

export type MarketplaceWorkflowListing = {
	name: string;
	description?: string;
	version?: string;
	workflowPath: string;
	/** Marketplace ref in `name@owner/repo` form. Only set for remote sources. */
	ref?: string;
	source: WorkflowListingSource;
};

export type WorkflowMarketplaceSource =
	| {kind: 'remote'; slug: string; owner: string; repo: string}
	| {kind: 'local'; path: string; repoDir: string};

export type ResolvedWorkflowSource =
	| {
			kind: 'marketplace-remote';
			slug: string;
			owner: string;
			repo: string;
			workflowName: string;
			version?: string;
			ref: string;
			manifestPath: string;
			workflowPath: string;
	  }
	| {
			kind: 'marketplace-local';
			repoDir: string;
			workflowName: string;
			version?: string;
			manifestPath: string;
			workflowPath: string;
	  }
	| {
			kind: 'filesystem';
			workflowPath: string;
	  };

// ── Manifest path resolution ───────────────────────────────────────────────

export function resolveWorkflowManifestPath(repoDir: string): string {
	const preferred = path.join(repoDir, '.athena-workflow', 'marketplace.json');
	const legacy = path.join(repoDir, '.claude-plugin', 'marketplace.json');
	return fs.existsSync(preferred) ? preferred : legacy;
}

export function formatWorkflowListingSource(
	source: WorkflowListingSource,
): string {
	return source.kind === 'remote' ? source.slug : `local:${source.repoDir}`;
}

// ── Manifest traversal ─────────────────────────────────────────────────────

function preferCanonicalWorkflowPath(
	repoDir: string,
	workflowPath: string,
): string {
	const relativePath = path.relative(repoDir, workflowPath);
	const segments = relativePath.split(path.sep);
	if (segments[0] !== '.workflows') return workflowPath;
	const canonical = path.join(repoDir, 'workflows', ...segments.slice(1));
	return fs.existsSync(canonical) ? canonical : workflowPath;
}

function resolveWorkflowEntryPath(
	entry: MarketplaceEntry,
	manifest: MarketplaceManifest,
	repoDir: string,
): string {
	if (typeof entry.source !== 'string') {
		throw new Error(
			`Workflow "${entry.name}" uses a remote source type which is not supported.`,
		);
	}

	let sourcePath = entry.source;
	const {workflowRoot} = manifest.metadata ?? {};
	if (
		workflowRoot &&
		!path.isAbsolute(sourcePath) &&
		!sourcePath.startsWith('./') &&
		!sourcePath.startsWith('../')
	) {
		sourcePath = path.join(workflowRoot, sourcePath);
	}

	const workflowPath = path.resolve(repoDir, sourcePath);
	if (
		!workflowPath.startsWith(repoDir + path.sep) &&
		workflowPath !== repoDir
	) {
		throw new Error(
			`Workflow "${entry.name}" source resolves outside the marketplace repo: ${workflowPath}`,
		);
	}

	const resolved = preferCanonicalWorkflowPath(repoDir, workflowPath);
	if (!fs.existsSync(resolved)) {
		throw new Error(`Workflow source not found: ${resolved}`);
	}
	return resolved;
}

export function resolveWorkflowPathFromManifest(
	workflowName: string,
	repoDir: string,
	manifestPath: string,
): string {
	const manifest = readManifest(manifestPath);
	const workflows = manifest.workflows ?? [];
	const entry = workflows.find(w => w.name === workflowName);
	if (!entry) {
		const available = workflows.map(w => w.name).join(', ') || '(none)';
		throw new Error(
			`Workflow "${workflowName}" not found in marketplace manifest ${manifestPath}. Available workflows: ${available}`,
		);
	}
	return resolveWorkflowEntryPath(entry, manifest, repoDir);
}

export function listWorkflowEntriesFromManifest(
	repoDir: string,
	manifestPath: string,
	source: WorkflowListingSource,
): MarketplaceWorkflowListing[] {
	const manifest = readManifest(manifestPath);
	const workflows = manifest.workflows ?? [];
	return workflows
		.filter(
			(entry): entry is MarketplaceEntry & {source: string} =>
				typeof entry.source === 'string',
		)
		.map(entry => ({
			name: entry.name,
			description: entry.description,
			version: entry.version,
			workflowPath: resolveWorkflowEntryPath(entry, manifest, repoDir),
			ref:
				source.kind === 'remote'
					? `${entry.name}@${source.owner}/${source.repo}`
					: undefined,
			source,
		}));
}

// ── Repo discovery ─────────────────────────────────────────────────────────

export function findMarketplaceRepoDir(startPath: string): string | undefined {
	let currentDir = path.resolve(startPath);
	for (;;) {
		if (
			fs.existsSync(resolveWorkflowManifestPath(currentDir)) ||
			fs.existsSync(resolvePluginManifestPath(currentDir))
		) {
			return currentDir;
		}
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return undefined;
		currentDir = parentDir;
	}
}

// ── High-level resolution ──────────────────────────────────────────────────

export function resolveWorkflowMarketplaceSource(
	source: string,
): WorkflowMarketplaceSource {
	const trimmed = source.trim();
	const resolvedPath = path.resolve(trimmed);

	if (!fs.existsSync(resolvedPath) && isMarketplaceSlug(trimmed)) {
		const slashIdx = trimmed.indexOf('/');
		return {
			kind: 'remote',
			slug: trimmed,
			owner: trimmed.slice(0, slashIdx),
			repo: trimmed.slice(slashIdx + 1),
		};
	}

	const repoDir = findMarketplaceRepoDir(trimmed);
	if (!repoDir) {
		throw new Error(
			`Local marketplace not found from source: ${trimmed}. Expected a marketplace repo root or a path inside one.`,
		);
	}
	return {kind: 'local', path: resolvedPath, repoDir};
}

export function listMarketplaceWorkflows(
	owner: string,
	repo: string,
): MarketplaceWorkflowListing[] {
	requireGitForMarketplace('workflows');
	const repoDir = ensureRepo(owner, repo);
	return listWorkflowEntriesFromManifest(
		repoDir,
		resolveWorkflowManifestPath(repoDir),
		{kind: 'remote', slug: `${owner}/${repo}`, owner, repo},
	);
}

export function listMarketplaceWorkflowsFromRepo(
	repoDir: string,
): MarketplaceWorkflowListing[] {
	return listWorkflowEntriesFromManifest(
		repoDir,
		resolveWorkflowManifestPath(repoDir),
		{kind: 'local', repoDir},
	);
}

export function resolveMarketplaceWorkflow(ref: string): string {
	requireGitForMarketplace('workflows');
	const {pluginName: workflowName, owner, repo} = parseRef(ref);
	const repoDir = ensureRepo(owner, repo);
	return resolveWorkflowPathFromManifest(
		workflowName,
		repoDir,
		resolveWorkflowManifestPath(repoDir),
	);
}

// ── Source gathering ───────────────────────────────────────────────────────

export function gatherMarketplaceWorkflowSources(
	source: string,
): ResolvedWorkflowSource[] {
	const trimmed = source.trim();
	const resolvedPath = path.resolve(trimmed);

	// Loose workflow.json file
	if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
		return [{kind: 'filesystem', workflowPath: fs.realpathSync(resolvedPath)}];
	}

	// Remote marketplace slug
	if (!fs.existsSync(resolvedPath) && isMarketplaceSlug(trimmed)) {
		const slashIdx = trimmed.indexOf('/');
		const owner = trimmed.slice(0, slashIdx);
		const repo = trimmed.slice(slashIdx + 1);
		requireGitForMarketplace('workflows');
		const repoDir = ensureRepo(owner, repo);
		const manifestPath = resolveWorkflowManifestPath(repoDir);
		return listWorkflowEntriesFromManifest(repoDir, manifestPath, {
			kind: 'remote',
			slug: trimmed,
			owner,
			repo,
		}).map(entry => ({
			kind: 'marketplace-remote' as const,
			slug: trimmed,
			owner,
			repo,
			workflowName: entry.name,
			version: entry.version,
			ref: entry.ref!,
			manifestPath,
			workflowPath: entry.workflowPath,
		}));
	}

	// Local marketplace directory
	const repoDir = findMarketplaceRepoDir(trimmed);
	if (!repoDir) {
		throw new Error(
			`Marketplace source not found: ${trimmed}. Expected a marketplace repo root, a path inside one, or an owner/repo slug.`,
		);
	}
	const canonicalRepoDir = fs.realpathSync(repoDir);
	const manifestPath = resolveWorkflowManifestPath(canonicalRepoDir);
	return listWorkflowEntriesFromManifest(canonicalRepoDir, manifestPath, {
		kind: 'local',
		repoDir: canonicalRepoDir,
	}).map(entry => ({
		kind: 'marketplace-local' as const,
		repoDir: canonicalRepoDir,
		workflowName: entry.name,
		version: entry.version,
		manifestPath,
		workflowPath: entry.workflowPath,
	}));
}

// ── Install resolution ─────────────────────────────────────────────────────

type ParsedWorkflowName = {bareName: string; pinnedVersion: string | undefined};

function parseBareWorkflowName(source: string): ParsedWorkflowName {
	const atIdx = source.indexOf('@');
	if (atIdx <= 0 || atIdx === source.length - 1) {
		return {bareName: source, pinnedVersion: undefined};
	}
	const suffix = source.slice(atIdx + 1);
	if (suffix.includes('/')) {
		// Looks like an owner/repo slug but failed isMarketplaceRef upstream.
		return {bareName: source, pinnedVersion: undefined};
	}
	return {bareName: source.slice(0, atIdx), pinnedVersion: suffix};
}

function resolvedSourceLabel(s: ResolvedWorkflowSource): string {
	if (s.kind === 'marketplace-remote') return `marketplace ${s.slug}`;
	if (s.kind === 'marketplace-local') return `local marketplace ${s.repoDir}`;
	return `file ${s.workflowPath}`;
}

function resolvedSourceDisambiguator(s: ResolvedWorkflowSource): string {
	if (s.kind === 'marketplace-remote') return s.ref;
	return s.workflowPath;
}

export function resolveWorkflowInstall(
	sourceOrName: string,
	configuredSources: string[],
): ResolvedWorkflowSource {
	// Marketplace ref: resolve directly, no ambiguity checking.
	if (isMarketplaceRef(sourceOrName)) {
		const {pluginName: workflowName, owner, repo} = parseRef(sourceOrName);
		marketplaceShared.requireGitForMarketplace('workflows');
		const repoDir = marketplaceShared.ensureRepo(owner, repo);
		const manifestPath = resolveWorkflowManifestPath(repoDir);
		const workflowPath = resolveWorkflowPathFromManifest(
			workflowName,
			repoDir,
			manifestPath,
		);
		const entry = listWorkflowEntriesFromManifest(repoDir, manifestPath, {
			kind: 'remote',
			slug: `${owner}/${repo}`,
			owner,
			repo,
		}).find(e => e.name === workflowName);
		return {
			kind: 'marketplace-remote',
			slug: `${owner}/${repo}`,
			owner,
			repo,
			workflowName,
			version: entry?.version,
			ref: sourceOrName,
			manifestPath,
			workflowPath,
		};
	}

	// Filesystem path to workflow.json.
	const resolvedPath = path.resolve(sourceOrName);
	if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
		return {kind: 'filesystem', workflowPath: fs.realpathSync(resolvedPath)};
	}

	// Bare name (optionally version-pinned): search all configured sources.
	const {bareName, pinnedVersion} = parseBareWorkflowName(sourceOrName);
	if (bareName.includes('/') || bareName.includes('\\')) {
		throw new Error(`Workflow source not found: ${sourceOrName}`);
	}

	const allListings: ResolvedWorkflowSource[] = [];
	let versionMismatch: WorkflowVersionNotFoundError | undefined;

	for (const configured of configuredSources) {
		let sources: ResolvedWorkflowSource[];
		try {
			sources = gatherMarketplaceWorkflowSources(configured);
		} catch {
			continue;
		}
		for (const src of sources) {
			if (
				(src.kind === 'marketplace-remote' ||
					src.kind === 'marketplace-local') &&
				src.workflowName === bareName
			) {
				if (pinnedVersion !== undefined && src.version !== pinnedVersion) {
					versionMismatch ??= new WorkflowVersionNotFoundError(
						bareName,
						pinnedVersion,
						src.version,
						resolvedSourceLabel(src),
					);
					continue;
				}
				allListings.push(src);
			}
		}
	}

	if (allListings.length === 0) {
		if (versionMismatch) throw versionMismatch;
		throw new WorkflowNotFoundError(bareName, configuredSources);
	}
	if (allListings.length > 1) {
		const candidates: WorkflowAmbiguityCandidate[] = allListings.map(s => ({
			sourceLabel: resolvedSourceLabel(s),
			disambiguator: resolvedSourceDisambiguator(s),
		}));
		throw new WorkflowAmbiguityError(bareName, candidates);
	}
	return allListings[0]!;
}
