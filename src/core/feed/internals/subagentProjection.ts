import type {RuntimeEvent} from '../../runtime/types';
import type {FeedEvent} from '../types';
import type {SubagentLifecycle} from './subagentLifecycle';
import {
	type EnsureRun,
	type FeedEventBuilder,
	readBoolean,
	readString,
} from './projection';

export type SubagentProjection = {
	mapSubagentEvent(
		event: RuntimeEvent,
		data: Record<string, unknown>,
	): FeedEvent[];
};

export function createSubagentProjection(args: {
	ensureRunArray: EnsureRun;
	makeEvent: FeedEventBuilder;
	subagents: SubagentLifecycle;
}): SubagentProjection {
	const {ensureRunArray, makeEvent, subagents} = args;

	return {
		mapSubagentEvent(event, data) {
			const results = ensureRunArray(event);
			const agentId = event.agentId ?? readString(data['agent_id']);
			const agentType = event.agentType ?? readString(data['agent_type']);

			if (event.kind === 'subagent.start') {
				const {actorId, description} = subagents.startSubagent({
					agentId,
					agentType,
					fallbackDescription: readString(data['prompt']),
				});
				results.push(
					makeEvent(
						'subagent.start',
						'info',
						actorId,
						{
							agent_id: agentId ?? '',
							agent_type: agentType ?? '',
							description: description ?? undefined,
							tool: readString(data['tool']),
							sender_thread_id: readString(data['sender_thread_id']),
							receiver_thread_id: readString(data['receiver_thread_id']),
							new_thread_id: readString(data['new_thread_id']),
							agent_status: readString(data['agent_status']),
						} satisfies import('../types').SubagentStartData,
						event,
					),
				);
				return results;
			}

			const {actorId, description} = subagents.stopSubagent(agentId);
			results.push(
				makeEvent(
					'subagent.stop',
					'info',
					actorId,
					{
						agent_id: agentId ?? '',
						agent_type: agentType ?? '',
						stop_hook_active: readBoolean(data['stop_hook_active']) ?? false,
						agent_transcript_path: readString(data['agent_transcript_path']),
						last_assistant_message: readString(data['last_assistant_message']),
						description,
						tool: readString(data['tool']),
						status: readString(data['status']),
						sender_thread_id: readString(data['sender_thread_id']),
						receiver_thread_id: readString(data['receiver_thread_id']),
						new_thread_id: readString(data['new_thread_id']),
						agent_status: readString(data['agent_status']),
					} satisfies import('../types').SubagentStopData,
					event,
				),
			);
			return results;
		},
	};
}
