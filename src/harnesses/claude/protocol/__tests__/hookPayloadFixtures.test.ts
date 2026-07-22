import {describe, expect, it} from 'vitest';

import elicitation from '../__fixtures__/hook-payloads/elicitation.form.json';
import elicitationResultCancel from '../__fixtures__/hook-payloads/elicitation-result.cancel.json';
import notification from '../__fixtures__/hook-payloads/notification.elicitation-response.json';
import postToolBatchParallel from '../__fixtures__/hook-payloads/post-tool-batch.parallel-calls.json';
import postToolBatchSingle from '../__fixtures__/hook-payloads/post-tool-batch.single-call.json';
import userPromptExpansion from '../__fixtures__/hook-payloads/user-prompt-expansion.slash-command.json';

// These fixtures are real payloads captured from Claude Code 2.1.215 (see
// docs/new-hook-events-spike-report.md). The assertions here are deliberately
// about the *wire* field names rather than about our TypeScript types: the
// point is to pin down what Claude actually sends, so that slices #118-#120
// have a fixed target and a regression alarm if a future capture disagrees.

describe('captured hook payload fixtures', () => {
	describe('UserPromptExpansion', () => {
		it('names the command, its args and where it came from', () => {
			expect(userPromptExpansion).toMatchObject({
				hook_event_name: 'UserPromptExpansion',
				expansion_type: 'slash_command',
				command_name: 'greet',
				command_args: '',
				command_source: 'projectSettings',
				prompt: '/greet',
			});
		});

		it('shares prompt_id with the UserPromptSubmit it precedes', () => {
			expect(userPromptExpansion.prompt_id).toEqual(expect.any(String));
		});
	});

	describe('PostToolBatch', () => {
		it('carries one entry per tool call in the batch', () => {
			expect(postToolBatchSingle.tool_calls).toHaveLength(1);
			expect(postToolBatchParallel.tool_calls).toHaveLength(3);
		});

		it('gives each entry a name, input, id and response', () => {
			for (const call of postToolBatchParallel.tool_calls) {
				expect(Object.keys(call).sort()).toEqual([
					'tool_input',
					'tool_name',
					'tool_response',
					'tool_use_id',
				]);
			}
		});

		// The headline constraint for #119: PostToolUse.tool_response is a
		// structured object, but the batch flattens it to the model-facing string.
		it('flattens tool_response to a string, unlike PostToolUse', () => {
			for (const call of postToolBatchParallel.tool_calls) {
				expect(typeof call.tool_response).toBe('string');
			}

			expect(typeof postToolBatchSingle.tool_calls[0]?.tool_response).toBe(
				'string',
			);
		});
	});

	describe('Elicitation', () => {
		// AC2: the field is mcp_server_name -- neither `mcp_server` nor
		// `server_name`, which is what the current speculative types assume.
		it('identifies the server as mcp_server_name', () => {
			expect(elicitation).toHaveProperty('mcp_server_name', 'elicitstub');
			expect(elicitation).not.toHaveProperty('mcp_server');
			expect(elicitation).not.toHaveProperty('server_name');
		});

		it('describes the request as message + mode + requested_schema, not a form', () => {
			expect(elicitation).toMatchObject({
				hook_event_name: 'Elicitation',
				message: 'What is your favourite colour?',
				mode: 'form',
				requested_schema: {type: 'object', required: ['colour']},
			});
			expect(elicitation).not.toHaveProperty('form');
		});
	});

	describe('ElicitationResult', () => {
		it('reports the action alongside the same mcp_server_name', () => {
			expect(elicitationResultCancel).toMatchObject({
				hook_event_name: 'ElicitationResult',
				mcp_server_name: 'elicitstub',
				mode: 'form',
				action: 'cancel',
			});
		});

		// `content` is only sent on the accept path; on cancel the key is absent
		// rather than null, so it must be modelled as optional.
		it('omits content entirely when the elicitation was cancelled', () => {
			expect(elicitationResultCancel).not.toHaveProperty('content');
		});
	});

	it('follows an elicitation with an elicitation_response Notification', () => {
		expect(notification).toMatchObject({
			hook_event_name: 'Notification',
			notification_type: 'elicitation_response',
		});
		expect(notification.message).toContain('elicitstub');
	});
});
