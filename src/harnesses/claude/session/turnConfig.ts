import {
	type IsolationConfig,
	type IsolationPreset,
	resolveIsolationConfig,
} from '../config/isolation';
import type {TurnContinuation} from '../../../core/runtime/process';

/**
 * Merge isolation layers: base preset -> per-command override -> workflow/plugin MCP config.
 * Workflow/plugin mcpConfig must win to ensure selected workflow MCP settings are always applied.
 * Returns the original preset unchanged when no overrides are needed.
 *
 * Shared by both Claude session-controller shapes (interactive Ink hook and
 * non-interactive exec factory) so isolation resolution is defined once. See
 * ADR 0007.
 */
export function mergeIsolation(
	base: IsolationConfig | IsolationPreset | undefined,
	pluginMcpConfig: string | undefined,
	perCommand: Partial<IsolationConfig> | undefined,
): IsolationConfig | IsolationPreset | undefined {
	if (!pluginMcpConfig && !perCommand) return base;

	return {
		...resolveIsolationConfig(base),
		...(perCommand ?? {}),
		...(pluginMcpConfig ? {mcpConfig: pluginMcpConfig} : {}),
	};
}

/**
 * Resolve the Claude vendor session id for a Turn from its continuation.
 *
 * A Claude Turn always runs in a fresh Agent Session, so `fresh` (and no
 * continuation) yields `undefined`; `resume` forwards the handle; and
 * `reuse-current` is unsupported because Claude spawns a fresh child per Turn.
 * Shared by both Claude session-controller shapes. See ADR 0007.
 */
export function resolveClaudeSessionId(
	continuation: TurnContinuation | undefined,
): string | undefined {
	if (!continuation || continuation.mode === 'fresh') {
		return undefined;
	}

	if (continuation.mode === 'resume') {
		return continuation.handle;
	}

	throw new Error('Claude harness does not support reuse-current continuation');
}
