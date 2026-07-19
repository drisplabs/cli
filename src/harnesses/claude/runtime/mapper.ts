/**
 * Maps HookEventEnvelope (Claude wire protocol) → RuntimeEvent (UI boundary).
 *
 * This is the ONLY file that imports Claude event type guards.
 * All protocol-specific knowledge is encapsulated here.
 */

import type {HookEventEnvelope} from '../protocol/envelope';
import type {RuntimeEvent} from '../../../core/runtime/types';
import {getInteractionHints} from './interactionRules';
import {translateClaudeEnvelope} from './eventTranslator';
import {buildClaudeDisplay} from './displayTitle';

function readEffortLevel(payload: Record<string, unknown>): string | undefined {
	const effort = payload['effort'];
	if (typeof effort !== 'object' || effort === null) return undefined;
	const level = (effort as Record<string, unknown>)['level'];
	return typeof level === 'string' ? level : undefined;
}

export function mapEnvelopeToRuntimeEvent(
	envelope: HookEventEnvelope,
): RuntimeEvent {
	const payload = envelope.payload as unknown;

	// Ensure payload is always an object
	const safePayload =
		typeof payload === 'object' && payload !== null
			? payload
			: {value: payload};
	const safePayloadRecord = safePayload as Record<string, unknown>;
	const translated = translateClaudeEnvelope(envelope);

	// Build context from base fields (always present on all hook events when known).
	const context: RuntimeEvent['context'] = {
		cwd: (safePayloadRecord['cwd'] as string | undefined) ?? '',
		transcriptPath:
			(safePayloadRecord['transcript_path'] as string | undefined) ?? '',
		permissionMode: safePayloadRecord['permission_mode'] as string | undefined,
	};

	return {
		id: envelope.request_id,
		timestamp: envelope.ts,
		kind: translated.kind,
		data: translated.data,
		hookName: envelope.hook_event_name,
		sessionId: envelope.session_id,
		// prompt_id is a Claude common input field (v2.1.196+) on every hook
		// payload; carried harness-neutrally as the Prompt identity (ADR 0009).
		promptId: safePayloadRecord['prompt_id'] as string | undefined,
		// `effort` is likewise a common input field ({level}), observed on
		// PostToolUse-class payloads and never on SessionStart, so it is read here
		// rather than in any one hook's translation.
		effortLevel: readEffortLevel(safePayloadRecord),
		toolName: translated.toolName,
		toolUseId: translated.toolUseId,
		agentId: translated.agentId,
		agentType: translated.agentType,
		context,
		interaction: getInteractionHints(translated.kind, translated.toolName),
		payload: safePayload,
		display: buildClaudeDisplay(translated.kind, translated.data),
	};
}
