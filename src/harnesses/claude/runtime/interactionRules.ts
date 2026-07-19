import type {RuntimeEvent} from '../../../core/runtime/types';
import type {RuntimeEventKind} from '../../../core/runtime/events';

type InteractionHints = RuntimeEvent['interaction'];

const DEFAULT_TIMEOUT_MS = 4000;

const DEFAULT_HINTS: InteractionHints = {
	expectsDecision: false,
	defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
	canBlock: false,
};

const RULES: Record<RuntimeEventKind, InteractionHints> = {
	'permission.request': {
		expectsDecision: true,
		defaultTimeoutMs: null,
		canBlock: true,
	},
	'tool.pre': {
		expectsDecision: true,
		defaultTimeoutMs: null,
		canBlock: true,
	},
	'tool.post': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	// Observation-only: the hook is capable of blocking the next model request,
	// but the forwarder passes it through without waiting for a decision.
	'tool.batch': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: true,
	},
	'tool.delta': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'tool.failure': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'stop.request': {
		expectsDecision: true,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: true,
	},
	'subagent.stop': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: true,
	},
	'subagent.start': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	notification: {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'session.start': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'session.end': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'compact.pre': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'user.prompt': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: true,
	},
	// Observation-only: nothing in the pipeline produces a decision or a block
	// for an expansion, so it must not claim `canBlock`. The claim is not
	// cosmetic — hook dispatch keeps every decision-capable event on Claude's
	// critical path, so a false `canBlock` would make every slash command wait
	// on the forwarder for a reply that is never sent.
	'prompt.expansion': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'turn.start': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'turn.complete': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'message.delta': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'message.complete': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'plan.delta': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'reasoning.delta': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'usage.update': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	setup: {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'teammate.idle': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: true,
	},
	'task.completed': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: true,
	},
	'config.change': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: true,
	},
	'permission.denied': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'stop.failure': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'compact.post': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'task.created': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: true,
	},
	'cwd.changed': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'file.changed': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'instructions.loaded': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'worktree.create': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'worktree.remove': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'elicitation.request': {
		expectsDecision: true,
		defaultTimeoutMs: null,
		canBlock: true,
	},
	'elicitation.result': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	unknown: DEFAULT_HINTS,
};

// AskUserQuestion is human-in-the-loop, as are all permission/question
// decisions. They must not auto-passthrough while a human is deciding.
const ASK_USER_QUESTION_HINTS: InteractionHints = {
	expectsDecision: true,
	defaultTimeoutMs: null,
	canBlock: true,
};

export function getInteractionHints(
	kind: string,
	toolName?: string,
): InteractionHints {
	if (kind === 'tool.pre' && toolName === 'AskUserQuestion') {
		return ASK_USER_QUESTION_HINTS;
	}
	const maybeRule = (RULES as Partial<Record<string, InteractionHints>>)[kind];
	return maybeRule ?? DEFAULT_HINTS;
}
