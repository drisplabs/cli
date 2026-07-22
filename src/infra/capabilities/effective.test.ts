import {describe, it, expect} from 'vitest';
import {resolveEffectiveCapabilities} from './effective';
import type {AthenaConfig} from '../plugins/config';

const empty: AthenaConfig = {plugins: [], additionalDirectories: []};

describe('resolveEffectiveCapabilities', () => {
	it('returns empty capabilities when neither layer configures any', () => {
		const result = resolveEffectiveCapabilities({
			globalConfig: empty,
			projectConfig: empty,
		});
		expect(result).toEqual({mcpServers: [], skills: []});
	});

	it('includes global-only and project-only MCP servers, tagged by source (AC4)', () => {
		const result = resolveEffectiveCapabilities({
			globalConfig: {...empty, mcpServers: {g: {command: 'g-cmd'}}},
			projectConfig: {...empty, mcpServers: {p: {command: 'p-cmd'}}},
		});
		expect(result.mcpServers).toEqual([
			{name: 'g', command: 'g-cmd', sourceLayer: 'global'},
			{name: 'p', command: 'p-cmd', sourceLayer: 'project'},
		]);
	});

	it('project MCP server overrides global on name collision (AC4)', () => {
		const result = resolveEffectiveCapabilities({
			globalConfig: {...empty, mcpServers: {db: {command: 'global-db'}}},
			projectConfig: {...empty, mcpServers: {db: {command: 'project-db'}}},
		});
		expect(result.mcpServers).toEqual([
			{name: 'db', command: 'project-db', sourceLayer: 'project'},
		]);
	});

	it('includes global-only and project-only skills, tagged by source (AC4)', () => {
		const result = resolveEffectiveCapabilities({
			globalConfig: {
				...empty,
				skills: [{name: 'g', source: 'gref', path: '/g'}],
			},
			projectConfig: {
				...empty,
				skills: [{name: 'p', source: 'pref', path: '/p'}],
			},
		});
		expect(result.skills).toEqual([
			{name: 'g', source: 'gref', path: '/g', sourceLayer: 'global'},
			{name: 'p', source: 'pref', path: '/p', sourceLayer: 'project'},
		]);
	});

	it('project skill overrides global on name collision (AC4)', () => {
		const result = resolveEffectiveCapabilities({
			globalConfig: {
				...empty,
				skills: [{name: 'fmt', source: 'gref', path: '/g/fmt'}],
			},
			projectConfig: {
				...empty,
				skills: [{name: 'fmt', source: 'pref', path: '/p/fmt'}],
			},
		});
		expect(result.skills).toEqual([
			{name: 'fmt', source: 'pref', path: '/p/fmt', sourceLayer: 'project'},
		]);
	});
});
