/**
 * Effective personal capabilities resolver.
 *
 * Merges the personal capabilities (MCP servers + skills) configured in the
 * global and project layers into a single effective view, recording which
 * layer each entry came from. Precedence contract: **project overrides
 * global** on name collision.
 *
 * Issue 1 scope: personal-layer merge only. Overlap with workflow-plugin
 * capabilities is deferred to later issues (Issue 5 handles conflicts).
 */

import type {
	AthenaConfig,
	PersonalMcpServer,
	PersonalSkillEntry,
} from '../plugins/config';

/** Which config layer supplied an effective entry. */
export type CapabilitySourceLayer = 'global' | 'project';

/** A personal MCP server resolved to its effective name + source layer. */
export type EffectiveMcpServer = PersonalMcpServer & {
	name: string;
	sourceLayer: CapabilitySourceLayer;
};

/** A personal skill resolved to its effective source layer. */
export type EffectiveSkill = PersonalSkillEntry & {
	sourceLayer: CapabilitySourceLayer;
};

export type EffectiveCapabilities = {
	mcpServers: EffectiveMcpServer[];
	skills: EffectiveSkill[];
};

/**
 * Resolve the effective personal capabilities from the global and project
 * configs. Project entries override global entries that share a name; entries
 * unique to either layer are all included. Order: global-only entries first
 * (in config order), then project entries (overrides keep project position).
 */
export function resolveEffectiveCapabilities(input: {
	globalConfig: AthenaConfig;
	projectConfig: AthenaConfig;
}): EffectiveCapabilities {
	const {globalConfig, projectConfig} = input;

	return {
		mcpServers: mergeMcpServers(
			globalConfig.mcpServers,
			projectConfig.mcpServers,
		),
		skills: mergeSkills(globalConfig.skills, projectConfig.skills),
	};
}

function mergeMcpServers(
	global: AthenaConfig['mcpServers'],
	project: AthenaConfig['mcpServers'],
): EffectiveMcpServer[] {
	const projectNames = new Set(Object.keys(project ?? {}));
	const result: EffectiveMcpServer[] = [];

	for (const [name, server] of Object.entries(global ?? {})) {
		if (projectNames.has(name)) continue; // overridden by project
		result.push({name, ...server, sourceLayer: 'global'});
	}
	for (const [name, server] of Object.entries(project ?? {})) {
		result.push({name, ...server, sourceLayer: 'project'});
	}
	return result;
}

function mergeSkills(
	global: PersonalSkillEntry[] | undefined,
	project: PersonalSkillEntry[] | undefined,
): EffectiveSkill[] {
	const projectNames = new Set((project ?? []).map(s => s.name));
	const result: EffectiveSkill[] = [];

	for (const skill of global ?? []) {
		if (projectNames.has(skill.name)) continue; // overridden by project
		result.push({...skill, sourceLayer: 'global'});
	}
	for (const skill of project ?? []) {
		result.push({...skill, sourceLayer: 'project'});
	}
	return result;
}
