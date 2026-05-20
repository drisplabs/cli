import {describe, it, expect} from 'vitest';
import {mapEnvelopeToRuntimeEvent} from '../mapper';
import type {HookEventEnvelope} from '../../protocol/envelope';
import {
	NON_TOOL_HOOK_EVENTS,
	TOOL_HOOK_EVENTS,
} from '../../hooks/generateHookSettings';

function makeEnvelope(
	overrides: Partial<Omit<HookEventEnvelope, 'payload'>> & {
		payload?: Record<string, unknown>;
	} = {},
): HookEventEnvelope {
	const {payload: payloadOverrides, ...rest} = overrides;
	return {
		request_id: 'req-1',
		ts: 1000,
		session_id: 'sess-1',
		hook_event_name: 'PreToolUse' as HookEventEnvelope['hook_event_name'],
		...rest,
		payload: {
			hook_event_name: 'PreToolUse',
			session_id: 'sess-1',
			transcript_path: '/tmp/t.jsonl',
			cwd: '/project',
			tool_name: 'Bash',
			tool_input: {command: 'ls'},
			tool_use_id: 'tu-1',
			...payloadOverrides,
		} as HookEventEnvelope['payload'],
	};
}

function payloadForHook(hookName: string): Record<string, unknown> {
	const base = {
		hook_event_name: hookName,
		session_id: 'sess-1',
		transcript_path: '/tmp/t.jsonl',
		cwd: '/project',
	};
	switch (hookName) {
		case 'PreToolUse':
		case 'PostToolUse':
		case 'PostToolUseFailure':
		case 'PermissionRequest':
		case 'PermissionDenied':
			return {
				...base,
				tool_name: 'Bash',
				tool_input: {command: 'pwd'},
				tool_use_id: 'tu-1',
				tool_response: {ok: true},
				error: 'failed',
				reason: 'denied',
			};
		case 'Elicitation':
			return {...base, mcp_server: 'server', form: {fields: []}};
		case 'ElicitationResult':
			return {...base, mcp_server: 'server', action: 'accept', content: {}};
		case 'SessionStart':
			return {...base, source: 'startup'};
		case 'SessionEnd':
			return {...base, reason: 'other'};
		case 'UserPromptSubmit':
			return {...base, prompt: 'hello'};
		case 'PreCompact':
		case 'PostCompact':
			return {...base, trigger: 'manual'};
		case 'Setup':
			return {...base, trigger: 'init'};
		case 'SubagentStart':
		case 'SubagentStop':
			return {
				...base,
				agent_id: 'agent-1',
				agent_type: 'Explore',
				stop_hook_active: false,
			};
		case 'TeammateIdle':
			return {...base, teammate_name: 'researcher', team_name: 'team'};
		case 'TaskCreated':
		case 'TaskCompleted':
			return {...base, task_id: 'task-1', task_subject: 'Do work'};
		case 'ConfigChange':
			return {...base, source: 'project_settings'};
		case 'CwdChanged':
			return {...base, cwd: '/project/subdir'};
		case 'InstructionsLoaded':
			return {
				...base,
				file_path: '/project/CLAUDE.md',
				memory_type: 'Project',
				load_reason: 'session_start',
			};
		case 'WorktreeCreate':
		case 'WorktreeRemove':
			return {...base, worktree_path: '/project/.worktrees/a'};
		default:
			return base;
	}
}

