import type {AppMode} from '../types/headerMetrics';

/**
 * Derive the current app mode from runtime state.
 * Priority: permission > question > working > idle.
 *
 * A pure derivation with no React state or effects — called in the
 * component render path but holds no state of its own.
 */
export function deriveAppMode(
	isClaudeRunning: boolean,
	currentPermissionRequest: unknown | null,
	currentQuestionRequest: unknown | null,
	startupFailureMessage?: string | null,
): AppMode {
	if (startupFailureMessage) {
		return {type: 'startup_failed', message: startupFailureMessage};
	}
	if (!isClaudeRunning) return {type: 'idle'};
	if (currentPermissionRequest) return {type: 'permission'};
	if (currentQuestionRequest) return {type: 'question'};
	return {type: 'working'};
}
