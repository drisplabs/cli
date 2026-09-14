import {expect, it} from 'vitest';
import {resolveExecutionSettings} from './resolveExecutionSettings';
import type {AthenaConfig} from '../../infra/plugins/config';
const defaults: AthenaConfig = {
	plugins: [],
	additionalDirectories: [],
	workflowMarketplaceSources: [],
	workflowSelections: {},
};
it('resolves settings without IO and reports precedence including a zero grace window', () => {
	const input = {
		globalConfig: {...defaults, model: 'global', permissionGraceMs: 100},
		projectConfig: {...defaults, model: 'project', permissionGraceMs: 0},
		workflow: {
			name: 'wf',
			plugins: [],
			promptTemplate: '{input}',
			model: 'workflow',
		},
		isolationPreset: 'guarded' as const,
	};
	const before = JSON.stringify(input);
	expect(resolveExecutionSettings(input)).toMatchObject({
		model: 'project',
		permissionGraceMs: 0,
		provenance: {model: 'project', permissionGraceMs: 'project'},
	});
	expect(JSON.stringify(input)).toBe(before);
});
it('preserves the existing workflow isolation floor and list order', () => {
	const resolved = resolveExecutionSettings({
		globalConfig: {...defaults, additionalDirectories: ['/a']},
		projectConfig: {...defaults, additionalDirectories: ['/b']},
		workflow: {
			name: 'wf',
			plugins: [],
			promptTemplate: '{input}',
			isolation: 'autonomous',
		},
		isolationPreset: 'guarded',
	});
	expect(resolved.isolationPreset).toBe('autonomous');
	expect(resolved.additionalDirectories).toEqual(['/a', '/b']);
	expect(resolved.warnings).toHaveLength(1);
});
