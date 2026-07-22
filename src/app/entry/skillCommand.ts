import fs from 'node:fs';
import path from 'node:path';
import {
	readConfig,
	readGlobalConfig,
	writeGlobalConfig,
	writeProjectConfig,
	type PersonalSkillEntry,
} from '../../infra/plugins/config';
import {parseFrontmatter} from '../../infra/plugins/frontmatter';
import {resolveEffectiveCapabilities} from '../../infra/capabilities/effective';

export type SkillCommandInput = {
	subcommand: string;
	subcommandArgs: string[];
	projectDir: string;
};

/**
 * Resolve a local skill reference (a directory containing SKILL.md, or the
 * SKILL.md file itself) into a persisted PersonalSkillEntry. Returns an error
 * when the path is missing or does not contain a valid SKILL.md.
 *
 * Remote refs (github:/npm:) are a deferred gap — `source` records the ref as
 * typed so a future installer can re-fetch.
 */
export function resolvePersonalSkill(
	ref: string,
	projectDir: string,
): PersonalSkillEntry | {error: string} {
	const absPath = path.isAbsolute(ref) ? ref : path.resolve(projectDir, ref);
	if (!fs.existsSync(absPath)) {
		return {error: `skill install: path not found: ${ref}`};
	}

	let skillDir: string;
	let skillMdPath: string;
	if (fs.statSync(absPath).isDirectory()) {
		skillDir = absPath;
		skillMdPath = path.join(absPath, 'SKILL.md');
	} else if (path.basename(absPath) === 'SKILL.md') {
		skillDir = path.dirname(absPath);
		skillMdPath = absPath;
	} else {
		return {
			error: `skill install: expected a directory containing SKILL.md or a SKILL.md file: ${ref}`,
		};
	}

	if (!fs.existsSync(skillMdPath)) {
		return {error: `skill install: no SKILL.md found at ${skillDir}`};
	}

	try {
		const {frontmatter} = parseFrontmatter(
			fs.readFileSync(skillMdPath, 'utf-8'),
		);
		return {name: frontmatter.name, source: ref, path: skillDir};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {error: `skill install: invalid SKILL.md (${message})`};
	}
}

export type SkillCommandDeps = {
	readGlobalConfig?: typeof readGlobalConfig;
	readProjectConfig?: typeof readConfig;
	writeGlobalConfig?: typeof writeGlobalConfig;
	writeProjectConfig?: typeof writeProjectConfig;
	resolveSkill?: typeof resolvePersonalSkill;
	logError?: (message: string) => void;
	logOut?: (message: string) => void;
};

type ParsedArgs = {
	project: boolean;
	global: boolean;
	positional: string[];
};

function parseArgs(
	args: string[],
	context: string,
): ParsedArgs | {error: string} {
	let project = false;
	let global = false;
	const positional: string[] = [];
	for (const arg of args) {
		if (arg === '--project') {
			project = true;
		} else if (arg === '--global') {
			global = true;
		} else if (arg.startsWith('--')) {
			return {error: `Unknown flag for skill ${context}: ${arg}`};
		} else {
			positional.push(arg);
		}
	}
	if (project && global) {
		return {
			error: `skill ${context}: --project and --global are mutually exclusive`,
		};
	}
	return {project, global, positional};
}

export function runSkillCommand(
	input: SkillCommandInput,
	deps: SkillCommandDeps = {},
): number {
	const readGlobal = deps.readGlobalConfig ?? readGlobalConfig;
	const readProject = deps.readProjectConfig ?? readConfig;
	const writeGlobal = deps.writeGlobalConfig ?? writeGlobalConfig;
	const writeProject = deps.writeProjectConfig ?? writeProjectConfig;
	const resolveSkill = deps.resolveSkill ?? resolvePersonalSkill;
	const logError = deps.logError ?? console.error;
	const logOut = deps.logOut ?? console.log;

	const {subcommand} = input;

	if (subcommand === 'install') {
		const parsed = parseArgs(input.subcommandArgs, 'install');
		if ('error' in parsed) {
			logError(parsed.error);
			return 1;
		}
		const ref = parsed.positional[0];
		if (!ref) {
			logError(
				'skill install: missing skill path. Usage: skill install <path>',
			);
			return 1;
		}
		const resolved = resolveSkill(ref, input.projectDir);
		if ('error' in resolved) {
			logError(resolved.error);
			return 1;
		}

		const layer = parsed.project ? 'project' : 'global';
		const existing =
			(layer === 'project'
				? readProject(input.projectDir).skills
				: readGlobal().skills) ?? [];
		// Dedup by name: drop any existing entry with the same skill name, then
		// append the freshly resolved entry.
		const overwriting = existing.some(s => s.name === resolved.name);
		const next = [...existing.filter(s => s.name !== resolved.name), resolved];
		if (layer === 'project') {
			writeProject(input.projectDir, {skills: next});
		} else {
			writeGlobal({skills: next});
		}
		logOut(
			`${overwriting ? 'Reinstalled' : 'Installed'} personal skill '${resolved.name}' [${layer}]`,
		);
		return 0;
	}

	if (subcommand === 'list') {
		const parsed = parseArgs(input.subcommandArgs, 'list');
		if ('error' in parsed) {
			logError(parsed.error);
			return 1;
		}

		const listSingleLayer = (
			skills: PersonalSkillEntry[],
			label: string,
		): void => {
			if (skills.length === 0) {
				logOut(`No personal skills configured (${label}).`);
				return;
			}
			logOut(`Personal skills (${label}):`);
			for (const skill of skills) {
				logOut(`  ${skill.name}  ${skill.source}`);
			}
		};

		if (parsed.global) {
			listSingleLayer(readGlobal().skills ?? [], 'global');
			return 0;
		}
		if (parsed.project) {
			listSingleLayer(readProject(input.projectDir).skills ?? [], 'project');
			return 0;
		}

		const {skills} = resolveEffectiveCapabilities({
			globalConfig: readGlobal(),
			projectConfig: readProject(input.projectDir),
		});
		if (skills.length === 0) {
			logOut('No personal skills configured.');
			return 0;
		}
		logOut('Personal skills (effective):');
		for (const skill of skills) {
			logOut(`  ${skill.name}  ${skill.source} [${skill.sourceLayer}]`);
		}
		return 0;
	}

	if (subcommand === 'remove') {
		const parsed = parseArgs(input.subcommandArgs, 'remove');
		if ('error' in parsed) {
			logError(parsed.error);
			return 1;
		}
		const target = parsed.positional[0];
		if (!target) {
			logError('skill remove: missing skill name or source');
			return 1;
		}
		const layer = parsed.project ? 'project' : 'global';
		const existing =
			(layer === 'project'
				? readProject(input.projectDir).skills
				: readGlobal().skills) ?? [];
		const next = existing.filter(s => s.name !== target && s.source !== target);
		if (next.length === existing.length) {
			logError(
				`skill remove: no personal skill '${target}' found in ${layer} config`,
			);
			return 1;
		}
		if (layer === 'project') {
			writeProject(input.projectDir, {skills: next});
		} else {
			writeGlobal({skills: next});
		}
		logOut(`Removed personal skill '${target}' [${layer}]`);
		return 0;
	}

	logError(`Unknown skill subcommand: ${subcommand}`);
	return 1;
}
