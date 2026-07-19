// src/core/feed/internals/subagentLifecycle.ts

import type {ActorRegistry} from '../entities';
import type {RunLifecycle} from './runLifecycle';
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
 * The low-level state lives here as private closure fields rather than in a
 * separate leaf, because its invariants are only meaningful in terms of the
 * lifecycle this module drives:
 *   - `stack`: currently-active subagent actor IDs (LIFO). `stopSubagent`
 *     removes the LAST occurrence, so nested (and duplicate) starts unwind in
 *     order; an unmatched stop is a no-op.
 *   - `descriptions`: per-agent registry, written on start and read on stop.
 *   - `pendingDescription`: the handoff value; consuming it (on the next start)
 *     clears it. `clear()` resets the active stack only — descriptions and the
 *     pending value survive a run boundary.
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

	const stack: string[] = [];
	const descriptions = new Map<string, string>();
	let pendingDescription: string | undefined;

	const actorIdFor = (agentId: string): string => `subagent:${agentId}`;

	return {
		observeToolInput(toolName, toolInput) {
			if (!isSubagentTool(toolName)) return;
			pendingDescription =
				typeof toolInput['description'] === 'string'
					? toolInput['description']
					: undefined;
		},
		startSubagent({agentId, agentType, fallbackDescription}) {
			// Consume the pending description (clears it) whether or not this start
			// carries an agent id.
			const consumed = pendingDescription;
			pendingDescription = undefined;
			const description = consumed ?? fallbackDescription;
			if (agentId) {
				actors.ensureSubagent(agentId, agentType ?? 'unknown');
				const currentRun = runLifecycle.getCurrentRun();
				if (currentRun) currentRun.actors.subagent_ids.push(agentId);
				stack.push(actorIdFor(agentId));
				if (description) descriptions.set(agentId, description);
			}
			return {actorId: 'agent:root', description: description ?? undefined};
		},
		stopSubagent(agentId) {
			if (agentId) {
				const actorId = actorIdFor(agentId);
				const idx = stack.lastIndexOf(actorId);
				if (idx !== -1) stack.splice(idx, 1);
			}
			return {
				actorId: actorIdFor(agentId ?? 'unknown'),
				description: descriptions.get(agentId ?? ''),
			};
		},
		currentActor() {
			return stack.at(-1) ?? 'agent:root';
		},
		currentScope() {
			return stack.length > 0 ? 'subagent' : 'root';
		},
		actorIdFor,
		clear() {
			stack.length = 0;
		},
	};
}
