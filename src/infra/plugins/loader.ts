/**
 * Plugin loader.
 *
 * Reads a plugin directory, discovers SKILL.md files, parses frontmatter,
 * and converts user-invocable skills into PromptCommands.
 */

import fs from 'node:fs';
import path from 'node:path';
import {type PluginManifest} from './types';
import {parseFrontmatter} from './frontmatter';
import {type PromptCommand} from '../../app/commands/types';
import {type EffectiveSkill} from '../capabilities/effective';

/**
 * Load a plugin from a directory and return PromptCommands for its
 * user-invocable skills.
 *
 * Throws if the directory or plugin.json is missing.
 * Returns an empty array if there is no skills/ directory.
 */
export function loadPlugin(pluginDir: string): PromptCommand[] {
	if (!fs.existsSync(pluginDir)) {
		throw new Error(`Plugin directory not found: ${pluginDir}`);
	}

	const manifestPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
	if (!fs.existsSync(manifestPath)) {
		throw new Error(`Plugin manifest not found: ${manifestPath}`);
	}

	// Validate manifest is readable JSON
	JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginManifest;

	const skillsDir = path.join(pluginDir, 'skills');
	if (!fs.existsSync(skillsDir)) {
		return [];
	}

	// Discover plugin MCP config
	const mcpConfigPath = path.join(pluginDir, '.mcp.json');
	const hasMcpConfig = fs.existsSync(mcpConfigPath);

	const commands: PromptCommand[] = [];

	const loadSkillFile = (skillPath: string): void => {
		const parsed = parseFrontmatter(fs.readFileSync(skillPath, 'utf-8'));
		if (!parsed.frontmatter['user-invocable']) return;
		commands.push(
			skillToCommand(
				parsed.frontmatter,
				parsed.body,
				hasMcpConfig ? mcpConfigPath : undefined,
			),
		);
	};

	for (const entry of fs.readdirSync(skillsDir, {withFileTypes: true})) {
		if (!entry.isDirectory()) continue;

		const entryDir = path.join(skillsDir, entry.name);
		const directSkill = path.join(entryDir, 'SKILL.md');

		if (fs.existsSync(directSkill)) {
			// Flat layout: skills/<skill>/SKILL.md
			loadSkillFile(directSkill);
			continue;
		}

		// Category layout: skills/<category>/<skill>/SKILL.md (one level deeper).
		// matt-pocock-skills groups skills under engineering/ and productivity/.
		for (const nested of fs.readdirSync(entryDir, {withFileTypes: true})) {
			if (!nested.isDirectory()) continue;
			const nestedSkill = path.join(entryDir, nested.name, 'SKILL.md');
			if (fs.existsSync(nestedSkill)) loadSkillFile(nestedSkill);
		}
	}

	return commands;
}

/**
 * Load personal skills (configured directly by the user, not via a plugin dir)
 * into PromptCommands. Each entry's `path` is the resolved skill directory
 * containing a SKILL.md.
 *
 * Unlike plugin skills, personal skills are loaded regardless of the
 * `user-invocable` frontmatter flag — installing a personal skill is itself the
 * opt-in to invoke it. A skill whose directory or SKILL.md is missing or
 * invalid is warned about and skipped (never throws), so a moved/deleted skill
 * dir can't break session startup.
 */
export function loadPersonalSkills(skills: EffectiveSkill[]): PromptCommand[] {
	const commands: PromptCommand[] = [];

	for (const skill of skills) {
		const skillPath = path.join(skill.path, 'SKILL.md');
		if (!fs.existsSync(skillPath)) {
			console.warn(
				`Skipping personal skill '${skill.name}' [${skill.sourceLayer}]: SKILL.md not found at ${skill.path}`,
			);
			continue;
		}
		try {
			const parsed = parseFrontmatter(fs.readFileSync(skillPath, 'utf-8'));
			commands.push(skillToCommand(parsed.frontmatter, parsed.body));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(
				`Skipping personal skill '${skill.name}' [${skill.sourceLayer}]: ${message}`,
			);
		}
	}

	return commands;
}

function skillToCommand(
	frontmatter: {
		name: string;
		description: string;
		'argument-hint'?: string;
	},
	body: string,
	mcpConfigPath?: string,
): PromptCommand {
	const args = frontmatter['argument-hint']
		? [
				{
					name: 'args',
					description: frontmatter['argument-hint'],
					required: false,
				},
			]
		: undefined;

	return {
		name: frontmatter.name,
		description: frontmatter.description,
		category: 'prompt',
		session: 'new',
		isolation: mcpConfigPath ? {mcpConfig: mcpConfigPath} : undefined,
		args,
		buildPrompt(argMap: Record<string, string>): string {
			const userArgs = argMap['args'] || '(none provided)';
			return body.replaceAll('$ARGUMENTS', userArgs);
		},
	};
}
