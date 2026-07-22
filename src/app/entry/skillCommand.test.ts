import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
	resolvePersonalSkill,
	runSkillCommand,
	type SkillCommandDeps,
	type SkillCommandInput,
} from './skillCommand';

const TEST_PROJECT_DIR = '/test/project';

const emptyConfig = {
	plugins: [],
	additionalDirectories: [],
};

const resolvedSkill = {
	name: 'fmt',
	source: './skills/fmt',
	path: '/abs/skills/fmt',
};

function runCmd(
	input: Omit<SkillCommandInput, 'projectDir'>,
	deps: SkillCommandDeps = {},
): number {
	return runSkillCommand(
		{
			...input,
			projectDir: TEST_PROJECT_DIR,
		},
		deps,
	);
}

describe('runSkillCommand', () => {
	describe('install', () => {
		it('resolves a local skill and persists it to the global config by default', () => {
			const writeGlobalConfig = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue(emptyConfig);
			const resolveSkill = vi.fn().mockReturnValue(resolvedSkill);
			const logOut = vi.fn();

			const code = runCmd(
				{subcommand: 'install', subcommandArgs: ['./skills/fmt']},
				{readGlobalConfig, writeGlobalConfig, resolveSkill, logOut},
			);

			expect(code).toBe(0);
			expect(resolveSkill).toHaveBeenCalledWith(
				'./skills/fmt',
				TEST_PROJECT_DIR,
			);
			expect(writeGlobalConfig).toHaveBeenCalledWith({
				skills: [resolvedSkill],
			});
		});

		it('persists to the project config with --project', () => {
			const writeProjectConfig = vi.fn();
			const readProjectConfig = vi.fn().mockReturnValue(emptyConfig);
			const resolveSkill = vi.fn().mockReturnValue(resolvedSkill);

			const code = runCmd(
				{subcommand: 'install', subcommandArgs: ['./skills/fmt', '--project']},
				{readProjectConfig, writeProjectConfig, resolveSkill},
			);

			expect(code).toBe(0);
			expect(writeProjectConfig).toHaveBeenCalledWith(TEST_PROJECT_DIR, {
				skills: [resolvedSkill],
			});
		});

		it('errors and does not write when resolution fails', () => {
			const writeGlobalConfig = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue(emptyConfig);
			const resolveSkill = vi.fn().mockReturnValue({error: 'bad path'});
			const logError = vi.fn();

			const code = runCmd(
				{subcommand: 'install', subcommandArgs: ['./nope']},
				{readGlobalConfig, writeGlobalConfig, resolveSkill, logError},
			);

			expect(code).toBe(1);
			expect(writeGlobalConfig).not.toHaveBeenCalled();
			expect(logError).toHaveBeenCalledWith('bad path');
		});

		it('dedups by name and prints a notice when reinstalling', () => {
			const writeGlobalConfig = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue({
				...emptyConfig,
				skills: [
					{name: 'keep', source: 'a', path: '/a'},
					{name: 'fmt', source: 'old', path: '/old'},
				],
			});
			const resolveSkill = vi.fn().mockReturnValue(resolvedSkill);
			const logOut = vi.fn();

			const code = runCmd(
				{subcommand: 'install', subcommandArgs: ['./skills/fmt']},
				{readGlobalConfig, writeGlobalConfig, resolveSkill, logOut},
			);

			expect(code).toBe(0);
			expect(writeGlobalConfig).toHaveBeenCalledWith({
				skills: [{name: 'keep', source: 'a', path: '/a'}, resolvedSkill],
			});
			expect(logOut.mock.calls.some(([msg]) => /reinstall/i.test(msg))).toBe(
				true,
			);
		});

		it('rejects --project and --global together', () => {
			const writeGlobalConfig = vi.fn();
			const logError = vi.fn();

			const code = runCmd(
				{
					subcommand: 'install',
					subcommandArgs: ['./x', '--project', '--global'],
				},
				{writeGlobalConfig, logError},
			);

			expect(code).toBe(1);
			expect(writeGlobalConfig).not.toHaveBeenCalled();
			expect(logError).toHaveBeenCalled();
		});
	});

	describe('remove', () => {
		const populated = {
			...emptyConfig,
			skills: [
				{name: 'fmt', source: './skills/fmt', path: '/abs/fmt'},
				{name: 'keep', source: 'b', path: '/b'},
			],
		};

		it('removes by skill name from the global config', () => {
			const writeGlobalConfig = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue(populated);

			const code = runCmd(
				{subcommand: 'remove', subcommandArgs: ['fmt']},
				{readGlobalConfig, writeGlobalConfig},
			);

			expect(code).toBe(0);
			expect(writeGlobalConfig).toHaveBeenCalledWith({
				skills: [{name: 'keep', source: 'b', path: '/b'}],
			});
		});

		it('removes by source ref', () => {
			const writeGlobalConfig = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue(populated);

			const code = runCmd(
				{subcommand: 'remove', subcommandArgs: ['./skills/fmt']},
				{readGlobalConfig, writeGlobalConfig},
			);

			expect(code).toBe(0);
			expect(writeGlobalConfig).toHaveBeenCalledWith({
				skills: [{name: 'keep', source: 'b', path: '/b'}],
			});
		});

		it('errors and does not write when the skill is not found', () => {
			const writeGlobalConfig = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue(populated);
			const logError = vi.fn();

			const code = runCmd(
				{subcommand: 'remove', subcommandArgs: ['ghost']},
				{readGlobalConfig, writeGlobalConfig, logError},
			);

			expect(code).toBe(1);
			expect(writeGlobalConfig).not.toHaveBeenCalled();
			expect(logError).toHaveBeenCalled();
		});
	});

	describe('list', () => {
		const globalCfg = {
			...emptyConfig,
			skills: [
				{name: 'shared', source: 'g-shared', path: '/g/shared'},
				{name: 'onlyGlobal', source: 'g-only', path: '/g/only'},
			],
		};
		const projectCfg = {
			...emptyConfig,
			skills: [
				{name: 'shared', source: 'p-shared', path: '/p/shared'},
				{name: 'onlyProject', source: 'p-only', path: '/p/only'},
			],
		};

		function listLines(args: string[]): {code: number; out: string} {
			const logOut = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue(globalCfg);
			const readProjectConfig = vi.fn().mockReturnValue(projectCfg);
			const code = runCmd(
				{subcommand: 'list', subcommandArgs: args},
				{readGlobalConfig, readProjectConfig, logOut},
			);
			const out = logOut.mock.calls.map(([m]) => m).join('\n');
			return {code, out};
		}

		it('shows the effective merge with source layers by default', () => {
			const {code, out} = listLines([]);
			expect(code).toBe(0);
			expect(out).toMatch(/shared.*p-shared.*\[project\]/);
			expect(out).toMatch(/onlyGlobal.*\[global\]/);
			expect(out).toMatch(/onlyProject.*\[project\]/);
		});

		it('lists only the global layer with --global', () => {
			const {code, out} = listLines(['--global']);
			expect(code).toBe(0);
			expect(out).toContain('shared');
			expect(out).toContain('onlyGlobal');
			expect(out).not.toContain('onlyProject');
		});

		it('lists only the project layer with --project', () => {
			const {code, out} = listLines(['--project']);
			expect(code).toBe(0);
			expect(out).toContain('onlyProject');
			expect(out).not.toContain('onlyGlobal');
		});

		it('reports a none-state when nothing is configured', () => {
			const logOut = vi.fn();
			const readGlobalConfig = vi.fn().mockReturnValue(emptyConfig);
			const readProjectConfig = vi.fn().mockReturnValue(emptyConfig);
			const code = runCmd(
				{subcommand: 'list', subcommandArgs: []},
				{readGlobalConfig, readProjectConfig, logOut},
			);
			expect(code).toBe(0);
			const out = logOut.mock.calls.map(([m]) => m).join('\n');
			expect(out).toMatch(/none|no personal skill/i);
		});
	});
});

