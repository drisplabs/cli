import {describe, it, expect} from 'vitest';
import {translateClaudeEnvelope} from '../eventTranslator';
import type {HookEventEnvelope} from '../../protocol/envelope';
import type {ClaudeHookEvent} from '../../protocol/events';

function envelope(payload: ClaudeHookEvent): HookEventEnvelope {
	return {
		request_id: 'req-1',
		ts: 0,
		session_id: payload.session_id,
		hook_event_name: payload.hook_event_name,
		payload,
	};
}

describe('translateClaudeEnvelope — restored fields (issue #115)', () => {
	it('carries SessionStart.model onto session.start data', () => {
		const result = translateClaudeEnvelope(
			envelope({
				hook_event_name: 'SessionStart',
				session_id: 's1',
				transcript_path: '/tmp/t',
				cwd: '/repo',
				source: 'startup',
				model: 'claude-opus-4-8',
			}),
		);

		expect(result.kind).toBe('session.start');
		if (result.kind === 'session.start') {
			expect(result.data.model).toBe('claude-opus-4-8');
		}
	});

	it('carries UserPromptSubmit.cwd onto user.prompt data', () => {
		const result = translateClaudeEnvelope(
			envelope({
				hook_event_name: 'UserPromptSubmit',
				session_id: 's1',
				transcript_path: '/tmp/t',
				cwd: '/repo/work',
				prompt: 'hello',
			}),
		);

		expect(result.kind).toBe('user.prompt');
		if (result.kind === 'user.prompt') {
			expect(result.data.cwd).toBe('/repo/work');
		}
	});

	it('carries PostToolUseFailure.{exit_code,output,error_code} onto tool.failure data', () => {
		const result = translateClaudeEnvelope(
			envelope({
				hook_event_name: 'PostToolUseFailure',
				session_id: 's1',
				transcript_path: '/tmp/t',
				cwd: '/repo',
				tool_name: 'Bash',
				tool_input: {command: 'exit 3'},
				error: 'command failed',
				exit_code: 3,
				output: 'boom',
				error_code: 'E_CMD',
			}),
		);

		expect(result.kind).toBe('tool.failure');
		if (result.kind === 'tool.failure') {
			expect(result.data.exit_code).toBe(3);
			expect(result.data.output).toBe('boom');
			expect(result.data.error_code).toBe('E_CMD');
		}
	});
});
