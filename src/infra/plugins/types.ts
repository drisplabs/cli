/**
 * Plugin system types.
 */

export type PluginManifest = {
	name: string;
	description: string;
	version: string;
	author?: {name: string};
	repository?: string;
};

/** Frontmatter keys matching the YAML kebab-case convention in SKILL.md files. */
export type SkillFrontmatter = {
	name: string;
	description: string;
	'user-invocable'?: boolean;
	'argument-hint'?: string;
	'allowed-tools'?: string[];
};

export type ParsedSkill = {
	frontmatter: SkillFrontmatter;
	body: string;
};

export type LoadedPlugin = {
	manifest: PluginManifest;
	dir: string;
};

/** A reusable prompt definition discovered from a plugin; execution belongs to app. */
export type PluginPrompt = {
	name: string;
	description: string;
	category: 'prompt';
	aliases?: string[];
	args?: Array<{name: string; description: string; required: boolean}>;
	session: 'new' | 'resume';
	isolation?: {allowedTools?: string[]; mcpConfig?: string};
	buildPrompt: (args: Record<string, string>) => string;
};
