/**
 * Hook rule types.
 *
 * Rules control how permission requests and PreToolUse events are handled
 * automatically. Deny rules are checked first, then ask, then approve. First
 * match wins.
 *
 * An `ask` rule (#189) *claims* a permission for a person: it neither allows
 * nor denies, it stops any approve rule — including a preset's answer-all
 * policy — from answering on a human's behalf. Attended, that is an ordinary
 * prompt; unattended, it parks the Run.
 */

import type {HarnessProcessPreset} from '../runtime/process';

export type RuleAction = 'deny' | 'ask' | 'approve';

export type HookRule = {
	id: string;
	toolName: string; // '*' for all tools
	action: RuleAction;
	addedBy: string; // command that created the rule
};

/**
 * Check if a rule's toolName pattern matches a given tool name.
 *
 * Supports three patterns:
 * - `*` — matches everything
 * - `mcp__server__*` — matches any action from that MCP server
 * - exact string — matches only that tool name
 */
function ruleMatches(ruleToolName: string, toolName: string): boolean {
	if (ruleToolName === '*') return true;
	if (ruleToolName === toolName) return true;

	// Prefix pattern: "mcp__server__*" matches "mcp__server__<anything>"
	if (ruleToolName.endsWith('__*')) {
		const prefix = ruleToolName.slice(0, -1); // "mcp__server__"
		return toolName.startsWith(prefix);
	}

	return false;
}

/**
 * Find the first matching rule for a tool name.
 * Deny rules are checked first, then ask, then approve. First match wins.
 */
export function matchRule(
	rules: HookRule[],
	toolName: string,
): HookRule | undefined {
	for (const action of ['deny', 'ask', 'approve'] as const) {
		const match = rules.find(
			r => r.action === action && ruleMatches(r.toolName, toolName),
		);
		if (match) return match;
	}
	return undefined;
}

/** How a workflow's ask rules are labelled where a fired rule is named. */
const ASK_RULE_SOURCE = 'workflow ask rule';

/**
 * The rules an unattended Run (`drisp run`, no hub attached) starts with:
 * the Workflow's **ask rules** first — each a tool-name pattern that forces a
 * human decision — then the isolation preset's policy for whatever no ask
 * rule claims. Only `autonomous` has such a policy (allow everything, within
 * the tool surface the preset already grants); `guarded` and `standard` seed
 * nothing, so an unclaimed permission holds for a person as before (#189).
 */
export function buildUnattendedRules(input: {
	preset: HarnessProcessPreset | undefined;
	askRules: readonly string[] | undefined;
}): HookRule[] {
	const rules: HookRule[] = (input.askRules ?? []).map(pattern => ({
		id: `ask:${pattern}`,
		toolName: pattern,
		action: 'ask',
		addedBy: `${ASK_RULE_SOURCE} "${pattern}"`,
	}));
	if (input.preset === 'autonomous') {
		rules.push({
			id: 'preset:autonomous',
			toolName: '*',
			action: 'approve',
			addedBy: 'isolation preset autonomous',
		});
	}
	return rules;
}
