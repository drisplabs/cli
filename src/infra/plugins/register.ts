/**
 * Plugin registration orchestrator.
 *
 * Loads each plugin directory, registers the resulting commands,
 * and merges MCP server configs from all plugins into a single file.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {get, register} from '../../app/commands/registry';
import {loadPlugin, loadPersonalSkills} from './loader';
import type {McpServerChoices} from './config';
import type {
	EffectiveMcpServer,
	EffectiveSkill,
} from '../capabilities/effective';

/**
 * Personal capabilities (MCP servers + skills) that were shadowed by a
 * same-named workflow-plugin capability and therefore skipped. Loading
 * behavior is unchanged (plugin wins); this records what was dropped so the
 * reporting surfaces can surface it. Entries retain their `sourceLayer`;
 * downstream reporting strips to name + layer only.
 */
export type CapabilityConflicts = {
	mcpServers: EffectiveMcpServer[];
	skills: EffectiveSkill[];
};

export type PluginRegistrationResult = {
	mcpConfig?: string;
	conflicts: CapabilityConflicts;
};

export type BuildPluginMcpConfigResult = {
	mcpConfig?: string;
	/** Personal MCP servers skipped because a plugin server shares their name. */
	conflicts: EffectiveMcpServer[];
};

export function buildPluginMcpConfig(
	pluginDirs: string[],
	mcpServerOptions?: McpServerChoices,
	personalMcpServers: EffectiveMcpServer[] = [],
): BuildPluginMcpConfigResult {
	const mergedServers: Record<string, Record<string, unknown>> = {};
	const conflicts: EffectiveMcpServer[] = [];

	for (const dir of pluginDirs) {
		const mcpPath = path.join(dir, '.mcp.json');
		if (!fs.existsSync(mcpPath)) {
			continue;
		}

		const config = JSON.parse(fs.readFileSync(mcpPath, 'utf-8')) as {
			mcpServers?: Record<string, Record<string, unknown>>;
		};

		for (const [serverName, serverConfig] of Object.entries(
			config.mcpServers ?? {},
		)) {
			if (serverName in mergedServers) {
				throw new Error(
					`MCP server name collision: "${serverName}" is defined by multiple plugins. ` +
						'Each MCP server must have a unique name across all plugins.',
				);
			}

			const {options: _options, ...rest} = serverConfig;

			if (mcpServerOptions && serverName in mcpServerOptions) {
				const chosenEnv = mcpServerOptions[serverName];
				rest.env = {
					...(rest.env as Record<string, string> | undefined),
					...chosenEnv,
				};
			}

			mergedServers[serverName] = rest;
		}
	}

	// Merge personal MCP servers after workflow-plugin servers. On a name
	// collision the workflow plugin wins and the personal server is skipped
	// (provisional — conflict UX is owned by a later issue). The `name` and
	// `sourceLayer` bookkeeping fields are stripped before writing.
	for (const personal of personalMcpServers) {
		const {name, sourceLayer: _sourceLayer, ...server} = personal;
		if (name in mergedServers) {
			conflicts.push(personal);
			continue;
		}
		mergedServers[name] = server;
	}

	if (Object.keys(mergedServers).length === 0) {
		return {mcpConfig: undefined, conflicts};
	}

	const mcpConfig = path.join(os.tmpdir(), `athena-mcp-${process.pid}.json`);
	fs.writeFileSync(mcpConfig, JSON.stringify({mcpServers: mergedServers}));
	return {mcpConfig, conflicts};
}

/**
 * Load plugins from the given directories, register their commands,
 * and return merged MCP config + discovered workflows.
 *
 * When `mcpServerOptions` is provided, matching server entries get their
 * `env` merged with the user's chosen env overrides. The `options` field
 * is always stripped before writing — Claude Code doesn't understand it.
 */
export function registerPlugins(
	pluginDirs: string[],
	mcpServerOptions?: McpServerChoices,
	includeMcpConfig = true,
	personalMcpServers: EffectiveMcpServer[] = [],
	personalSkills: EffectiveSkill[] = [],
): PluginRegistrationResult {
	for (const dir of pluginDirs) {
		const commands = loadPlugin(dir);
		for (const command of commands) {
			register(command);
		}
	}

	// Register personal skills after workflow-plugin skills. On a name collision
	// the workflow plugin wins and the personal skill is skipped (provisional —
	// conflict UX is owned by a later issue). Pre-checking the registry avoids
	// register()'s throw-on-collision. The skipped entry is recorded as a
	// conflict, resolved back to its EffectiveSkill (for sourceLayer) by name.
	const skillByName = new Map(personalSkills.map(skill => [skill.name, skill]));
	const skillConflicts: EffectiveSkill[] = [];
	for (const command of loadPersonalSkills(personalSkills)) {
		if (get(command.name)) {
			const shadowed = skillByName.get(command.name);
			if (shadowed) {
				skillConflicts.push(shadowed);
			}
			continue;
		}
		register(command);
	}

	const mcpResult = includeMcpConfig
		? buildPluginMcpConfig(pluginDirs, mcpServerOptions, personalMcpServers)
		: {mcpConfig: undefined, conflicts: []};

	return {
		mcpConfig: mcpResult.mcpConfig,
		conflicts: {mcpServers: mcpResult.conflicts, skills: skillConflicts},
	};
}
