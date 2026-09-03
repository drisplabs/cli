/**
 * Installed-Workflow inventory: what this machine can run, as the runner
 * reports it to the hub (`hello.workflows`, `workflows.changed`; protocol
 * §17.4).
 *
 * The inventory is a read of the Workflow store (`~/.config/athena/workflows`,
 * one `{name}/workflow.json` plus its `source.json`) plus the built-ins that
 * ship with the CLI. It is tolerant where `resolveWorkflow()` is strict: a
 * Workflow whose files are unreadable is still listed by name, with whatever
 * version and source could be read, so the hub's picture of the machine never
 * silently loses an entry because one file is mid-write.
 */
import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import type {InstalledWorkflow, InstalledWorkflowSource} from '@drisp/protocol';
import {listBuiltinWorkflows} from './builtins/index';
import {workflowRegistryDir} from './registry';
import {readWorkflowSourceMetadata} from './sourceMetadata';
import type {WorkflowSourceMetadata} from './types';

export type InstalledWorkflowInventoryOptions = {
	/** The Workflow store. Defaults to the registry dir under the user's home. */
	storeDir?: string;
	/**
	 * Version reported for the built-in Workflows, which ship with (and are
	 * versioned by) the CLI. Omitted from the entry when unknown.
	 */
	cliVersion?: string;
};

function toProtocolSource(
	metadata: WorkflowSourceMetadata,
): InstalledWorkflowSource {
	switch (metadata.kind) {
		case 'marketplace-remote':
			return {kind: 'marketplace-remote', ref: metadata.ref};
		case 'marketplace-local':
			return {
				kind: 'marketplace-local',
				repoDir: metadata.repoDir,
				workflowName: metadata.workflowName,
			};
		case 'filesystem':
			return {kind: 'filesystem', path: metadata.path};
	}
}

function readDeclaredVersion(workflowDir: string): string | undefined {
	try {
		const raw = JSON.parse(
			fs.readFileSync(path.join(workflowDir, 'workflow.json'), 'utf-8'),
		) as unknown;
		if (typeof raw !== 'object' || raw === null) return undefined;
		const version = (raw as Record<string, unknown>)['version'];
		return typeof version === 'string' && version.length > 0
			? version
			: undefined;
	} catch {
		return undefined;
	}
}

function readInstalledEntry(storeDir: string, name: string): InstalledWorkflow {
	const workflowDir = path.join(storeDir, name);
	let metadata: WorkflowSourceMetadata | undefined;
	try {
		metadata = readWorkflowSourceMetadata(workflowDir);
	} catch {
		// An unreadable source.json is reported as an unknown source, not as a
		// missing Workflow.
		metadata = undefined;
	}
	// The Workflow's own declared version wins; a marketplace install that
	// pinned a version at install time is the fallback.
	const version =
		readDeclaredVersion(workflowDir) ??
		(metadata && metadata.kind !== 'filesystem' ? metadata.version : undefined);
	return {
		name,
		...(version !== undefined ? {version} : {}),
		source: metadata ? toProtocolSource(metadata) : {kind: 'unknown'},
	};
}

/**
 * Every Workflow this machine can run: the built-ins first, then the store,
 * sorted by name. An installed Workflow that shares a built-in's name shadows
 * it, exactly as `resolveWorkflow()` prefers the store over the built-ins.
 */
export function listInstalledWorkflows(
	options: InstalledWorkflowInventoryOptions = {},
): InstalledWorkflow[] {
	const storeDir = options.storeDir ?? workflowRegistryDir();
	let installedNames: string[] = [];
	try {
		installedNames = fs
			.readdirSync(storeDir, {withFileTypes: true})
			.filter(
				entry =>
					entry.isDirectory() &&
					fs.existsSync(path.join(storeDir, entry.name, 'workflow.json')),
			)
			.map(entry => entry.name)
			.sort();
	} catch {
		// No store yet: only the built-ins are installed.
	}
	const installed = new Set(installedNames);
	const builtins: InstalledWorkflow[] = listBuiltinWorkflows()
		.filter(name => !installed.has(name))
		.map(name => ({
			name,
			...(options.cliVersion !== undefined
				? {version: options.cliVersion}
				: {}),
			source: {kind: 'builtin'},
		}));
	return [
		...builtins,
		...installedNames.map(name => readInstalledEntry(storeDir, name)),
	];
}