describe('mapEnvelopeToRuntimeEvent', () => {
	it('maps basic fields correctly', () => {
		const envelope = makeEnvelope();
		const event = mapEnvelopeToRuntimeEvent(envelope);

		expect(event.id).toBe('req-1');
		expect(event.timestamp).toBe(1000);
		expect(event.kind).toBe('tool.pre');
		expect(event.hookName).toBe('PreToolUse');
		expect(event.sessionId).toBe('sess-1');
	});

	it('extracts tool-related derived fields', () => {
		const envelope = makeEnvelope();
		const event = mapEnvelopeToRuntimeEvent(envelope);

		expect(event.toolName).toBe('Bash');
		expect(event.toolUseId).toBe('tu-1');
		expect(event.data).toEqual({
			tool_name: 'Bash',
			tool_input: {command: 'ls'},
			tool_use_id: 'tu-1',
		});
	});

	it('extracts subagent derived fields', () => {
		const envelope = makeEnvelope({
			hook_event_name: 'SubagentStart' as HookEventEnvelope['hook_event_name'],
			payload: {
				hook_event_name: 'SubagentStart',
				session_id: 'sess-1',
				transcript_path: '/tmp/t.jsonl',
				cwd: '/project',
				agent_id: 'agent-1',
				agent_type: 'Explore',
			},
		});
		const event = mapEnvelopeToRuntimeEvent(envelope);

		expect(event.agentId).toBe('agent-1');
		expect(event.agentType).toBe('Explore');
	});

	it('builds context from base fields', () => {
		const envelope = makeEnvelope();
		const event = mapEnvelopeToRuntimeEvent(envelope);

		expect(event.context.cwd).toBe('/project');
		expect(event.context.transcriptPath).toBe('/tmp/t.jsonl');
	});

	it('includes interaction hints', () => {
		const envelope = makeEnvelope();
		const event = mapEnvelopeToRuntimeEvent(envelope);

		expect(event.interaction.expectsDecision).toBe(true);
		expect(event.interaction.canBlock).toBe(true);
	});

	it('wraps non-object payloads', () => {
		const envelope = makeEnvelope();
		// Force a non-object payload for edge case
		(envelope as Record<string, unknown>).payload = 'raw-string';
		const event = mapEnvelopeToRuntimeEvent(envelope);

		expect(event.payload).toEqual({value: 'raw-string'});
	});

	it('surfaces Bash tool_input.description as display.title', () => {
		const envelope = makeEnvelope({
			payload: {
				hook_event_name: 'PreToolUse',
				session_id: 'sess-1',
				transcript_path: '/tmp/t.jsonl',
				cwd: '/project',
				tool_name: 'Bash',
				tool_input: {
					command: 'gh issue view 12',
					description: 'View GitHub issue #12',
				},
				tool_use_id: 'tu-1',
			},
		});
		const event = mapEnvelopeToRuntimeEvent(envelope);
		expect(event.display).toEqual({title: 'View GitHub issue #12'});
	});

	it('omits display when Bash has no description', () => {
		const envelope = makeEnvelope();
		const event = mapEnvelopeToRuntimeEvent(envelope);
		expect(event.display).toBeUndefined();
	});

	it('omits display for tools without a description field', () => {
		const envelope = makeEnvelope({
			payload: {
				hook_event_name: 'PreToolUse',
				session_id: 'sess-1',
				transcript_path: '/tmp/t.jsonl',
				cwd: '/project',
				tool_name: 'Read',
				tool_input: {file_path: '/foo.ts'},
				tool_use_id: 'tu-2',
			},
		});
		const event = mapEnvelopeToRuntimeEvent(envelope);
		expect(event.display).toBeUndefined();
	});

	it('handles unknown hook names with safe defaults', () => {
		const envelope = makeEnvelope({
			hook_event_name: 'FutureEvent' as HookEventEnvelope['hook_event_name'],
			payload: {
				hook_event_name: 'FutureEvent',
				session_id: 'sess-1',
				transcript_path: '/tmp/t.jsonl',
				cwd: '/project',
			},
		});
		const event = mapEnvelopeToRuntimeEvent(envelope);

		expect(event.hookName).toBe('FutureEvent');
		expect(event.kind).toBe('unknown');
		expect(event.data).toEqual({
			source_event_name: 'FutureEvent',
			payload: envelope.payload,
		});
		expect(event.interaction.expectsDecision).toBe(false);
		expect(event.interaction.canBlock).toBe(false);
	});

	it('maps every registered Claude hook to a first-class runtime kind', () => {
		const registeredHooks = [...TOOL_HOOK_EVENTS, ...NON_TOOL_HOOK_EVENTS];
		const seenRuntimeKinds = new Map<string, string>();

		for (const hookName of registeredHooks) {
			const envelope = makeEnvelope({
				hook_event_name: hookName as HookEventEnvelope['hook_event_name'],
				payload: payloadForHook(hookName),
			});
			const event = mapEnvelopeToRuntimeEvent(envelope);
			seenRuntimeKinds.set(hookName, event.kind);
			expect(event.kind, hookName).not.toBe('unknown');
		}

		expect(seenRuntimeKinds.get('InstructionsLoaded')).toBe(
			'instructions.loaded',
		);
		expect(seenRuntimeKinds.get('WorktreeCreate')).toBe('worktree.create');
		expect(seenRuntimeKinds.get('WorktreeRemove')).toBe('worktree.remove');
		expect(seenRuntimeKinds.get('WorktreeCreate')).not.toBe(
			seenRuntimeKinds.get('WorktreeRemove'),
		);
	});
});
