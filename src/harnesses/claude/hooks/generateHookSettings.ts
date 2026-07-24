/**
 * Hook Settings Generator
 *
 * Generates a temporary Claude Code settings file that configures
 * drisp-hook-forwarder as the hook handler for all hook events.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {fileURLToPath} from 'node:url';

/**
 * Hook events that require a matcher (tool-related events).
 */
export const TOOL_HOOK_EVENTS = [
	'PreToolUse',
	'PostToolUse',
	'PostToolUseFailure',
	// Batch-level, not per-tool, but Claude accepts (and requires) a matcher
	// here: the #116 capture registered it with `matcher: '*'` and it fired in
	// every run. Matcher-less registration is unverified.
	'PostToolBatch',
	'PermissionRequest',
	'PermissionDenied',
	'Elicitation',
	'ElicitationResult',
] as const;

/**
 * Hook events that don't require a matcher.
 *
 * FileChanged is intentionally NOT registered here: it requires explicit
 * literal file patterns rather than a wildcard matcher.
 */
export const NON_TOOL_HOOK_EVENTS = [
	'Notification',
	'Stop',
	'StopFailure',
	'SessionStart',
	'SessionEnd',
	'SubagentStart',
	'SubagentStop',
	'UserPromptSubmit',
	'UserPromptExpansion',
	'PreCompact',
	'PostCompact',
	'Setup',
	'CwdChanged',
	'TeammateIdle',
	'TaskCreated',
	'TaskCompleted',
	'ConfigChange',
	'InstructionsLoaded',
	'WorktreeCreate',
	'WorktreeRemove',
] as const;

/**
 * Hook events that must stay on Claude's critical path.
 *
 * A hook marked `async` runs in the background and Claude ignores its stdout,
 * so any event whose forwarder reply can change what Claude does next has to
 * be dispatched synchronously. Two reasons put an event in this set:
 *
 * 1. Decision/blocking events — the forwarder relays a permission decision or
 *    a block back to Claude. These are the events whose runtime kind carries
 *    `expectsDecision` or `canBlock` in `runtime/interactionRules.ts`.
 * 2. `SessionEnd` — not a decision hook, but a background hook still running
 *    when Claude exits is killed with it. Keeping session teardown synchronous
 *    is what guarantees the session-close event actually reaches the feed.
 */
export const SYNC_HOOK_EVENTS = [
	// Decision/blocking — kept in step with `runtime/interactionRules.ts`.
	'PreToolUse',
	'PermissionRequest',
	'UserPromptSubmit',
	'Stop',
	'StopFailure',
	'SubagentStop',
	'Elicitation',
	'ElicitationResult',
	'TeammateIdle',
	'TaskCreated',
	'TaskCompleted',
	'ConfigChange',
	// Handover interception (ADR 0014): the forwarder may reply with a
	// compaction block. Dispatched async, Claude would ignore the stdout and
	// silently drop the block.
	'PreCompact',
	// Teardown — see (2) above.
	'SessionEnd',
] as const;

const SYNC_HOOK_EVENT_SET: ReadonlySet<string> = new Set(SYNC_HOOK_EVENTS);

/**
 * Whether a hook event is dispatched off Claude's critical path.
 */
export function isAsyncHookEvent(event: string): boolean {
	return !SYNC_HOOK_EVENT_SET.has(event);
}

/**
 * Claude Code hook command configuration.
 */
type HookCommand = {
	type: 'command';
	command: string;
	timeout?: number;
	/** When true, Claude runs the hook in the background without blocking. */
	async?: true;
};

export type HookForwarderResolution = {
	command: string;
	executable: string;
	args: string[];
	source: 'bundled' | 'path';
	scriptPath?: string;
};

/**
 * Hook entry with matcher (for tool events).
 */
type MatchedHookEntry = {
	matcher: string;
	hooks: HookCommand[];
};

/**
 * Hook entry without matcher (for non-tool events).
 */
type UnmatchedHookEntry = {
	hooks: HookCommand[];
};

/**
 * Claude Code settings structure (partial - only hooks).
 */
type ClaudeSettings = {
	hooks: Record<string, (MatchedHookEntry | UnmatchedHookEntry)[]>;
	env?: Record<string, string>;
	apiKeyHelper?: string;
};

/**
 * Result from generating hook settings.
 */
export type GeneratedHookSettings = {
	/** Path to the generated temporary settings file */
	settingsPath: string;
	/** Cleanup function to remove the temp file */
	cleanup: () => void;
};

export type HookSettingsAuthOverlay = {
	env?: Record<string, string>;
	apiKeyHelper?: string;
};

