import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {parseFrontmatter} from '../../../infra/plugins/frontmatter';
import {loadPlugin} from '../../../infra/plugins/loader';
import {
	DEFAULT_HANDOFF_FILE_PATH,
	ensureHandoffSkillPlugin,
} from './handoffSkill';

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-handoff-skill-'));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

describe('ensureHandoffSkillPlugin', () => {
	it('materializes a valid Claude Code plugin with a handoff skill', () => {
		const pluginDir = ensureHandoffSkillPlugin(makeTempDir());

		const manifestPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
		const skillPath = path.join(pluginDir, 'skills', 'handoff', 'SKILL.md');
		expect(fs.existsSync(manifestPath)).toBe(true);
		expect(fs.existsSync(skillPath)).toBe(true);

		const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
			name: string;
		};
		expect(manifest.name).toBe('athena-handoff');

		const parsed = parseFrontmatter(fs.readFileSync(skillPath, 'utf-8'));
		expect(parsed.frontmatter.name).toBe('handoff');
		expect(parsed.frontmatter.description).toBeTruthy();
	});

	it('covers the required Handoff file content and rules', () => {
		const pluginDir = ensureHandoffSkillPlugin(makeTempDir());
		const skill = fs.readFileSync(
			path.join(pluginDir, 'skills', 'handoff', 'SKILL.md'),
			'utf-8',
		);

		// The file the skill produces must carry: task + status, decisions and
		// rationale, open questions, files touched by path, suggested next steps.
		expect(skill).toMatch(/task and status/i);
		expect(skill).toMatch(/decisions and rationale/i);
		expect(skill).toMatch(/open questions/i);
		expect(skill).toMatch(/files touched/i);
		expect(skill).toMatch(/next steps/i);
		// Reference-don't-duplicate and secret redaction are rules, not hints.
		expect(skill).toMatch(/reference, don't duplicate/i);
		expect(skill).toMatch(/redact secrets/i);
		// A predictable default output path.
		expect(skill).toContain(DEFAULT_HANDOFF_FILE_PATH);
	});

	it('is idempotent — a second call leaves identical content in place', () => {
		const base = makeTempDir();
		const pluginDir = ensureHandoffSkillPlugin(base);
		const skillPath = path.join(pluginDir, 'skills', 'handoff', 'SKILL.md');
		const first = fs.statSync(skillPath).mtimeMs;
		const content = fs.readFileSync(skillPath, 'utf-8');

		expect(ensureHandoffSkillPlugin(base)).toBe(pluginDir);
		expect(fs.statSync(skillPath).mtimeMs).toBe(first);
		expect(fs.readFileSync(skillPath, 'utf-8')).toBe(content);
	});

	it('heals a modified or truncated skill file back to the bundled content', () => {
		const base = makeTempDir();
		const pluginDir = ensureHandoffSkillPlugin(base);
		const skillPath = path.join(pluginDir, 'skills', 'handoff', 'SKILL.md');
		fs.writeFileSync(skillPath, 'tampered', 'utf-8');

		ensureHandoffSkillPlugin(base);
		expect(fs.readFileSync(skillPath, 'utf-8')).toContain('# Handoff');
	});

	it('loads through the plugin loader without registering an athena slash command', () => {
		const pluginDir = ensureHandoffSkillPlugin(makeTempDir());

		// The plugin dir is valid for the delivery path (loadPlugin does not
		// throw), but the skill is not user-invocable in athena's own registry —
		// it is invoked inside the spawned Agent Session, not from the TUI.
		expect(loadPlugin(pluginDir)).toEqual([]);
	});
});
