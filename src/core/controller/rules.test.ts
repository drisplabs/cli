import {describe, it, expect} from 'vitest';
import {buildUnattendedRules, matchRule, type HookRule} from './rules';

function makeRule(
	overrides: Partial<HookRule> & {toolName: string; action: HookRule['action']},
): HookRule {
	return {id: `rule-${Math.random()}`, addedBy: '/test', ...overrides};
}

describe('matchRule', () => {
	it('matches exact tool name', () => {
		const rules = [makeRule({toolName: 'Bash', action: 'approve'})];
		expect(matchRule(rules, 'Bash')).toBeDefined();
		expect(matchRule(rules, 'Bash')!.action).toBe('approve');
	});

	it('matches wildcard * rule', () => {
		const rules = [makeRule({toolName: '*', action: 'approve'})];
		expect(matchRule(rules, 'Bash')).toBeDefined();
		expect(matchRule(rules, 'mcp__server__action')).toBeDefined();
	});

	it('returns undefined when no rule matches', () => {
		const rules = [makeRule({toolName: 'Bash', action: 'approve'})];
		expect(matchRule(rules, 'Edit')).toBeUndefined();
	});

	it('deny rules take precedence over approve rules', () => {
		const rules = [
			makeRule({toolName: 'Bash', action: 'approve'}),
			makeRule({toolName: 'Bash', action: 'deny'}),
		];
		expect(matchRule(rules, 'Bash')!.action).toBe('deny');
	});

	it('ask rules take precedence over approve rules, including a wildcard (#189)', () => {
		const rules = [
			makeRule({toolName: '*', action: 'approve'}),
			makeRule({toolName: 'Bash', action: 'ask'}),
		];
		expect(matchRule(rules, 'Bash')!.action).toBe('ask');
		expect(matchRule(rules, 'Edit')!.action).toBe('approve');
	});

	it('deny rules still beat ask rules', () => {
		const rules = [
			makeRule({toolName: 'Bash', action: 'ask'}),
			makeRule({toolName: 'Bash', action: 'deny'}),
		];
		expect(matchRule(rules, 'Bash')!.action).toBe('deny');
	});

	describe('MCP server prefix matching', () => {
		it('matches mcp__server__* pattern against any action from that server', () => {
			const rules = [
				makeRule({
					toolName: 'mcp__agent-web-interface__*',
					action: 'approve',
				}),
			];
			expect(matchRule(rules, 'mcp__agent-web-interface__click')).toBeDefined();
			expect(
				matchRule(rules, 'mcp__agent-web-interface__navigate'),
			).toBeDefined();
			expect(matchRule(rules, 'mcp__agent-web-interface__type')).toBeDefined();
		});

		it('does not match different server with prefix pattern', () => {
			const rules = [
				makeRule({
					toolName: 'mcp__agent-web-interface__*',
					action: 'approve',
				}),
			];
			expect(matchRule(rules, 'mcp__other-server__click')).toBeUndefined();
		});

		it('matches plugin MCP prefix patterns', () => {
			const rules = [
				makeRule({
					toolName: 'mcp__plugin_web-testing-toolkit_agent-web-interface__*',
					action: 'approve',
				}),
			];
			expect(
				matchRule(
					rules,
					'mcp__plugin_web-testing-toolkit_agent-web-interface__click',
				),
			).toBeDefined();
		});

		it('deny prefix rules take precedence over approve prefix rules', () => {
			const rules = [
				makeRule({
					toolName: 'mcp__agent-web-interface__*',
					action: 'approve',
				}),
				makeRule({
					toolName: 'mcp__agent-web-interface__*',
					action: 'deny',
				}),
			];
			expect(matchRule(rules, 'mcp__agent-web-interface__click')!.action).toBe(
				'deny',
			);
		});
	});
});

describe('buildUnattendedRules (#189)', () => {
	it('autonomous answers every unclaimed permission with an allow rule', () => {
		const rules = buildUnattendedRules({preset: 'autonomous', askRules: []});
		expect(rules).toHaveLength(1);
		expect(rules[0]).toMatchObject({toolName: '*', action: 'approve'});
		expect(matchRule(rules, 'Bash')!.action).toBe('approve');
		expect(matchRule(rules, 'mcp__github__create_issue')!.action).toBe(
			'approve',
		);
	});

	it('guarded and standard seed no policy: an unclaimed permission holds for a person', () => {
		expect(buildUnattendedRules({preset: 'guarded', askRules: []})).toEqual([]);
		expect(buildUnattendedRules({preset: 'standard', askRules: []})).toEqual(
			[],
		);
		expect(buildUnattendedRules({preset: undefined, askRules: []})).toEqual([]);
	});

	it('an ask rule claims its tool ahead of the autonomous policy, named as written', () => {
		const rules = buildUnattendedRules({
			preset: 'autonomous',
			askRules: ['Bash', 'mcp__github__*'],
		});
		const bash = matchRule(rules, 'Bash')!;
		expect(bash.action).toBe('ask');
		expect(bash.toolName).toBe('Bash');
		expect(bash.addedBy).toContain('workflow ask rule "Bash"');
		expect(matchRule(rules, 'mcp__github__create_pull_request')!.action).toBe(
			'ask',
		);
		expect(matchRule(rules, 'Edit')!.action).toBe('approve');
	});
});
