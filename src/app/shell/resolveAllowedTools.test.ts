import {describe, expect, it} from 'vitest';
import {resolveAllowedTools} from './resolveAllowedTools';

describe('resolveAllowedTools', () => {
	it('adds only the shared baseline for Claude', () => {
		expect(resolveAllowedTools('claude-code', undefined)).toEqual(['mcp__*']);
	});

	it('adds the Codex extra tools on top of the baseline', () => {
		expect(resolveAllowedTools('openai-codex', undefined)).toEqual([
			'mcp__*',
			'Permissions',
			'Bash',
			'Edit',
		]);
	});

	it('merges into existing allowed tools without duplicating', () => {
		expect(resolveAllowedTools('openai-codex', ['Bash', 'CustomTool'])).toEqual(
			['Bash', 'CustomTool', 'mcp__*', 'Permissions', 'Edit'],
		);
	});
});
