/**
 * Hook controller — UI-decision logic for runtime events.
 *
 * Receives RuntimeEvents and returns ControllerResults with semantic
 * RuntimeDecisions. No transport/protocol imports.
 *
 * Evolves from eventHandlers.ts but operates on RuntimeEvent instead of
 * HandlerContext, and returns decisions instead of calling respond().
 */

import type {RuntimeEvent, RuntimeDecision} from '../runtime/types';
import {type HookRule, matchRule} from './rules';
import {isScopedPermissionsRequest} from './permission';

export type ControllerCallbacks = {
	getRules: () => HookRule[];
	enqueuePermission: (event: RuntimeEvent) => void;
	enqueueQuestion: (eventId: string) => void;
	/**
	 * Optional fan-out to remote channels (e.g. Telegram). Called only when a
	 * permission request reaches the user-prompt branch — rule-matched
	 * allow/deny short-circuit before this fires.
	 */
	relayPermission?: (event: RuntimeEvent) => void;
	/** Optional fan-out for AskUserQuestion / user_input prompts. */
	relayQuestion?: (event: RuntimeEvent) => void;
	/**
	 * Optional Handover interception (ADR 0014). Called when the harness is
	 * about to compact a Workflow Run's conversation (`compact.pre`). Return a
	 * reason string to block the compaction so the orchestrator can run a
	 * Handover instead; return null to let normal vendor compaction proceed.
	 * When absent (non-workflow session) the event is not handled and the
	 * adapter's timeout fires a passthrough — compaction proceeds unchanged.
	 */
	interceptCompaction?: (event: RuntimeEvent) => string | null;
	signal?: AbortSignal;
};

export type ControllerResult =
	| {handled: true; decision?: RuntimeDecision}
	| {handled: false};

export function handleEvent(
	event: RuntimeEvent,
	cb: ControllerCallbacks,
): ControllerResult {
	const eventKind = event.kind;
	const isScoped = isScopedPermissionsRequest(event.hookName);
	const eventData = event.data as Record<string, unknown>;
	const toolName =
		event.toolName ??
		(typeof eventData['tool_name'] === 'string'
			? eventData['tool_name']
			: undefined);

	if (eventKind === 'permission.request' && toolName === 'user_input') {
		cb.enqueueQuestion(event.id);
		cb.relayQuestion?.(event);
		return {handled: true};
	}

	// ── PermissionRequest: check rules, enqueue if no match ──
	if (eventKind === 'permission.request' && toolName) {
		const rule = matchRule(cb.getRules(), toolName);

		if (rule?.action === 'deny') {
			return {
				handled: true,
				decision: {
					type: 'json',
					source: 'rule',
					intent: {
						kind: 'permission_deny',
						reason: `Blocked by rule: ${rule.addedBy}`,
					},
				},
			};
		}

		if (rule?.action === 'approve') {
			return {
				handled: true,
				decision: {
					type: 'json',
					source: 'rule',
					intent: {kind: 'permission_allow'},
					// Scoped Codex permission grants are session-scoped under
					// auto rules so the same capability isn't re-prompted.
					...(isScoped ? {data: {scope: 'session'}} : {}),
				},
			};
		}

		cb.enqueuePermission(event);
		cb.relayPermission?.(event);
		return {handled: true};
	}

	// ── AskUserQuestion hijack ──
	if (eventKind === 'tool.pre' && toolName === 'AskUserQuestion') {
		cb.enqueueQuestion(event.id);
		cb.relayQuestion?.(event);
		return {handled: true};
	}

	// ── PreToolUse: deny-listed tools get blocked, everything else auto-allowed ──
	// In headless mode (claude -p) with --setting-sources "", a passthrough
	// leaves Claude with no permission config, so tools silently fail.
	// We must explicitly allow all non-denied tools.
	if (eventKind === 'tool.pre' && toolName) {
		const rule = matchRule(cb.getRules(), toolName);

		if (rule?.action === 'deny') {
			return {
				handled: true,
				decision: {
					type: 'json',
					source: 'rule',
					intent: {
						kind: 'pre_tool_deny',
						reason: `Blocked by rule: ${rule.addedBy}`,
					},
				},
			};
		}

		return {
			handled: true,
			decision: {
				type: 'json',
				source: 'rule',
				intent: {kind: 'pre_tool_allow'},
			},
		};
	}

	// ── PreCompact: a Handover orchestrator may block vendor compaction ──
	// Degrade, never hang: with no interceptor (or a null verdict) the event is
	// left unhandled, the adapter timeout fires a passthrough, and normal
	// vendor compaction proceeds.
	if (eventKind === 'compact.pre' && cb.interceptCompaction) {
		const reason = cb.interceptCompaction(event);
		if (reason !== null) {
			return {
				handled: true,
				decision: {
					type: 'json',
					source: 'rule',
					intent: {kind: 'compact_block', reason},
				},
			};
		}
		return {handled: false};
	}

	// Default: not handled — adapter timeout will auto-passthrough
	return {handled: false};
}
