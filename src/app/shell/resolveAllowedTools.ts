import type {AthenaHarness} from '../../infra/plugins/config';
import {resolveHarnessAdapter} from '../../harnesses/registry';

// Tool names every harness gets allowed; 'mcp__*' uses the prefix wildcard in
// ruleMatches (see buildInitialRules). Per-harness extras come from the adapter.
const BASELINE_ALLOWED_TOOLS = ['mcp__*'];

/**
 * Merge the shared baseline plus this harness's extra allowed tools into the
 * caller's allowedTools, without duplicating.
 */
export function resolveAllowedTools(
	harness: AthenaHarness,
	allowedTools: string[] | undefined,
): string[] {
	const extras = [
		...BASELINE_ALLOWED_TOOLS,
		...resolveHarnessAdapter(harness).capabilities.extraAllowedTools,
	];
	const merged = [...(allowedTools ?? [])];
	for (const tool of extras) {
		if (!merged.includes(tool)) merged.push(tool);
	}
	return merged;
}
