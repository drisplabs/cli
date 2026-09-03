import {describe, it, expect} from 'vitest';
import {
	ISOLATION_PRESETS,
	resolveIsolationConfig,
	normalizeEffort,
	CLAUDE_EFFORT_LEVELS,
} from './isolation';

describe('normalizeEffort', () => {
	it('returns each supported reasoning level unchanged', () => {
		for (const level of CLAUDE_EFFORT_LEVELS) {
			expect(normalizeEffort(level)).toBe(level);
		}
	});

	it('returns undefined for an absent value', () => {
		expect(normalizeEffort(undefined)).toBeUndefined();
	});

	it('returns undefined for an unsupported level (no override)', () => {
		expect(normalizeEffort('turbo')).toBeUndefined();
		expect(normalizeEffort('')).toBeUndefined();
		expect(normalizeEffort('HIGH')).toBeUndefined();
	});
});

describe('ISOLATION_PRESETS', () => {
	it('guarded preset should allow core read/edit/search tools', () => {
		const preset = ISOLATION_PRESETS.guarded;
		expect(preset.allowedTools).toBeDefined();
		expect(preset.allowedTools).toContain('Read');
		expect(preset.allowedTools).toContain('Edit');
		expect(preset.allowedTools).toContain('Glob');
		expect(preset.allowedTools).toContain('Grep');
		expect(preset.allowedTools).toContain('Bash');
		// strict should NOT allow network or MCP tools
		expect(preset.allowedTools).not.toContain('WebSearch');
		expect(preset.allowedTools).not.toContain('WebFetch');
	});

	it('standard preset should allow core tools plus web, subagents, and MCP wildcard', () => {
		const preset = ISOLATION_PRESETS.standard;
		expect(preset.allowedTools).toBeDefined();
		// Core tools
		expect(preset.allowedTools).toContain('Read');
		expect(preset.allowedTools).toContain('Edit');
		expect(preset.allowedTools).toContain('Write');
		expect(preset.allowedTools).toContain('Bash');
		// Extended tools
		expect(preset.allowedTools).toContain('WebSearch');
		expect(preset.allowedTools).toContain('WebFetch');
		expect(preset.allowedTools).toContain('Task');
		expect(preset.allowedTools).toContain('Agent');
		// MCP wildcard — minimal allows project MCP servers, so must allow MCP tools
		expect(preset.allowedTools).toContain('mcp__*');
	});

	it('autonomous preset should allow all tools including MCP wildcard', () => {
		const preset = ISOLATION_PRESETS.autonomous;
		expect(preset.allowedTools).toBeDefined();
		expect(preset.allowedTools).toContain('WebSearch');
		expect(preset.allowedTools).toContain('Task');
		expect(preset.allowedTools).toContain('Agent');
		expect(preset.allowedTools).toContain('mcp__*');
	});

	it('all presets should enable strictMcpConfig', () => {
		expect(ISOLATION_PRESETS.guarded.strictMcpConfig).toBe(true);
		expect(ISOLATION_PRESETS.standard.strictMcpConfig).toBe(true);
		expect(ISOLATION_PRESETS.autonomous.strictMcpConfig).toBe(true);
	});
});

describe('resolveIsolationConfig', () => {
	it('should default to guarded preset when no config provided', () => {
		const config = resolveIsolationConfig();
		expect(config.allowedTools).toEqual(ISOLATION_PRESETS.guarded.allowedTools);
		expect(config.strictMcpConfig).toBe(true);
	});

	it.each([
		['strict', 'guarded'],
		['minimal', 'standard'],
		['permissive', 'autonomous'],
	])('still expands the deprecated preset name %s as %s (#185)', (from, to) => {
		expect(resolveIsolationConfig(from as never)).toEqual({
			...ISOLATION_PRESETS[to as keyof typeof ISOLATION_PRESETS],
		});
		expect(
			resolveIsolationConfig({preset: from as never}).allowedTools,
		).toEqual(
			ISOLATION_PRESETS[to as keyof typeof ISOLATION_PRESETS].allowedTools,
		);
	});

	it('should expand string preset', () => {
		const config = resolveIsolationConfig('autonomous');
		expect(config.allowedTools).toEqual(
			ISOLATION_PRESETS.autonomous.allowedTools,
		);
	});

	it('should allow custom config to override preset allowedTools', () => {
		const config = resolveIsolationConfig({
			preset: 'guarded',
			allowedTools: ['Read'],
		});
		// Custom allowedTools should override preset's
		expect(config.allowedTools).toEqual(['Read']);
	});

	it('should return custom config as-is when no preset specified', () => {
		const config = resolveIsolationConfig({
			allowedTools: ['Bash'],
			strictMcpConfig: true,
		});
		expect(config.allowedTools).toEqual(['Bash']);
	});
});
