// src/core/feed/internals/rootPlanTracker.ts

import type {TodoItem} from '../todo';

/**
 * Tracks the canonical root-plan task list across the lifetime of a run.
 *
 * Invariants:
 *   - current() returns the most recently set array; defaults to [] before
 *     any set call.
 *   - differs(items) is true iff a subsequent set(items) would observably
 *     change current() — compared by length, content, and status (activeForm
 *     is intentionally not compared, matching the existing plan.delta diff).
 *   - The returned array is the stored reference; callers must not mutate it.
 */
export type RootPlanTracker = {
	set(items: TodoItem[]): void;
	current(): TodoItem[];
	differs(items: TodoItem[]): boolean;
};

export function createRootPlanTracker(): RootPlanTracker {
	let items: TodoItem[] = [];

	return {
		set(next) {
			items = next;
		},
		current() {
			return items;
		},
		differs(next) {
			if (next.length !== items.length) return true;
			for (let i = 0; i < next.length; i++) {
				if (next[i]?.content !== items[i]?.content) return true;
				if (next[i]?.status !== items[i]?.status) return true;
			}
			return false;
		},
	};
}
