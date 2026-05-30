// src/core/feed/internals/subagentLifecycle.ts

import type {ActorRegistry} from '../entities';
import type {RunLifecycle} from './runLifecycle';
import {createSubagentTracker} from './subagentTracker';
import {isSubagentTool} from '../todo';

/**
 * The Subagent module: the single owner of subagent lifecycle interpretation
 * and its effects during a run. It concentrates what used to be spread across
 * toolProjection / subagentProjection / mapper:
 *   - actor-id formation (`subagent:${agentId}`) — callers never build it again
 *   - the active-subagent stack (push on start, pop on stop, LIFO scope)
 *   - the pending-description handoff between a subagent-spawning tool input
 *     and the next subagent.start that consumes it
 *   - the per-agent description registry (written on start, read on stop)
 *   - actor-registration effects: ActorRegistry.ensureSubagent + recording the
 *     agent id on the current Run's `subagent_ids`.
 *
 * It composes the pure {@link createSubagentTracker} for low-level state; this
 * module adds the interpretation and the ActorRegistry/RunLifecycle effects.
 */
export type SubagentStart = {actorId: string; description: string | undefined};
export type SubagentStop = {actorId: string; description: string | undefined};

export type SubagentLifecycle = {
	/** Record/clear the pending description from a subagent-spawning tool input. */
	observeToolInput(
		toolName: string | undefined,
		toolInput: Record<string, unknown>,
	): void;
	/** Begin a subagent: register actor, record run membership, push the stack. */
	startSubagent(input: {
		agentId?: string;
		agentType?: string;
		fallbackDescription?: string;
	}): SubagentStart;
	/** End a subagent: pop the stack and resolve its stop actor + description. */
	stopSubagent(agentId: string | undefined): SubagentStop;
	/** The actor that owns the current scope (innermost subagent, else root). */
	currentActor(): string;
	currentScope(): 'root' | 'subagent';
	/** Form the subagent actor id for a given agent id. */
	actorIdFor(agentId: string): string;
	/** Reset the active stack across a run boundary (descriptions/pending survive). */
	clear(): void;
};

export function createSubagentLifecycle(args: {
	actors: ActorRegistry;
	runLifecycle: RunLifecycle;
}): SubagentLifecycle {
	const {actors, runLifecycle} = args;
	const tracker = createSubagentTracker();
	const actorIdFor = (agentId: string): string => `subagent:${agentId}`;

	return {
		observeToolInput(toolName, toolInput) {
			if (!isSubagentTool(toolName)) return;
			if (typeof toolInput['description'] === 'string') {
				tracker.recordPendingDescription(toolInput['description']);
			} else {
				tracker.clearPendingDescription();
			}
		},
		startSubagent({agentId, agentType, fallbackDescription}) {
			const description =
				tracker.consumePendingDescription() ?? fallbackDescription;
			if (agentId) {
				actors.ensureSubagent(agentId, agentType ?? 'unknown');
				const currentRun = runLifecycle.getCurrentRun();
				if (currentRun) currentRun.actors.subagent_ids.push(agentId);
				tracker.pushActor(actorIdFor(agentId));
				if (description) tracker.setDescription(agentId, description);
			}
			return {actorId: 'agent:root', description: description ?? undefined};
		},
		stopSubagent(agentId) {
			if (agentId) tracker.popActor(actorIdFor(agentId));
			return {
				actorId: actorIdFor(agentId ?? 'unknown'),
				description: tracker.description(agentId ?? ''),
			};
		},
		currentActor() {
			return tracker.peek() ?? 'agent:root';
		},
		currentScope() {
			return tracker.currentScope();
		},
		actorIdFor,
		clear() {
			tracker.clear();
		},
	};
}
