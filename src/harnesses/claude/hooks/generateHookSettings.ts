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
import {HANDOFF_COMPACT_INSTRUCTIONS} from '../../../core/compaction/handoffInstructions';

/**
 * Hook events that require a matcher (tool-related events).
 */
export const TOOL_HOOK_EVENTS = [
	'PreToolUse',
	'PostToolUse',
	'PostToolUseFailure',
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
 * Claude Code hook command configuration.
 */
type HookCommand = {
	type: 'command';
	command: string;
	timeout?: number;
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

/**
 * Builds a hook command that emits the contents of a file to stdout via node.
 *
 * Claude Code treats a PreCompact hook's stdout (on exit 0) as custom compact
 * instructions. We read through node rather than `cat` so the command does not
 * depend on a POSIX shell having `cat` on PATH.
 */
export function formatInstructionEmitCommand(
	nodePath: string,
	instructionPath: string,
): string {
	const readScript = `process.stdout.write(require('fs').readFileSync(${JSON.stringify(
		instructionPath,
	)}, 'utf8'))`;
	return `${quoteShellArg(nodePath)} -e ${quoteShellArg(readScript)}`;
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

	const hookCommand: HookCommand = {
		type: 'command',
		command: hookForwarder.command,
	};

	// Build hooks configuration for all event types
	const hooks: ClaudeSettings['hooks'] = {};

	// Tool events require a matcher
	for (const event of TOOL_HOOK_EVENTS) {
		hooks[event] = [
			{
				matcher: '*',
				hooks: [hookCommand],
			},
		];
	}

	// Non-tool events don't need a matcher
	for (const event of NON_TOOL_HOOK_EVENTS) {
		hooks[event] = [
			{
				hooks: [hookCommand],
			},
		];
	}

	const dir = tempDir ?? os.tmpdir();

	// Inject handoff-style compact instructions. Claude Code appends a
	// PreCompact hook's stdout (exit 0) to its built-in compaction prompt, so we
	// write the instruction text to a file and add a second PreCompact hook that
	// emits it. This runs alongside the forwarder hook (observability), which
	// only ever passes through or blocks via exit codes.
	const instructionFilename = `athena-compact-instructions-${process.pid}-${Date.now()}.txt`;
	const instructionPath = path.join(dir, instructionFilename);
	fs.writeFileSync(instructionPath, HANDOFF_COMPACT_INSTRUCTIONS, {
		encoding: 'utf8',
		mode: 0o600,
	});
	hooks['PreCompact'] = [
		...(hooks['PreCompact'] ?? []),
		{
			hooks: [
				{
					type: 'command',
					command: formatInstructionEmitCommand(
						process.execPath,
						instructionPath,
					),
				},
			],
		},
	];

	const settings: ClaudeSettings = {hooks};
	if (authOverlay?.env && Object.keys(authOverlay.env).length > 0) {
		settings.env = authOverlay.env;
	}
	if (authOverlay?.apiKeyHelper) {
		settings.apiKeyHelper = authOverlay.apiKeyHelper;
	}

	// Generate a unique temp file path
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
			for (const filePath of [settingsPath, instructionPath]) {
				try {
					if (fs.existsSync(filePath)) {
						fs.unlinkSync(filePath);
					}
				} catch {
					// Ignore cleanup errors
				}
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