export type InstalledWorkflowWatcher = {
	/** The inventory as of the last change the watcher observed (or its start). */
	current(): InstalledWorkflow[];
	close(): void;
};

export type WatchInstalledWorkflowsOptions =
	InstalledWorkflowInventoryOptions & {
		/** Called with the full new inventory whenever it differs from the last one. */
		onChange: (workflows: InstalledWorkflow[]) => void;
		/**
		 * Quiet period after the last filesystem event before the store is re-read,
		 * so an install (workflow.json, assets, source.json) reports once. Default
		 * 250ms.
		 */
		debounceMs?: number;
		/**
		 * Re-read cadence when the platform cannot watch the store directory
		 * (`fs.watch` unavailable or failing); unused otherwise. Default 5s.
		 */
		pollIntervalMs?: number;
		log?: (level: 'debug' | 'warn', message: string) => void;
	};

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Watch the Workflow store and report the full inventory whenever it changes:
 * an install, an upgrade, or a removal while the runner is connected. The
 * store is the source of truth (the install and remove commands run in their
 * own process), so the watcher observes the directory rather than the
 * commands; a watch failure degrades to polling instead of going silent.
 */
export function watchInstalledWorkflows(
	options: WatchInstalledWorkflowsOptions,
): InstalledWorkflowWatcher {
	const storeDir = options.storeDir ?? workflowRegistryDir();
	const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const log = options.log ?? (() => {});
	const inventoryOptions: InstalledWorkflowInventoryOptions = {
		storeDir,
		...(options.cliVersion !== undefined
			? {cliVersion: options.cliVersion}
			: {}),
	};

	let last = listInstalledWorkflows(inventoryOptions);
	let closed = false;
	let debounce: NodeJS.Timeout | null = null;
	let poll: NodeJS.Timeout | null = null;
	let watcher: fs.FSWatcher | null = null;

	function check(): void {
		if (closed) return;
		const next = listInstalledWorkflows(inventoryOptions);
		if (isDeepStrictEqual(next, last)) return;
		last = next;
		try {
			options.onChange(next);
		} catch (err) {
			log(
				'warn',
				`installed-workflow watcher: onChange threw: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	function schedule(): void {
		if (closed) return;
		if (debounce) clearTimeout(debounce);
		debounce = setTimeout(() => {
			debounce = null;
			check();
		}, debounceMs);
		debounce.unref();
	}

	function startPolling(reason: string): void {
		if (closed || poll) return;
		log(
			'warn',
			`installed-workflow watcher: cannot watch ${storeDir} (${reason}); polling every ${pollIntervalMs}ms`,
		);
		poll = setInterval(check, pollIntervalMs);
		poll.unref();
	}

	try {
		// The store may not exist until the first install; create it so the
		// watch has a directory to attach to (the registry creates it the same
		// way on install).
		fs.mkdirSync(storeDir, {recursive: true});
		watcher = fs.watch(storeDir, {recursive: true, persistent: false}, () =>
			schedule(),
		);
		watcher.on('error', err => {
			watcher?.close();
			watcher = null;
			startPolling(err.message);
		});
		log('debug', `installed-workflow watcher: watching ${storeDir}`);
	} catch (err) {
		startPolling(err instanceof Error ? err.message : String(err));
	}

	return {
		current: () => last,
		close() {
			closed = true;
			if (debounce) clearTimeout(debounce);
			if (poll) clearInterval(poll);
			watcher?.close();
			watcher = null;
		},
	};
}