export function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function formatHookForwarderCommand(
	nodePath: string,
	scriptPath: string,
): string {
	return `${quoteShellArg(nodePath)} ${quoteShellArg(scriptPath)}`;
}

function resolveHookForwarderPath(entryUrl: string): string | null {
	let currentDir = path.dirname(fileURLToPath(entryUrl));

	// Bundled layout: dist/cli.js + dist/hook-forwarder.js
	const siblingPath = path.join(currentDir, 'hook-forwarder.js');
	if (fs.existsSync(siblingPath)) {
		return siblingPath;
	}

	// Development/layout fallback: look for <root>/dist/hook-forwarder.js
	for (;;) {
		const candidatePath = path.join(currentDir, 'dist', 'hook-forwarder.js');
		if (fs.existsSync(candidatePath)) {
			return candidatePath;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) {
			return null;
		}

		currentDir = parentDir;
	}
}

/**
 * Finds the drisp-hook-forwarder executable path.
 */
export function resolveHookForwarderCommand(): HookForwarderResolution {
	const resolvedPath = resolveHookForwarderPath(import.meta.url);
	if (resolvedPath) {
		return {
			command: formatHookForwarderCommand(process.execPath, resolvedPath),
			executable: process.execPath,
			args: [resolvedPath],
			source: 'bundled',
			scriptPath: resolvedPath,
		};
	}

	// Fallback to global bin name (when installed via npm -g)
	return {
		command: 'drisp-hook-forwarder',
		executable: 'drisp-hook-forwarder',
		args: [],
		source: 'path',
	};
}

/**
 * Generates a temporary Claude Code settings file with athena hooks.
 *
 * @param tempDir - Optional temp directory (defaults to os.tmpdir())
 * @returns Generated settings with path and cleanup function
 */
export function generateHookSettings(
	tempDir?: string,
	authOverlay?: HookSettingsAuthOverlay | null,
): GeneratedHookSettings {
	const hookForwarder = resolveHookForwarderCommand();

	// Debug logging
	if (process.env['ATHENA_DEBUG']) {
		console.error('[athena-debug] Hook forwarder path:', hookForwarder.command);
	}

	const hookCommandFor = (event: string): HookCommand =>
		isAsyncHookEvent(event)
			? {type: 'command', command: hookForwarder.command, async: true}
			: {type: 'command', command: hookForwarder.command};

	// Build hooks configuration for all event types
	const hooks: ClaudeSettings['hooks'] = {};

	// Tool events require a matcher
	for (const event of TOOL_HOOK_EVENTS) {
		hooks[event] = [
			{
				matcher: '*',
				hooks: [hookCommandFor(event)],
			},
		];
	}

	// Non-tool events don't need a matcher
	for (const event of NON_TOOL_HOOK_EVENTS) {
		hooks[event] = [
			{
				hooks: [hookCommandFor(event)],
			},
		];
	}

	const settings: ClaudeSettings = {hooks};
	if (authOverlay?.env && Object.keys(authOverlay.env).length > 0) {
		settings.env = authOverlay.env;
	}
	if (authOverlay?.apiKeyHelper) {
		settings.apiKeyHelper = authOverlay.apiKeyHelper;
	}

	// Generate a unique temp file path
	const dir = tempDir ?? os.tmpdir();
	const filename = `athena-hooks-${process.pid}-${Date.now()}.json`;
	const settingsPath = path.join(dir, filename);

	// Write the settings file with owner-only permissions because it may carry
	// injected auth material (env vars or apiKeyHelper) in addition to hooks.
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), {
		encoding: 'utf8',
		mode: 0o600,
	});

	// Debug logging
	if (process.env['ATHENA_DEBUG']) {
		console.error('[athena-debug] Generated settings file:', settingsPath);
		console.error(
			'[athena-debug] Settings content:',
			JSON.stringify(settings, null, 2),
		);
	}

	// Return path and cleanup function
	return {
		settingsPath,
		cleanup: () => {
			try {
				if (fs.existsSync(settingsPath)) {
					fs.unlinkSync(settingsPath);
				}
			} catch {
				// Ignore cleanup errors
			}
		},
	};
}

/**
 * Registers a cleanup function to run on process exit.
 * Ensures temp files are cleaned up even on unexpected termination.
 */
export function registerCleanupOnExit(cleanup: () => void): void {
	const cleanupOnce = (() => {
		let cleaned = false;
		return () => {
			if (!cleaned) {
				cleaned = true;
				cleanup();
			}
		};
	})();

	process.once('exit', cleanupOnce);
	process.once('SIGINT', cleanupOnce);
	process.once('SIGTERM', cleanupOnce);
	process.once('uncaughtException', cleanupOnce);
}
