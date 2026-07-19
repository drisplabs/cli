import {describe, it, expect} from 'vitest';
import {mapEnvelopeToRuntimeEvent} from '../mapper';
import type {HookEventEnvelope} from '../../protocol/envelope';
import {
	NON_TOOL_HOOK_EVENTS,
	TOOL_HOOK_EVENTS,
	isAsyncHookEvent,
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
		case 'PostToolBatch':
			return {
				...base,
				permission_mode: 'default',
				tool_calls: [
					{
						tool_name: 'Read',
						tool_input: {file_path: '/tmp/a.txt'},
						tool_use_id: 'tu-1',
						tool_response: '1\ta\n',
					},
				],
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
		case 'UserPromptExpansion':
			return {
				...base,
				expansion_type: 'slash_command',
				command_name: 'greet',
				command_args: '',
				command_source: 'projectSettings',
				prompt: '/greet',
			};
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

	// `effort` is a Claude COMMON input field, not a SessionStart one: the #116
	// capture runs show it on PostToolUse-class payloads and never on
	// SessionStart. It is read once from the common base, like prompt_id/cwd.
	it('carries the common effort.level as effortLevel on any runtime event', () => {
		const envelope = makeEnvelope({
			hook_event_name: 'PostToolUse' as HookEventEnvelope['hook_event_name'],
			payload: {
				hook_event_name: 'PostToolUse',
				session_id: 'sess-1',
				transcript_path: '/tmp/t.jsonl',
				cwd: '/project',
				tool_name: 'Read',
				tool_input: {},
				tool_response: {},
				effort: {level: 'high'},
			},
		});
		const event = mapEnvelopeToRuntimeEvent(envelope);

		expect(event.effortLevel).toBe('high');
	});

	it('leaves effortLevel undefined when the payload carries no effort', () => {
		const envelope = makeEnvelope({
			hook_event_name: 'SessionStart' as HookEventEnvelope['hook_event_name'],
			payload: {
				hook_event_name: 'SessionStart',
				session_id: 'sess-1',
				transcript_path: '/tmp/t.jsonl',
				cwd: '/project',
				source: 'startup',
			},
		});
		const event = mapEnvelopeToRuntimeEvent(envelope);

		expect(event.effortLevel).toBeUndefined();
	});

	it('ignores a malformed effort field', () => {
		const envelope = makeEnvelope({
			hook_event_name: 'SessionStart' as HookEventEnvelope['hook_event_name'],
			payload: {
				hook_event_name: 'SessionStart',
				session_id: 'sess-1',
				transcript_path: '/tmp/t.jsonl',
				cwd: '/project',
				source: 'startup',
				effort: 'high',
			},
		});
		const event = mapEnvelopeToRuntimeEvent(envelope);

		expect(event.effortLevel).toBeUndefined();
	});

	// Field names below are pinned to the real payload captured in the #116
	// spike (src/harnesses/claude/protocol/__fixtures__/hook-payloads/
	// user-prompt-expansion.slash-command.json), not to assumed shapes.
	it('maps UserPromptExpansion to prompt.expansion with the captured fields', () => {
		const envelope = makeEnvelope({
			hook_event_name:
				'UserPromptExpansion' as HookEventEnvelope['hook_event_name'],
			payload: {
				hook_event_name: 'UserPromptExpansion',
				session_id: 'sess-1',
				transcript_path: '/tmp/t.jsonl',
				cwd: '/project',
				permission_mode: 'bypassPermissions',
				expansion_type: 'slash_command',
				command_name: 'greet',
				command_args: '',
				command_source: 'projectSettings',
				prompt: '/greet',
			},
		});
		const event = mapEnvelopeToRuntimeEvent(envelope);

		expect(event.kind).toBe('prompt.expansion');
		expect(event.data).toEqual({
			expansion_type: 'slash_command',
			command_name: 'greet',
			command_args: '',
			command_source: 'projectSettings',
			prompt: '/greet',
			permission_mode: 'bypassPermissions',
		});
	});

	// Field names below are pinned to the real payload captured in the #116
	// spike (/run2 parallel-Read capture), not to assumed shapes. Note that
	// `tool_calls[].tool_response` is a STRING (the flattened, model-facing
	// rendering) whereas `PostToolUse.tool_response` is a structured object —
	// the two fields deliberately do NOT share a type.
	it('maps PostToolBatch to tool.batch with the captured fields', () => {
		const envelope = makeEnvelope({
			hook_event_name: 'PostToolBatch' as HookEventEnvelope['hook_event_name'],
			payload: {
				hook_event_name: 'PostToolBatch',
				session_id: 'sess-1',
				transcript_path: '/tmp/t.jsonl',
				cwd: '/project',
				permission_mode: 'bypassPermissions',
				tool_calls: [
					{
						tool_name: 'Read',
						tool_input: {file_path: '/tmp/a.txt'},
						tool_use_id: 'tu-1',
						tool_response: '1\thello a\n',
					},
					{
						tool_name: 'Read',
						tool_input: {file_path: '/tmp/b.txt'},
						tool_use_id: 'tu-2',
						tool_response: '1\thello b\n',
					},
				],
			},
		});
		const event = mapEnvelopeToRuntimeEvent(envelope);

		expect(event.kind).toBe('tool.batch');
		expect(event.data).toEqual({
			permission_mode: 'bypassPermissions',
			tool_calls: [
				{
					tool_name: 'Read',
					tool_input: {file_path: '/tmp/a.txt'},
					tool_use_id: 'tu-1',
					tool_response: '1\thello a\n',
				},
				{
					tool_name: 'Read',
					tool_input: {file_path: '/tmp/b.txt'},
					tool_use_id: 'tu-2',
					tool_response: '1\thello b\n',
				},
			],
		});
	});

	// An older Claude never sends this hook at all (#116 confirmed unknown
	// hook keys are silently ignored). A build that sends a leaner payload
	// must still translate without throwing.
	it('tolerates a UserPromptExpansion payload missing every expansion field', () => {
		const envelope = makeEnvelope({
			hook_event_name:
				'UserPromptExpansion' as HookEventEnvelope['hook_event_name'],
			payload: {
				hook_event_name: 'UserPromptExpansion',
				session_id: 'sess-1',
				transcript_path: '/tmp/t.jsonl',
				cwd: '/project',
			},
		});
		const event = mapEnvelopeToRuntimeEvent(envelope);

		expect(event.kind).toBe('prompt.expansion');
		expect(event.data).toEqual({
			expansion_type: undefined,
			command_name: undefined,
			command_args: undefined,
			command_source: undefined,
			prompt: undefined,
			permission_mode: undefined,
		});
	});

	// hook keys are silently ignored, with zero diagnostics). A build that
	// sends a leaner payload must still translate without throwing, and a
	// non-array `tool_calls` must not leak through as one.
	it('tolerates a PostToolBatch payload with no usable tool_calls', () => {
		const envelope = makeEnvelope({
			hook_event_name: 'PostToolBatch' as HookEventEnvelope['hook_event_name'],
			payload: {
				hook_event_name: 'PostToolBatch',
				session_id: 'sess-1',
				transcript_path: '/tmp/t.jsonl',
				cwd: '/project',
				tool_calls: 'not-an-array',
			},
		});
		const event = mapEnvelopeToRuntimeEvent(envelope);

		expect(event.kind).toBe('tool.batch');
		expect(event.data).toEqual({
			tool_calls: [],
			permission_mode: undefined,
		});
	});

	it('treats prompt.expansion as observation-only (no decision, no block)', () => {
		const envelope = makeEnvelope({
			hook_event_name:
				'UserPromptExpansion' as HookEventEnvelope['hook_event_name'],
			payload: payloadForHook('UserPromptExpansion'),
		});
		const event = mapEnvelopeToRuntimeEvent(envelope);

		expect(event.interaction.expectsDecision).toBe(false);
		expect(event.interaction.canBlock).toBe(false);
	});

	it('treats tool.batch as observation-only (no decision, no block)', () => {
		const envelope = makeEnvelope({
			hook_event_name: 'PostToolBatch' as HookEventEnvelope['hook_event_name'],
			payload: payloadForHook('PostToolBatch'),
		});
		const event = mapEnvelopeToRuntimeEvent(envelope);

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

	// prompt_id is a Claude common input field (v2.1.196+) present on every hook
	// payload once a user prompt is being processed. Carried onto RuntimeEvent as
	// the harness-native Prompt identity (ADR 0009).
	it('carries prompt_id from the payload onto RuntimeEvent.promptId', () => {
		const envelope = makeEnvelope({
			payload: {prompt_id: 'prompt-abc'},
		});
		const event = mapEnvelopeToRuntimeEvent(envelope);
		expect(event.promptId).toBe('prompt-abc');
	});

	it('leaves promptId undefined when the payload has no prompt_id', () => {
		const envelope = makeEnvelope();
		const event = mapEnvelopeToRuntimeEvent(envelope);
		expect(event.promptId).toBeUndefined();
	});

	it('dispatches every hook that can decide or block synchronously', () => {
		// Claude ignores an async hook's stdout, so a hook whose reply can change
		// what Claude does next must never be registered async. This guards the
		// two sets against drift: adding a blocking event without adding it to
		// SYNC_HOOK_EVENTS would silently strip its ability to block.
		const registeredHooks = [...TOOL_HOOK_EVENTS, ...NON_TOOL_HOOK_EVENTS];
		const decisionCapable: string[] = [];

		for (const hookName of registeredHooks) {
			const envelope = makeEnvelope({
				hook_event_name: hookName as HookEventEnvelope['hook_event_name'],
				payload: payloadForHook(hookName),
			});
			const {interaction} = mapEnvelopeToRuntimeEvent(envelope);

			if (interaction.expectsDecision || interaction.canBlock) {
				decisionCapable.push(hookName);
				expect(isAsyncHookEvent(hookName), hookName).toBe(false);
			}
		}

		// The guard is only meaningful if it actually covers events.
		expect(decisionCapable.length).toBeGreaterThan(0);
	});
});
