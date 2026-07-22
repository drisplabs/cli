/**
 * Plugin ref resolution (read path).
 *
 * Turns a config's `plugins` entries into resolved plugin directories. Each
 * entry is either a marketplace ref (`name@owner/repo`) or a local path.
 * `readConfig` resolves local paths against its baseDir but leaves marketplace
 * refs raw; this module resolves those refs through the Ensure cache policy
 * (clone-if-missing), so `readConfig` itself stays a pure parse with no path to
 * git. A ref that fails to resolve is skipped and reported as a warning for the
 * caller to surface — this module never writes to stderr.
 *
 * See CONTEXT.md -> Marketplace cache -> Plugin ref resolution.
 */

import {isMarketplaceRef, resolveMarketplacePlugin} from './marketplace';

export type PluginDirResolution = {
	/** Resolved absolute plugin directories, in input order. */
	dirs: string[];
	/** One message per marketplace ref that failed to resolve (and was skipped). */
	warnings: string[];
};

/**
 * Resolve config plugin entries into plugin directories. Non-marketplace
 * entries are assumed already absolute (resolved by `readConfig`) and pass
 * through unchanged; marketplace refs resolve through the Ensure cache policy.
 */
export function resolvePluginDirs(entries: string[]): PluginDirResolution {
	const dirs: string[] = [];
	const warnings: string[] = [];
	for (const entry of entries) {
		if (!isMarketplaceRef(entry)) {
			dirs.push(entry);
			continue;
		}
		try {
			dirs.push(resolveMarketplacePlugin(entry));
		} catch (error) {
			warnings.push(`Skipping plugin "${entry}": ${(error as Error).message}`);
		}
	}
	return {dirs, warnings};
}