describe('resolvePersonalSkill', () => {
	const tmpDirs: string[] = [];

	afterEach(() => {
		for (const dir of tmpDirs.splice(0)) {
			fs.rmSync(dir, {recursive: true, force: true});
		}
	});

	function makeTmp(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-skill-'));
		tmpDirs.push(dir);
		return dir;
	}

	const SKILL_MD = '---\nname: fmt\ndescription: A formatter\n---\nbody';

	it('resolves a directory containing SKILL.md to an absolute entry', () => {
		const dir = makeTmp();
		const skillDir = path.join(dir, 'fmt');
		fs.mkdirSync(skillDir);
		fs.writeFileSync(path.join(skillDir, 'SKILL.md'), SKILL_MD);

		const result = resolvePersonalSkill(skillDir, dir);
		expect(result).toEqual({name: 'fmt', source: skillDir, path: skillDir});
	});

	it('resolves a relative path against the project dir', () => {
		const dir = makeTmp();
		const skillDir = path.join(dir, 'fmt');
		fs.mkdirSync(skillDir);
		fs.writeFileSync(path.join(skillDir, 'SKILL.md'), SKILL_MD);

		const result = resolvePersonalSkill('fmt', dir);
		expect(result).toEqual({name: 'fmt', source: 'fmt', path: skillDir});
	});

	it('accepts a direct SKILL.md file path', () => {
		const dir = makeTmp();
		const skillMd = path.join(dir, 'SKILL.md');
		fs.writeFileSync(skillMd, SKILL_MD);

		const result = resolvePersonalSkill(skillMd, dir);
		expect(result).toEqual({name: 'fmt', source: skillMd, path: dir});
	});

	it('errors when the path does not exist', () => {
		const dir = makeTmp();
		const result = resolvePersonalSkill(path.join(dir, 'missing'), dir);
		expect('error' in result).toBe(true);
	});

	it('errors when the directory has no SKILL.md', () => {
		const dir = makeTmp();
		const result = resolvePersonalSkill(dir, dir);
		expect('error' in result).toBe(true);
	});

	it('errors when the SKILL.md frontmatter is invalid', () => {
		const dir = makeTmp();
		fs.writeFileSync(path.join(dir, 'SKILL.md'), 'no frontmatter here');
		const result = resolvePersonalSkill(dir, dir);
		expect('error' in result).toBe(true);
	});
});
