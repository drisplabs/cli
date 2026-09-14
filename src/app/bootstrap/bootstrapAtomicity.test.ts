import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, expect, it, vi} from 'vitest';
import {bootstrapRuntimeConfig} from './bootstrapConfig';
import {clear, get} from '../commands/registry';
import {releaseMcpAsset} from './executionAssets';

vi.mock('../../core/workflows/index', async () => ({
	...(await vi.importActual<typeof import('../../core/workflows/index')>(
		'../../core/workflows/index',
	)),
	resolveWorkflow: () => ({name: 'fixture', promptTemplate: '{prompt}'}),
	resolveWorkflowPlugins: () => ({resolvedPlugins: []}),
}));

const {resolveModelName} = vi.hoisted(() => ({resolveModelName: vi.fn()}));
vi.mock('../../harnesses/configProfiles', () => ({
	resolveHarnessConfigProfile: () => ({
		pluginDelivery: {
			mergeWorkflowPluginDirs: true,
			registrationBuildsMcpConfig: true,
			workflowPluginsVia: 'native',
		},
		buildIsolationConfig: () => ({preset: 'standard'}),
		resolveModelName,
	}),
}));

afterEach(() => {
	clear();
	vi.restoreAllMocks();
});

it('keeps the previous commands and releases new assets when later bootstrap validation fails', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drisp-bootstrap-'));
	const createdAssets: string[] = [];
	const mkdir = fs.mkdtempSync.bind(fs);
	vi.spyOn(fs, 'mkdtempSync').mockImplementation((prefix, ...options) => {
		const dir = mkdir(prefix, ...options);
		if (String(prefix).includes('drisp-mcp-')) createdAssets.push(String(dir));
		return dir;
	});
	function plugin(name: string) {
		const dir = path.join(root, name);
		fs.mkdirSync(path.join(dir, '.claude-plugin'), {recursive: true});
		fs.writeFileSync(
			path.join(dir, '.claude-plugin/plugin.json'),
			JSON.stringify({name, version: '1.0.0'}),
		);
		fs.mkdirSync(path.join(dir, 'skills', name), {recursive: true});
		fs.writeFileSync(
			path.join(dir, 'skills', name, 'SKILL.md'),
			`---\nname: ${name}\ndescription: Test\nuser-invocable: true\n---\nInstructions`,
		);
		fs.writeFileSync(
			path.join(dir, '.mcp.json'),
			JSON.stringify({mcpServers: {[name]: {command: 'example'}}}),
		);
		return dir;
	}
	const base = {
		projectDir: root,
		showSetup: false,
		isolationPreset: 'standard' as const,
		globalConfig: {plugins: [], additionalDirectories: []},
		projectConfig: {plugins: [], additionalDirectories: []},
	};
	let originalMcp: string | undefined;
	try {
		resolveModelName.mockReturnValue('model');
		const original = bootstrapRuntimeConfig({
			...base,
			pluginFlags: [plugin('original')],
		});
		originalMcp = original.pluginMcpConfig;
		expect(get('original')).toBeDefined();
		resolveModelName.mockImplementationOnce(() => {
			throw new Error('model validation failed');
		});
		expect(() =>
			bootstrapRuntimeConfig({...base, pluginFlags: [plugin('replacement')]}),
		).toThrow('model validation failed');
		expect(get('original')).toBeDefined();
		expect(get('replacement')).toBeUndefined();
		expect(createdAssets).toHaveLength(2);
		expect(fs.existsSync(createdAssets[0]!)).toBe(true);
		expect(fs.existsSync(createdAssets[1]!)).toBe(false);
	} finally {
		releaseMcpAsset(originalMcp);
		fs.rmSync(root, {recursive: true, force: true});
	}
});
