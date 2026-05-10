import type {RuntimeEvent} from '../../../core/runtime/types';

/**
 * Resolve the adapter-side auto-decision timeout for a runtime event.
 *
 * - explicit number → use it
 * - null            → wait indefinitely (human-in-the-loop, e.g. AskUserQuestion)
 * - undefined       → fall back to the adapter's default TTL
 *
 * Returning null means the caller MUST NOT schedule an auto-passthrough timer.
 */
export function resolveAdapterTimeoutMs(
	interaction: RuntimeEvent['interaction'],
	fallbackMs: number,
): number | null {
	const ms = interaction.defaultTimeoutMs;
	if (ms === null) return null;
	return ms ?? fallbackMs;
}
