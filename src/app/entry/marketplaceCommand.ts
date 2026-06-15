import {
	listMarketplaceWorkflows,
	listMarketplaceWorkflowsFromRepo,
	pullMarketplaceRepo,
	resolveWorkflowMarketplaceSource,
} from '../../infra/plugins/marketplace';
import {readGlobalConfig, writeGlobalConfig} from '../../infra/plugins/config';

const DEFAULT_MARKETPLACE_SLUG = 'lespaceman/athena-workflow-marketplace';

const USAGE = `Usage: athena-flow marketplace <subcommand>

Subcommands
  add <source>       Add a marketplace source (owner/repo or local path)
  refresh [source]   Refresh remote marketplace source(s)
  remove <source>    Remove a configured marketplace source
  list               List configured marketplace sources`;

export type MarketplaceCommandInput = {
	subcommand: string;
	subcommandArgs: string[];
};

export type MarketplaceCommandDeps = {
	listMarketplaceWorkflows?: typeof listMarketplaceWorkflows;
	listMarketplaceWorkflowsFromRepo?: typeof listMarketplaceWorkflowsFromRepo;
	pullMarketplaceRepo?: typeof pullMarketplaceRepo;
	resolveWorkflowMarketplaceSource?: typeof resolveWorkflowMarketplaceSource;
	readGlobalConfig?: typeof readGlobalConfig;
	writeGlobalConfig?: typeof writeGlobalConfig;
	logError?: (message: string) => void;
	logOut?: (message: string) => void;
};

export function runMarketplaceCommand(
	input: MarketplaceCommandInput,
	deps: MarketplaceCommandDeps = {},
): number {
	const listMarketplace =
		deps.listMarketplaceWorkflows ?? listMarketplaceWorkflows;
	const listMarketplaceFromRepo =
		deps.listMarketplaceWorkflowsFromRepo ?? listMarketplaceWorkflowsFromRepo;
	const pullMarketplace = deps.pullMarketplaceRepo ?? pullMarketplaceRepo;
	const resolveMarketplaceSource =
		deps.resolveWorkflowMarketplaceSource ?? resolveWorkflowMarketplaceSource;
	const readConfig = deps.readGlobalConfig ?? readGlobalConfig;
	const writeConfig = deps.writeGlobalConfig ?? writeGlobalConfig;
	const logError = deps.logError ?? console.error;
	const logOut = deps.logOut ?? console.log;

	const fmtError = (error: unknown): string =>
		`Error: ${error instanceof Error ? error.message : String(error)}`;

	switch (input.subcommand) {
		case 'add': {
			const source = input.subcommandArgs[0];
			if (!source) {
				logError('Usage: athena-flow marketplace add <source>');
				return 1;
			}
			try {
				const resolvedSource = resolveMarketplaceSource(source);

				// Validate by listing. Remote listing uses the clone-if-missing
				// ensure policy; explicit refresh is handled by `marketplace refresh`.
				if (resolvedSource.kind === 'remote') {
					listMarketplace(resolvedSource.owner, resolvedSource.repo);
				} else {
					listMarketplaceFromRepo(resolvedSource.repoDir);
				}

				const canonical =
					resolvedSource.kind === 'remote'
						? resolvedSource.slug
						: resolvedSource.repoDir;

				const existing = readConfig().workflowMarketplaceSources ?? [];
				if (existing.includes(canonical)) {
					logOut(`Marketplace already configured: ${canonical}`);
					return 0;
				}

				writeConfig({
					workflowMarketplaceSources: [...existing, canonical],
				});
				logOut(`Added marketplace: ${canonical}`);
				return 0;
			} catch (error) {
				logError(fmtError(error));
				return 1;
			}
		}

		case 'refresh': {
			const requested = input.subcommandArgs[0];
			const configuredSources = readConfig().workflowMarketplaceSources;
			const sources = requested
				? [requested]
				: configuredSources && configuredSources.length > 0
					? configuredSources
					: [DEFAULT_MARKETPLACE_SLUG];
			let failures = 0;

			for (const source of sources) {
				try {
					const resolvedSource = resolveMarketplaceSource(source);
					if (resolvedSource.kind === 'remote') {
						pullMarketplace(resolvedSource.owner, resolvedSource.repo);
						logOut(`Refreshed marketplace: ${resolvedSource.slug}`);
					} else {
						listMarketplaceFromRepo(resolvedSource.repoDir);
						logOut(
							`Local marketplace does not require refresh: ${resolvedSource.repoDir}`,
						);
					}
				} catch (error) {
					failures += 1;
					logError(fmtError(error));
				}
			}

			return failures > 0 ? 1 : 0;
		}

		case 'remove': {
			const source = input.subcommandArgs[0];
			if (!source) {
				logError('Usage: athena-flow marketplace remove <source>');
				return 1;
			}
			try {
				const existing = readConfig().workflowMarketplaceSources ?? [];
				const filtered = existing.filter(s => s !== source);
				if (filtered.length === existing.length) {
					logError(`Marketplace not found: ${source}`);
					return 1;
				}
				writeConfig({workflowMarketplaceSources: filtered});
				logOut(`Removed marketplace: ${source}`);
				return 0;
			} catch (error) {
				logError(fmtError(error));
				return 1;
			}
		}

		case 'list': {
			const sources = readConfig().workflowMarketplaceSources ?? [];
			if (sources.length === 0) {
				logOut(
					`No marketplace sources configured.\nDefault: ${DEFAULT_MARKETPLACE_SLUG}`,
				);
			} else {
				for (const source of sources) {
					logOut(source);
				}
			}
			return 0;
		}

		default:
			logError(USAGE);
			return 1;
	}
}
