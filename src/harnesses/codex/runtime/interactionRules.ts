import type {RuntimeEvent} from '../../../core/runtime/types';

type InteractionHints = RuntimeEvent['interaction'];

const DEFAULT_TIMEOUT_MS = 4_000;

export function getCodexInteractionHints(
	expectsDecision: boolean,
): InteractionHints {
	if (expectsDecision) {
		return {
			expectsDecision: true,
			defaultTimeoutMs: null,
			canBlock: true,
		};
	}
	return {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	};
}
