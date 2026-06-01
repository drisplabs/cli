/**
 * Narrow refresh seam for remote marketplace caches.
 *
 * Given a remote marketplace identity (`owner/repo`), {@link refreshMarketplaceRepo}
 * returns a usable cached repo directory or a *classified* failure outcome,
 * hiding clone / pull / backup / reclone / classification behind one boundary.
 *
 * A recoverable cache failure (dirty, divergent, corrupt) self-heals via a
 * backup-then-reclone and still returns a usable checkout. An unrecoverable
 * failure is classified as either a connectivity/auth problem
 * (`network-or-auth`) or a cache that could not be rebuilt
 * (`unrecoverable-cache`), so callers can render a marketplace-named cause
 * instead of raw git output.
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {marketplaceRepoCacheDir} from './marketplaceShared';

export type MarketplaceRefreshFailureKind =
	| 'network-or-auth'
	| 'unrecoverable-cache';

export type MarketplaceRefreshOutcome =
	| {
			ok: true;
			repoDir: string;
			/** True when the cache was repaired (backup + reclone) rather than fast-forwarded. */
			selfHealed?: boolean;
			/** Where the replaced cache was preserved, set only on a self-heal. */
			backupDir?: string;
	  }
	| {
			ok: false;
			kind: MarketplaceRefreshFailureKind;
			/** `owner/repo`. */
			marketplace: string;
			/** Fully-formed, marketplace-named explanation safe to show a user. */
			message: string;
			/** Underlying git message, for diagnostics. */
			cause: string;
			/** Where the previous cache was preserved, when a reclone was attempted. */
			backupDir?: string;
	  };

/** Error wrapper for a classified refresh failure (mirrors workflowSourceErrors). */
export class MarketplaceRefreshError extends Error {
	readonly kind: MarketplaceRefreshFailureKind;
	readonly marketplace: string;

	constructor(outcome: Extract<MarketplaceRefreshOutcome, {ok: false}>) {
		super(outcome.message);
		this.name = 'MarketplaceRefreshError';
		this.kind = outcome.kind;
		this.marketplace = outcome.marketplace;
	}
}

const NETWORK_OR_AUTH_SIGNATURES = [
	'could not resolve host',
	'could not resolve proxy',
	'couldn’t resolve host',
	'name or service not known',
	'temporary failure in name resolution',
	'failed to connect',
	'connection timed out',
	'connection refused',
	'connection reset',
	'network is unreachable',
	'network unavailable',
	'unable to access',
	'ssl certificate problem',
	'gnutls_handshake',
	'authentication failed',
	'could not read username',
	'could not read password',
	'permission denied (publickey)',
	'terminal prompts disabled',
	'invalid username or password',
	'403 forbidden',
	'access denied',
	'repository not found',
	'remote: not found',
];

/**
 * Classify a raw git failure message as a connectivity/auth problem versus an
 * unrecoverable local-cache problem. Defaults to `unrecoverable-cache` when no
 * connectivity/auth signature is recognised.
 */
export function classifyGitFailure(
	message: string,
): MarketplaceRefreshFailureKind {
	const haystack = message.toLowerCase();
	for (const signature of NETWORK_OR_AUTH_SIGNATURES) {
		if (haystack.includes(signature)) {
			return 'network-or-auth';
		}
	}
	return 'unrecoverable-cache';
}

function repoUrlFor(owner: string, repo: string): string {
	return `https://github.com/${owner}/${repo}.git`;
}

// Capture git's stderr (stdout discarded) so failures can be classified by
// their actual diagnostic text rather than a generic "Command failed" line.
const GIT_STDIO: ['ignore', 'ignore', 'pipe'] = ['ignore', 'ignore', 'pipe'];

/**
 * Extract a classifiable, human-readable explanation from a failed git
 * invocation, preferring captured stderr over the generic Error message.
 */
function gitFailureText(error: unknown): string {
	const err = error as {message?: string; stderr?: Buffer | string};
	const stderr = err.stderr == null ? '' : err.stderr.toString().trim();
	const message = err.message ?? '';
	return stderr ? `${message} ${stderr}`.trim() : message;
}

function cloneInto(repoUrl: string, repoDir: string): void {
	fs.mkdirSync(repoDir, {recursive: true});
	try {
		execFileSync('git', ['clone', '--depth', '1', repoUrl, repoDir], {
			stdio: GIT_STDIO,
		});
	} catch (error) {
		fs.rmSync(repoDir, {recursive: true, force: true});
		throw error;
	}
}

function failureOutcome(
	kind: MarketplaceRefreshFailureKind,
	marketplace: string,
	cause: string,
	backupDir?: string,
): Extract<MarketplaceRefreshOutcome, {ok: false}> {
	const message =
		kind === 'network-or-auth'
			? `Could not refresh the "${marketplace}" marketplace: the remote could not be reached (connectivity or authentication problem). ${cause}`
			: `Could not refresh the "${marketplace}" marketplace: the cached copy is corrupt and could not be rebuilt.${backupDir ? ` Previous cache preserved at ${backupDir}.` : ''} ${cause}`;
	return {
		ok: false,
		kind,
		marketplace,
		message,
		cause,
		...(backupDir ? {backupDir} : {}),
	};
}

/**
 * Refresh a remote marketplace cache to a usable checkout, or return a
 * classified failure. Never throws for an expected git failure — failures are
 * reported through the returned outcome.
 */
export function refreshMarketplaceRepo(
	owner: string,
	repo: string,
): MarketplaceRefreshOutcome {
	const marketplace = `${owner}/${repo}`;
	const repoDir = marketplaceRepoCacheDir(owner, repo);
	const repoUrl = repoUrlFor(owner, repo);

	if (!fs.existsSync(repoDir)) {
		try {
			cloneInto(repoUrl, repoDir);
			return {ok: true, repoDir};
		} catch (cloneError) {
			const cause = gitFailureText(cloneError);
			return failureOutcome(classifyGitFailure(cause), marketplace, cause);
		}
	}

	try {
		execFileSync('git', ['pull', '--ff-only'], {
			cwd: repoDir,
			stdio: GIT_STDIO,
		});
		return {ok: true, repoDir};
	} catch {
		// Pull failed: the local cache may be dirty/divergent/corrupt. Preserve it
		// and try to rebuild a clean checkout (self-heal).
		const backupDir = `${repoDir}.backup-${Date.now()}`;
		try {
			fs.renameSync(repoDir, backupDir);
			cloneInto(repoUrl, repoDir);
			return {ok: true, repoDir, selfHealed: true, backupDir};
		} catch (recoveryError) {
			const cause = gitFailureText(recoveryError);
			return failureOutcome(
				classifyGitFailure(cause),
				marketplace,
				cause,
				backupDir,
			);
		}
	}
}

/**
 * Ensure the marketplace repo is cloned locally.
 * Only clones if repo doesn't exist. No automatic pull on startup.
 * Returns the absolute path to the cached repo directory.
 */
export function ensureRepo(owner: string, repo: string): string {
	const repoDir = marketplaceRepoCacheDir(owner, repo);

	if (!fs.existsSync(repoDir)) {
		const repoUrl = `https://github.com/${owner}/${repo}.git`;
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

	return repoDir;
}
