// src/core/feed/internals/subagentTracker.ts

/**
 * Tracks subagent lifecycle state during a run:
 *   - the LIFO of currently-active subagent actor IDs
 *   - the pending-description handoff between tool.pre('Task') and the next
 *     subagent.start that consumes it
 *   - the per-agent description registry, written on subagent.start and read
 *     on subagent.stop to enrich the stop event
 *
 * Actor IDs are opaque to the tracker; callers prefix them (e.g. 'subagent:')
 * before pushing. The tracker doesn't know about the actor-ID format — that
 * convention belongs to ActorRegistry.
 *
 * Invariants:
 *   - popActor removes the LAST occurrence of actorId; absent IDs are no-ops.
 *   - currentScope() === 'subagent' iff peek() !== undefined.
 *   - consumePendingDescription returns the recorded value AND clears it;
 *     subsequent calls return undefined until a new recordPendingDescription.
 *   - clear() resets the active stack only; descriptions and the pending
 *     description survive (matches the original session.start behaviour where
 *     only activeSubagentStack was cleared).
 */
export type SubagentTracker = {
	pushActor(actorId: string): void;
	popActor(actorId: string): void;
	peek(): string | undefined;
	clear(): void;
	currentScope(): 'root' | 'subagent';

	recordPendingDescription(description: string): void;
	clearPendingDescription(): void;
	consumePendingDescription(): string | undefined;

	setDescription(agentId: string, description: string): void;
	description(agentId: string): string | undefined;
};

export function createSubagentTracker(): SubagentTracker {
	const stack: string[] = [];
	const descriptions = new Map<string, string>();
	let pendingDescription: string | undefined;

	return {
		pushActor(actorId) {
			stack.push(actorId);
		},
		popActor(actorId) {
			const idx = stack.lastIndexOf(actorId);
			if (idx !== -1) stack.splice(idx, 1);
		},
		peek() {
			return stack.length > 0 ? stack[stack.length - 1] : undefined;
		},
		clear() {
			stack.length = 0;
		},
		currentScope() {
			return stack.length > 0 ? 'subagent' : 'root';
		},
		recordPendingDescription(description) {
			pendingDescription = description;
		},
		clearPendingDescription() {
			pendingDescription = undefined;
		},
		consumePendingDescription() {
			const value = pendingDescription;
			pendingDescription = undefined;
			return value;
		},
		setDescription(agentId, description) {
			descriptions.set(agentId, description);
		},
		description(agentId) {
			return descriptions.get(agentId);
		},
	};
}
