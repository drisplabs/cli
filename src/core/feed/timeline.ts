import {type Message} from '../../shared/types/common';
import {
	compactText,
	summarizeToolPrimaryInput,
	shortenPathStructured,
} from '../../shared/utils/format';
import {
	extractFriendlyServerName,
	parseToolName,
} from '../../shared/utils/toolNameParser';
import {summarizeToolResult} from './toolSummary';
import {type FeedEvent, type FeedEventKind} from './types';
import {resolveVerb} from './verbMap';

// ── Public types ──────────────────────────────────────────

export type RunStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export type SummarySegmentRole =
	| 'verb'
	| 'target'
	| 'filename'
	| 'outcome'
	| 'plain';
export type SummarySegment = {text: string; role: SummarySegmentRole};

export type TimelineEntry = {
	id: string;
	ts: number;
	runId?: string;
	op: string; // Title Case label (e.g. "Tool Call")
	opTag: string; // Internal slug for styling (e.g. "tool.call")
	actor: string;
	actorId: string;
	toolColumn: string; // Tool display name for TOOL column ('Read', 'Navigate', '' for non-tool)
	summary: string;
	summarySegments: SummarySegment[];
	summaryOutcome?: string;
	summaryOutcomeZero?: boolean;
	searchText: string;
	error: boolean;
	expandable: boolean;
	details: string;
	feedEvent?: FeedEvent;
	pairedPostEvent?: FeedEvent;
};

export type RunSummary = {
	runId: string;
	title: string;
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
};

export type SummaryResult = {
	text: string;
	segments: SummarySegment[];
	/** Right-aligned outcome text (e.g., "13 files", "exit 0"). Empty/undefined = no outcome. */
	outcome?: string;
	/** True when outcome is a zero-result (0 files, 0 matches) — signals warning tint. */
	outcomeZero?: boolean;
};

// ── Standalone utilities ──────────────────────────────────

/** Extract coarse event category from op string for visual grouping. */
export function opCategory(op: string): string {
	const dot = op.indexOf('.');
	return dot >= 0 ? op.slice(0, dot) : op;
}

/** Strip inline markdown syntax for compact single-line display. */
export function stripMarkdownInline(text: string): string {
	return text
		.replace(/#{1,6}\s+/g, '')
		.replace(/\*\*(.+?)\*\*/g, '$1')
		.replace(/__(.+?)__/g, '$1')
		.replace(/\*(.+?)\*/g, '$1')
		.replace(/`(.+?)`/g, '$1')
		.replace(/~~(.+?)~~/g, '$1');
}

/** Extract first sentence (ends with `. ` or newline) from text. */
export function firstSentence(text: string): string {
	const nlIdx = text.indexOf('\n');
	const sentIdx = text.indexOf('. ');
	const nlEnd = nlIdx === -1 ? Infinity : nlIdx;
	const sentEnd = sentIdx === -1 ? Infinity : sentIdx + 1;
	const end = Math.min(nlEnd, sentEnd, text.length);
	return text.slice(0, end).trim();
}

// ── Tool formatting helpers (shared by renderers) ─────────

/** Resolve a tool name to its display form (e.g. MCP → `[server] action`). */
function resolveDisplayName(toolName: string): string {
	const parsed = parseToolName(toolName);
	if (parsed.isMcp && parsed.mcpServer && parsed.mcpAction) {
		const friendlyServer = extractFriendlyServerName(parsed.mcpServer);
		return `[${friendlyServer}] ${parsed.mcpAction}`;
	}
	return toolName;
}

type ToolSummaryResult = {text: string; segments: SummarySegment[]};

const PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep']);

function withMcpServerContext(
	parsed: ReturnType<typeof parseToolName>,
	primaryInput: string,
): string {
	if (!parsed.isMcp || !parsed.mcpServer) return primaryInput;
	const server = extractFriendlyServerName(parsed.mcpServer);
	if (!server) return primaryInput;
	return primaryInput ? `[${server}] ${primaryInput}` : `[${server}]`;
}

function formatToolSummary(
	toolName: string,
	toolInput: Record<string, unknown>,
	errorSuffix?: string,
): ToolSummaryResult {
	const parsed = parseToolName(toolName);
	const verb = resolveVerb(toolName, parsed);
	const primaryInput = withMcpServerContext(
		parsed,
		summarizeToolPrimaryInput(toolName, toolInput),
	);
	const secondary = [primaryInput, errorSuffix].filter(Boolean).join(' ');
	if (!secondary) {
		const text = compactText(verb, 200);
		return {text, segments: [{text, role: 'verb'}]};
	}
	const full = `${verb} ${secondary}`;
	const text = compactText(full, 200);
	const rest = text.slice(verb.length);

	// X4: Split target into prefix (dim) + filename (bright) for path-based tools
	const baseName = toolName;
	const filePath = toolInput.file_path ?? toolInput.pattern ?? toolInput.path;
	if (PATH_TOOLS.has(baseName) && typeof filePath === 'string') {
		const {prefix, filename} = shortenPathStructured(filePath);
		if (prefix && filename) {
			const idx = rest.indexOf(prefix);
			if (idx >= 0) {
				const beforeFilename = rest.slice(0, idx + prefix.length);
				const afterFilename = rest.slice(idx + prefix.length + filename.length);
				return {
					text,
					segments: [
						{text: verb, role: 'verb'},
						{text: beforeFilename, role: 'target'},
						{text: filename, role: 'filename'},
						...(afterFilename
							? [{text: afterFilename, role: 'target' as const}]
							: []),
					],
				};
			}
		}
	}

	return {
		text,
		segments: [
			{text: verb, role: 'verb'},
			{text: rest, role: 'target'},
		],
	};
}

function formatPermissionSummary(
	event: Extract<FeedEvent, {kind: 'permission.request'}>,
): SummaryResult {
	const base = formatToolSummary(event.data.tool_name, event.data.tool_input);
	const host = event.data.network_context?.host;
	if (!host) {
		return base;
	}
	const protocol = event.data.network_context?.protocol;
	const suffix = ` → ${protocol ? `${protocol} ` : ''}${host}`;
	const text = compactText(`${base.text}${suffix}`, 200);
	return {
		text,
		segments: [...base.segments, {text: suffix, role: 'target'}],
	};
}

function formatRunEndSummary(
	event: Extract<FeedEvent, {kind: 'run.end'}>,
): string {
	const toolText = `${event.data.counters.tool_uses} tool${event.data.counters.tool_uses === 1 ? '' : 's'}`;
	const failureCount = event.data.counters.tool_failures;
	if (failureCount > 0) {
		return `${event.data.status} · ${toolText}, ${failureCount} failure${failureCount === 1 ? '' : 's'}`;
	}
	return `${event.data.status} · ${toolText}`;
}

/**
 * Use the harness-supplied display title (if any) as the row summary.
 * Returns undefined when the event has no harness hint.
 */
function harnessSummary(event: FeedEvent): SummaryResult | undefined {
	const title = event.display?.title?.trim();
	if (!title) return undefined;
	const text = compactText(title, 200);
	return {text, segments: [{text, role: 'target'}]};
}

function postOutcome(postEvent: FeedEvent): string | undefined {
	if (postEvent.kind === 'tool.failure') {
		return summarizeToolResult(
			postEvent.data.tool_name,
			postEvent.data.tool_input,
			undefined,
			postEvent.data.error,
		);
	}
	if (postEvent.kind === 'tool.post') {
		return summarizeToolResult(
			postEvent.data.tool_name,
			postEvent.data.tool_input,
			postEvent.data.tool_response,
		);
	}
	return undefined;
}

// ── Renderer interfaces ───────────────────────────────────

type Ev<K extends FeedEventKind> = Extract<FeedEvent, {kind: K}>;

interface EventRenderer<K extends FeedEventKind> {
	operation: (event: Ev<K>) => string;
	label: (event: Ev<K>) => string;
	detail: (event: Ev<K>) => string;
	summary: (event: Ev<K>) => SummaryResult;
	expansion: (event: Ev<K>) => string;
	/** Optional kind-specific error rule. Default: `false` (the level === 'error' rule applies globally). */
	isError?: (event: Ev<K>) => boolean;
}

type RendererRegistry = {[K in FeedEventKind]: EventRenderer<K>};

/**
 * Default summary for kinds whose summary is just a compacted single line
 * derived from a kind-specific text builder.
 */
function plainSummary(text: string): SummaryResult {
	const compact = compactText(text, 200);
	return {text: compact, segments: [{text: compact, role: 'target'}]};
}

/** Default expansion: pretty-printed JSON of `event.data`. */
function dataExpansion<K extends FeedEventKind>(event: Ev<K>): string {
	return JSON.stringify(event.data, null, 2);
}

/** Default expansion for kinds rendered with `isDefaultRenderKind`. */
function rawOrDataExpansion<K extends FeedEventKind>(event: Ev<K>): string {
	return JSON.stringify(event.raw ?? event.data, null, 2);
}

/** Default-rendered kinds use a uniform shape across all five surfaces. */
function defaultRenderer<K extends FeedEventKind>(
	summarize: (event: Ev<K>) => string,
): EventRenderer<K> {
	return {
		operation: () => 'event',
		label: () => 'Event',
		detail: () => '─',
		summary: event => plainSummary(summarize(event)),
		expansion: rawOrDataExpansion,
	};
}

// ── Per-kind renderers ────────────────────────────────────

// === run lifecycle ===

const sessionStart: EventRenderer<'session.start'> = {
	operation: () => 'sess.start',
	label: () => 'Sess Start',
	detail: event => event.data.source,
	summary: event => plainSummary(event.data.source),
	expansion: rawOrDataExpansion,
};

const sessionEnd: EventRenderer<'session.end'> = {
	operation: () => 'sess.end',
	label: () => 'Sess End',
	detail: () => '─',
	summary: event => plainSummary(event.data.reason),
	expansion: rawOrDataExpansion,
};

const runStart: EventRenderer<'run.start'> = {
	operation: () => 'run.start',
	label: () => 'Run Start',
	detail: () => '─',
	summary: event =>
		plainSummary(event.data.trigger.prompt_preview || 'interactive'),
	expansion: rawOrDataExpansion,
};

const runEnd: EventRenderer<'run.end'> = {
	operation: event => {
		if (event.data.status === 'completed') return 'run.ok';
		if (event.data.status === 'failed') return 'run.fail';
		return 'run.abort';
	},
	label: event => {
		if (event.data.status === 'completed') return 'Run OK';
		if (event.data.status === 'failed') return 'Run Fail';
		return 'Run Abort';
	},
	detail: () => '─',
	summary: event => plainSummary(formatRunEndSummary(event)),
	expansion: dataExpansion,
	isError: event => event.data.status !== 'completed',
};

const userPrompt: EventRenderer<'user.prompt'> = {
	operation: () => 'prompt',
	label: () => 'User Prompt',
	detail: () => '─',
	summary: event => plainSummary(event.data.prompt),
	expansion: rawOrDataExpansion,
};

// === plan / reasoning / usage ===

const planUpdate: EventRenderer<'plan.update'> = {
	operation: () => 'plan.upd',
	label: () => 'Plan Update',
	detail: () => 'plan',
	summary: event => {
		if (event.data.explanation) return plainSummary(event.data.explanation);
		if (event.data.plan && event.data.plan.length > 0) {
			const completed = event.data.plan.filter(
				step => step.status === 'completed',
			).length;
			return plainSummary(`${completed}/${event.data.plan.length} steps`);
		}
		return plainSummary(event.data.delta || 'plan updated');
	},
	expansion: dataExpansion,
};

const reasoningSummary: EventRenderer<'reasoning.summary'> = {
	operation: () => 'reason',
	label: () => 'Reasoning',
	detail: () => 'summary',
	summary: event =>
		plainSummary(firstSentence(stripMarkdownInline(event.data.message))),
	expansion: dataExpansion,
};

const usageUpdate: EventRenderer<'usage.update'> = {
	operation: () => 'usage.upd',
	label: () => 'Usage Update',
	detail: () => 'tokens',
	summary: event => {
		const total = event.data.usage?.total;
		const delta = event.data.delta?.total;
		if (typeof total === 'number' && typeof delta === 'number') {
			return plainSummary(
				`${total.toLocaleString()} total (+${delta.toLocaleString()})`,
			);
		}
		if (typeof total === 'number') {
			return plainSummary(`${total.toLocaleString()} total`);
		}
		return plainSummary('usage updated');
	},
	expansion: dataExpansion,
};

// === tool lifecycle ===

const toolDelta: EventRenderer<'tool.delta'> = {
	operation: () => 'tool.call',
	label: () => 'Tool Call',
	detail: event => resolveDisplayName(event.data.tool_name),
	summary: event =>
		formatToolSummary(event.data.tool_name, event.data.tool_input),
	expansion: event =>
		JSON.stringify(
			{tool: event.data.tool_name, args: event.data.tool_input},
			null,
			2,
		),
};

const toolPre: EventRenderer<'tool.pre'> = {
	operation: () => 'tool.call',
	label: () => 'Tool Call',
	detail: event => resolveDisplayName(event.data.tool_name),
	summary: event =>
		formatToolSummary(event.data.tool_name, event.data.tool_input),
	expansion: event =>
		JSON.stringify(
			{tool: event.data.tool_name, args: event.data.tool_input},
			null,
			2,
		),
};

const toolPost: EventRenderer<'tool.post'> = {
	operation: () => 'tool.ok',
	label: () => 'Tool OK',
	detail: event => resolveDisplayName(event.data.tool_name),
	summary: event =>
		formatToolSummary(event.data.tool_name, event.data.tool_input),
	expansion: event =>
		JSON.stringify(
			{
				tool: event.data.tool_name,
				args: event.data.tool_input,
				result: event.data.tool_response,
			},
			null,
			2,
		),
};

const toolFailure: EventRenderer<'tool.failure'> = {
	operation: () => 'tool.fail',
	label: () => 'Tool Fail',
	detail: event => resolveDisplayName(event.data.tool_name),
	summary: event =>
		formatToolSummary(
			event.data.tool_name,
			event.data.tool_input,
			event.data.error,
		),
	expansion: event =>
		JSON.stringify(
			{
				tool: event.data.tool_name,
				args: event.data.tool_input,
				error: event.data.error,
				interrupt: event.data.is_interrupt,
			},
			null,
			2,
		),
	isError: () => true,
};

// === permission ===

const permissionRequest: EventRenderer<'permission.request'> = {
	operation: () => 'perm.req',
	label: () => 'Perm Request',
	detail: event => resolveDisplayName(event.data.tool_name),
	summary: event => formatPermissionSummary(event),
	expansion: event =>
		JSON.stringify(
			{
				tool: event.data.tool_name,
				args: event.data.tool_input,
				suggestions: event.data.permission_suggestions,
			},
			null,
			2,
		),
};

const permissionDecision: EventRenderer<'permission.decision'> = {
	operation: event => `perm.${event.data.decision_type}`,
	label: event => {
		switch (event.data.decision_type) {
			case 'allow':
				return 'Perm Allow';
			case 'deny':
				return 'Perm Deny';
			case 'ask':
				return 'Perm Ask';
			case 'no_opinion':
				return 'Perm Skip';
			default:
				return 'Perm Decision';
		}
	},
	detail: () => '─',
	summary: event => {
		const detail =
			event.data.decision_type === 'deny'
				? event.data.message || event.data.reason
				: event.data.reason;
		return plainSummary(detail || event.data.decision_type);
	},
	expansion: rawOrDataExpansion,
	isError: event => event.data.decision_type === 'deny',
};

// === stop ===

const stopRequest: EventRenderer<'stop.request'> = {
	operation: () => 'stop.req',
	label: () => 'Stop Request',
	detail: () => '─',
	summary: event =>
		plainSummary(
			event.data.stop_hook_active ? 'Stop hook active' : 'Stop hook inactive',
		),
	expansion: rawOrDataExpansion,
};

const stopDecision: EventRenderer<'stop.decision'> = {
	operation: event => `stop.${event.data.decision_type}`,
	label: event => {
		switch (event.data.decision_type) {
			case 'block':
				return 'Stop Block';
			case 'allow':
				return 'Stop Allow';
			case 'no_opinion':
				return 'Stop Skip';
			default:
				return 'Stop Decision';
		}
	},
	detail: () => '─',
	summary: event => plainSummary(event.data.reason || event.data.decision_type),
	expansion: rawOrDataExpansion,
	isError: event => event.data.decision_type === 'block',
};

// === subagent ===

const subagentStart: EventRenderer<'subagent.start'> = {
	operation: () => 'sub.start',
	label: () => 'Sub Start',
	detail: event => event.data.agent_type,
	summary: event => {
		const text = compactText(
			event.data.description?.trim() || `id:${event.data.agent_id}`,
			200,
		);
		return {text, segments: [{text, role: 'target'}]};
	},
	expansion: rawOrDataExpansion,
};

const subagentStop: EventRenderer<'subagent.stop'> = {
	operation: () => 'sub.stop',
	label: () => 'Sub Stop',
	detail: event => event.data.agent_type,
	summary: event => {
		const text = compactText(
			event.data.description?.trim() || `id:${event.data.agent_id}`,
			200,
		);
		return {text, segments: [{text, role: 'target'}]};
	},
	expansion: dataExpansion,
};

// === notification / error / status ===

const notification: EventRenderer<'notification'> = {
	operation: () => 'notify',
	label: () => 'Notify',
	detail: () => '─',
	summary: event => plainSummary(stripMarkdownInline(event.data.message)),
	expansion: rawOrDataExpansion,
};

const runtimeError: EventRenderer<'runtime.error'> = {
	operation: () => 'error',
	label: () => 'Error',
	detail: () => '─',
	summary: event => plainSummary(stripMarkdownInline(event.data.message)),
	expansion: dataExpansion,
	isError: () => true,
};

const threadStatus: EventRenderer<'thread.status'> = {
	operation: () => 'thread',
	label: () => 'Thread',
	detail: event => event.data.status_type ?? 'status',
	summary: event => plainSummary(event.data.message),
	expansion: dataExpansion,
};

const turnDiff: EventRenderer<'turn.diff'> = {
	operation: () => 'diff',
	label: () => 'Diff',
	detail: () => '─',
	summary: event => plainSummary(event.data.message),
	expansion: dataExpansion,
};

const serverRequestResolved: EventRenderer<'server.request.resolved'> = {
	operation: () => 'req.done',
	label: () => 'Request',
	detail: event => event.data.request_id ?? 'request',
	summary: event => plainSummary(event.data.message),
	expansion: dataExpansion,
};

const webSearch: EventRenderer<'web.search'> = {
	operation: () => 'web.search',
	label: () => 'Web Search',
	detail: event => event.data.action_type ?? event.data.phase,
	summary: event => plainSummary(event.data.message),
	expansion: dataExpansion,
};

const reviewStatus: EventRenderer<'review.status'> = {
	operation: () => 'review',
	label: () => 'Review',
	detail: event => event.data.phase,
	summary: event => plainSummary(event.data.message),
	expansion: dataExpansion,
};

const imageView: EventRenderer<'image.view'> = {
	operation: () => 'image',
	label: () => 'Image',
	detail: event => event.data.path ?? 'image',
	summary: event => plainSummary(event.data.message),
	expansion: dataExpansion,
};

const contextCompaction: EventRenderer<'context.compaction'> = {
	operation: () => 'compact',
	label: () => 'Compaction',
	detail: event => event.data.phase,
	summary: event => plainSummary(event.data.message),
	expansion: dataExpansion,
};

const mcpProgress: EventRenderer<'mcp.progress'> = {
	operation: () => 'mcp.prog',
	label: () => 'MCP Progress',
	detail: () => '─',
	summary: event => plainSummary(event.data.message),
	expansion: dataExpansion,
};

const terminalInput: EventRenderer<'terminal.input'> = {
	operation: () => 'term.in',
	label: () => 'Terminal In',
	detail: () => '─',
	summary: event => plainSummary(event.data.message),
	expansion: dataExpansion,
};

const skillsChanged: EventRenderer<'skills.changed'> = {
	operation: () => 'skills',
	label: () => 'Skills',
	detail: () => '─',
	summary: event => plainSummary(event.data.message),
	expansion: dataExpansion,
};

const skillsLoaded: EventRenderer<'skills.loaded'> = {
	operation: () => 'skills',
	label: () => 'Skills',
	detail: () => '─',
	summary: event => plainSummary(event.data.message),
	expansion: dataExpansion,
};

// === compaction / setup / unknown ===

const compactPre: EventRenderer<'compact.pre'> = {
	operation: () => 'compact',
	label: () => 'Compact',
	detail: () => '─',
	summary: event => plainSummary(event.data.trigger),
	expansion: dataExpansion,
};

const setup: EventRenderer<'setup'> = {
	operation: () => 'setup',
	label: () => 'Setup',
	detail: () => '─',
	summary: event => plainSummary(event.data.trigger),
	expansion: rawOrDataExpansion,
};

const unknownHook: EventRenderer<'unknown.hook'> = {
	operation: () => 'unknown',
	label: () => 'Unknown',
	detail: () => '─',
	summary: event => plainSummary(event.data.hook_event_name),
	expansion: rawOrDataExpansion,
};

// === todos ===

const todoAdd: EventRenderer<'todo.add'> = {
	operation: () => 'todo.add',
	label: () => 'Todo Add',
	detail: event => (event.data.priority ?? 'p1').toUpperCase(),
	summary: event =>
		plainSummary(
			`${event.data.priority?.toUpperCase() ?? 'P1'} ${event.data.text}`,
		),
	expansion: rawOrDataExpansion,
};

const todoUpdate: EventRenderer<'todo.update'> = {
	operation: () => 'todo.upd',
	label: () => 'Todo Update',
	detail: event => event.data.todo_id,
	summary: event => {
		const patchFields = Object.keys(event.data.patch);
		return plainSummary(
			`${event.data.todo_id} ${patchFields.length > 0 ? patchFields.join(',') : 'update'}`,
		);
	},
	expansion: rawOrDataExpansion,
};

const todoDone: EventRenderer<'todo.done'> = {
	operation: () => 'todo.done',
	label: () => 'Todo Done',
	detail: event => event.data.todo_id,
	summary: event =>
		plainSummary(`${event.data.todo_id} ${event.data.reason || 'done'}`),
	expansion: rawOrDataExpansion,
};

// === agent / teammate / task ===

const agentMessage: EventRenderer<'agent.message'> = {
	operation: () => 'agent.msg',
	label: () => 'Agent Msg',
	detail: () => '─',
	summary: event => {
		const text = compactText(
			firstSentence(stripMarkdownInline(event.data.message)),
			200,
		);
		return {text, segments: [{text, role: 'plain'}]};
	},
	expansion: rawOrDataExpansion,
};

const teammateIdle: EventRenderer<'teammate.idle'> = {
	operation: () => 'tm.idle',
	label: () => 'Team Idle',
	detail: () => '─',
	summary: event =>
		plainSummary(`${event.data.teammate_name} idle in ${event.data.team_name}`),
	expansion: rawOrDataExpansion,
};

const taskCompleted: EventRenderer<'task.completed'> = {
	operation: () => 'task.ok',
	label: () => 'Task OK',
	detail: () => '─',
	summary: event => plainSummary(event.data.task_subject),
	expansion: rawOrDataExpansion,
};

// === config ===

const configChange: EventRenderer<'config.change'> = {
	operation: () => 'cfg.chg',
	label: () => 'Config Chg',
	detail: event => event.data.source,
	summary: event =>
		plainSummary(
			`${event.data.source}${event.data.file_path ? ` ${event.data.file_path}` : ''}`,
		),
	expansion: rawOrDataExpansion,
};

// === default-rendered kinds ───────────────────────────────
// All of these collapse to op='event' / label='Event' / detail='─'.
// Their expansion uses raw ?? data, and their summary is a plain compact.

const compactPost: EventRenderer<'compact.post'> = defaultRenderer(
	event => `compacted (${event.data.trigger})`,
);

const taskCreated: EventRenderer<'task.created'> = defaultRenderer(
	event => event.data.task_subject,
);

const cwdChanged: EventRenderer<'cwd.changed'> = defaultRenderer(
	event => `cwd → ${event.data.cwd}`,
);

const fileChanged: EventRenderer<'file.changed'> = defaultRenderer(
	event => `changed ${event.data.file_path}`,
);

const instructionsLoaded: EventRenderer<'instructions.loaded'> =
	defaultRenderer(
		event =>
			`${event.data.memory_type ?? 'instructions'} ${event.data.file_path}`,
	);

const worktreeCreate: EventRenderer<'worktree.create'> = defaultRenderer(
	event => `created ${event.data.worktree_path}`,
);

const worktreeRemove: EventRenderer<'worktree.remove'> = defaultRenderer(
	event => `removed ${event.data.worktree_path}`,
);

const stopFailure: EventRenderer<'stop.failure'> = defaultRenderer(
	event =>
		`${event.data.error_type}${event.data.error_message ? `: ${event.data.error_message}` : ''}`,
);

const permissionDenied: EventRenderer<'permission.denied'> = defaultRenderer(
	event =>
		`${event.data.tool_name}${event.data.reason ? `: ${event.data.reason}` : ''}`,
);

const elicitationRequest: EventRenderer<'elicitation.request'> =
	defaultRenderer(event => `elicitation from ${event.data.mcp_server}`);

const elicitationResult: EventRenderer<'elicitation.result'> = defaultRenderer(
	event => `${event.data.mcp_server} → ${event.data.action}`,
);

const channelPermissionRelayed: EventRenderer<'channel.permission.relayed'> =
	defaultRenderer(
		event =>
			`${event.data.channel_name}: ${event.data.tool_name} (${event.data.channel_request_id})`,
	);

const channelPermissionResolved: EventRenderer<'channel.permission.resolved'> =
	defaultRenderer(
		event =>
			`${event.data.channel_name} ${event.data.source} ${event.data.tool_name}`,
	);

const channelQuestionRelayed: EventRenderer<'channel.question.relayed'> =
	defaultRenderer(
		event =>
			`${event.data.channel_name}: ${event.data.title} (${event.data.channel_request_id})`,
	);

const channelQuestionResolved: EventRenderer<'channel.question.resolved'> =
	defaultRenderer(
		event =>
			`${event.data.channel_name || event.data.source} ${event.data.source} ${event.data.title}`,
	);

const channelChatInbound: EventRenderer<'channel.chat.inbound'> =
	defaultRenderer(event => `${event.data.channel_name}: ${event.data.content}`);

const channelChatOutbound: EventRenderer<'channel.chat.outbound'> =
	defaultRenderer(
		event =>
			`${event.data.channel_name} → ${event.data.target_peer_id}: ${event.data.content}`,
	);

const gatewayFunctionInvoked: EventRenderer<'gateway.function.invoked'> =
	defaultRenderer(
		event =>
			`fn invoked: ${event.data.function_name} (${event.data.caller_kind})`,
	);

const gatewayFunctionCompleted: EventRenderer<'gateway.function.completed'> =
	defaultRenderer(
		event => `fn ok: ${event.data.function_name} ${event.data.duration_ms}ms`,
	);

const gatewayFunctionFailed: EventRenderer<'gateway.function.failed'> =
	defaultRenderer(
		event =>
			`fn ${event.data.reason}: ${event.data.function_name} — ${event.data.error_message}`,
	);

const artifactsManifest: EventRenderer<'artifacts.manifest'> = defaultRenderer(
	event => {
		const manifest = event.data.manifest as {entries?: unknown};
		const count = Array.isArray(manifest.entries) ? manifest.entries.length : 0;
		return `artifacts manifest (${count} item${count === 1 ? '' : 's'})`;
	},
);

// ── Registry ──────────────────────────────────────────────

const RENDERERS = {
	'session.start': sessionStart,
	'session.end': sessionEnd,
	'run.start': runStart,
	'run.end': runEnd,
	'user.prompt': userPrompt,
	'plan.update': planUpdate,
	'reasoning.summary': reasoningSummary,
	'usage.update': usageUpdate,
	'tool.delta': toolDelta,
	'tool.pre': toolPre,
	'tool.post': toolPost,
	'tool.failure': toolFailure,
	'permission.request': permissionRequest,
	'permission.decision': permissionDecision,
	'stop.request': stopRequest,
	'stop.decision': stopDecision,
	'subagent.start': subagentStart,
	'subagent.stop': subagentStop,
	notification,
	'runtime.error': runtimeError,
	'thread.status': threadStatus,
	'turn.diff': turnDiff,
	'server.request.resolved': serverRequestResolved,
	'web.search': webSearch,
	'review.status': reviewStatus,
	'image.view': imageView,
	'context.compaction': contextCompaction,
	'mcp.progress': mcpProgress,
	'terminal.input': terminalInput,
	'skills.changed': skillsChanged,
	'skills.loaded': skillsLoaded,
	'compact.pre': compactPre,
	'compact.post': compactPost,
	setup,
	'unknown.hook': unknownHook,
	'todo.add': todoAdd,
	'todo.update': todoUpdate,
	'todo.done': todoDone,
	'agent.message': agentMessage,
	'teammate.idle': teammateIdle,
	'task.created': taskCreated,
	'task.completed': taskCompleted,
	'config.change': configChange,
	'cwd.changed': cwdChanged,
	'file.changed': fileChanged,
	'instructions.loaded': instructionsLoaded,
	'worktree.create': worktreeCreate,
	'worktree.remove': worktreeRemove,
	'stop.failure': stopFailure,
	'permission.denied': permissionDenied,
	'elicitation.request': elicitationRequest,
	'elicitation.result': elicitationResult,
	'channel.permission.relayed': channelPermissionRelayed,
	'channel.permission.resolved': channelPermissionResolved,
	'channel.question.relayed': channelQuestionRelayed,
	'channel.question.resolved': channelQuestionResolved,
	'channel.chat.inbound': channelChatInbound,
	'channel.chat.outbound': channelChatOutbound,
	'gateway.function.invoked': gatewayFunctionInvoked,
	'gateway.function.completed': gatewayFunctionCompleted,
	'gateway.function.failed': gatewayFunctionFailed,
	'artifacts.manifest': artifactsManifest,
} as const satisfies RendererRegistry;

/** Lookup helper: dispatches an event to its renderer with proper type narrowing. */
function rendererFor<E extends FeedEvent>(event: E): EventRenderer<E['kind']> {
	return RENDERERS[event.kind] as unknown as EventRenderer<E['kind']>;
}

// ── Public dispatch functions ─────────────────────────────

export function eventOperation(event: FeedEvent): string {
	return rendererFor(event).operation(event as never);
}

/** Human-readable Title Case label for the EVENT column. */
export function eventLabel(event: FeedEvent): string {
	return rendererFor(event).label(event as never);
}

/** Extract contextual detail for the DETAIL column (tool name, agent type, etc.). */
export function eventDetail(event: FeedEvent): string {
	return rendererFor(event).detail(event as never);
}

export function eventSummary(event: FeedEvent): SummaryResult {
	const harness = harnessSummary(event);
	if (harness) return harness;
	return rendererFor(event).summary(event as never);
}

export function expansionForEvent(event: FeedEvent): string {
	return rendererFor(event).expansion(event as never);
}

export function isEventError(event: FeedEvent): boolean {
	if (event.level === 'error') return true;
	const renderer = rendererFor(event);
	return renderer.isError?.(event as never) ?? false;
}

export function isEventExpandable(event: FeedEvent): boolean {
	void event;
	return true;
}

// ── Tool-pair (merged) renderers ─────────────────────────

interface ToolPairRenderer {
	operation: (
		pre: Ev<'tool.pre'> | Ev<'permission.request'>,
		post: FeedEvent,
	) => string;
	label: (
		pre: Ev<'tool.pre'> | Ev<'permission.request'>,
		post: FeedEvent,
	) => string;
	summary: (
		pre: Ev<'tool.pre'> | Ev<'permission.request'>,
		post: FeedEvent,
	) => SummaryResult;
}

const toolPairOk: ToolPairRenderer = {
	operation: () => 'tool.ok',
	label: () => 'Tool OK',
	summary: (pre, post) => buildMergedToolSummary(pre, post),
};

const toolPairFail: ToolPairRenderer = {
	operation: () => 'tool.fail',
	label: () => 'Tool Fail',
	summary: (pre, post) => buildMergedToolSummary(pre, post),
};

/** Lookup keyed by the post event's kind. Only `tool.post` and `tool.failure` produce a merged rendering. */
const TOOL_PAIRS: Partial<Record<FeedEventKind, ToolPairRenderer>> = {
	'tool.post': toolPairOk,
	'tool.failure': toolPairFail,
};

function buildMergedToolSummary(
	event: Ev<'tool.pre'> | Ev<'permission.request'>,
	postEvent: FeedEvent,
): SummaryResult {
	const harness = harnessSummary(event) ?? harnessSummary(postEvent);
	if (harness) {
		return {
			...harness,
			outcome: postOutcome(postEvent),
			outcomeZero: false,
		};
	}

	const toolName = event.data.tool_name;
	// Prefer tool.pre input, but fall back to tool.post input when the pre
	// event lacks useful data (e.g. codex WebSearch where query only arrives
	// with item/completed).
	const preInput = event.data.tool_input;
	const postInput =
		postEvent.kind === 'tool.post' || postEvent.kind === 'tool.failure'
			? postEvent.data.tool_input
			: undefined;
	const toolInput =
		postInput && Object.keys(preInput).every(k => preInput[k] == null)
			? postInput
			: preInput;
	const parsed = parseToolName(toolName);
	const name = resolveVerb(toolName, parsed);
	const primaryInput = withMcpServerContext(
		parsed,
		summarizeToolPrimaryInput(toolName, toolInput),
	);

	let resultText: string;
	if (postEvent.kind === 'tool.failure') {
		resultText = summarizeToolResult(
			toolName,
			toolInput,
			undefined,
			postEvent.data.error,
		);
	} else if (postEvent.kind === 'tool.post') {
		resultText = summarizeToolResult(
			toolName,
			toolInput,
			postEvent.data.tool_response,
		);
	} else {
		// tool.delta or other — caller already filtered, but be defensive
		return eventSummary(event);
	}

	const prefix = primaryInput ? `${name} ${primaryInput}` : name;
	const prefixText = compactText(prefix, 200);
	const segments: SummarySegment[] = primaryInput
		? [
				{text: name, role: 'verb'},
				{text: prefixText.slice(name.length), role: 'target'},
			]
		: [{text: prefixText, role: 'verb'}];

	if (!resultText) {
		return {text: prefixText, segments};
	}
	return {
		text: prefixText,
		segments,
		outcome: resultText,
		outcomeZero: /^0\s/.test(resultText),
	};
}

// ── Public merged dispatch functions ─────────────────────

/**
 * Return the merged op code for a tool.pre that has a paired post/failure.
 * Falls back to the default eventOperation when no postEvent is given.
 */
export function mergedEventOperation(
	event: FeedEvent,
	postEvent?: FeedEvent,
): string {
	if (!postEvent) return eventOperation(event);
	const pair = TOOL_PAIRS[postEvent.kind];
	if (!pair) return eventOperation(event);
	return pair.operation(event as never, postEvent);
}

/**
 * Return the merged Title Case label for a tool.pre that has a paired post/failure.
 * Falls back to the default eventLabel when no postEvent is given.
 */
export function mergedEventLabel(
	event: FeedEvent,
	postEvent?: FeedEvent,
): string {
	if (!postEvent) return eventLabel(event);
	const pair = TOOL_PAIRS[postEvent.kind];
	if (!pair) return eventLabel(event);
	return pair.label(event as never, postEvent);
}

/**
 * Return the merged summary for a tool.pre paired with its post/failure.
 * Format: "ToolName — result summary" with verb/target segments.
 */
export function mergedEventSummary(
	event: FeedEvent,
	postEvent?: FeedEvent,
): SummaryResult {
	if (!postEvent) return eventSummary(event);
	if (event.kind !== 'tool.pre' && event.kind !== 'permission.request') {
		return eventSummary(event);
	}
	const pair = TOOL_PAIRS[postEvent.kind];
	if (!pair) return eventSummary(event);
	return pair.summary(event, postEvent);
}

// ── Run title / status / stability ───────────────────────

export function deriveRunTitle(
	currentPromptPreview: string | undefined,
	feedEvents: FeedEvent[],
	messages: Message[],
): string {
	if (currentPromptPreview?.trim()) {
		return compactText(currentPromptPreview, 44);
	}
	for (let i = feedEvents.length - 1; i >= 0; i--) {
		const event = feedEvents[i]!;
		if (
			event.kind === 'run.start' &&
			event.data.trigger.prompt_preview?.trim()
		) {
			return compactText(event.data.trigger.prompt_preview, 44);
		}
		if (event.kind === 'user.prompt' && event.data.prompt.trim()) {
			return compactText(event.data.prompt, 44);
		}
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role === 'user' && message.content.trim()) {
			return compactText(message.content, 44);
		}
	}
	return 'Untitled run';
}

// ── Verbose filtering ────────────────────────────────────

export const VERBOSE_ONLY_KINDS: ReadonlySet<FeedEventKind> = new Set([
	'session.start',
	'session.end',
	'run.start',
	'run.end',
	'unknown.hook',
	'compact.pre',
	'config.change',
	'instructions.loaded',
	'worktree.create',
	'worktree.remove',
	'turn.diff',
	'usage.update',
	'reasoning.summary',
	// Codex protocol bookkeeping that churns the feed without conveying
	// meaningful agent progress. `usage.update` (above) still feeds header
	// token/context metrics via the raw event stream — only the rendered row
	// is suppressed in the default (non-verbose) feed.
	'thread.status',
	'server.request.resolved',
]);

/**
 * Generic `notification` events whose `notification_type` is high-frequency
 * Codex bookkeeping. These reach the feed as `kind: 'notification'` (they have
 * no dedicated FeedEvent kind) and dominate the timeline without conveying
 * actionable state. They are hidden from the default feed but remain visible
 * in verbose mode.
 *
 * Anything not listed here — config warnings, codex errors/warnings,
 * deprecation notices, login/auth completion, MCP server status — is treated
 * as meaningful and always rendered.
 */
export const VERBOSE_ONLY_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
	'account.rate_limits_updated',
	'account.updated',
	'item.agentMessage.started',
	'raw_response_item.completed',
	'command_exec.output_delta',
	'fuzzy_file_search.updated',
	'fuzzy_file_search.completed',
	'app.list_updated',
	'thread_name',
	'thread.archived',
	'thread.unarchived',
	'thread.realtime.transcript_delta',
	'thread.realtime.output_audio_delta',
]);

/**
 * True when the event is a generic Codex `notification` carrying a
 * high-frequency bookkeeping `notification_type` (see
 * {@link VERBOSE_ONLY_NOTIFICATION_TYPES}). Such rows are suppressed in the
 * default feed and shown only in verbose mode.
 */
export function isVerboseOnlyNotification(event: FeedEvent): boolean {
	return (
		event.kind === 'notification' &&
		typeof event.data.notification_type === 'string' &&
		VERBOSE_ONLY_NOTIFICATION_TYPES.has(event.data.notification_type)
	);
}

/**
 * A TimelineEntry is "stable" when its content is finalized and won't change.
 * Unstable entries are tool.pre / permission.request without a paired post event.
 */
export function isEntryStable(entry: TimelineEntry): boolean {
	if (!entry.feedEvent) return true;
	const kind = entry.feedEvent.kind;
	if (kind === 'tool.pre' || kind === 'permission.request') {
		return (
			entry.pairedPostEvent !== undefined &&
			entry.pairedPostEvent.kind !== 'tool.delta'
		);
	}
	return true;
}

export function toRunStatus(
	event: Extract<FeedEvent, {kind: 'run.end'}>,
): RunStatus {
	switch (event.data.status) {
		case 'completed':
			return 'SUCCEEDED';
		case 'failed':
			return 'FAILED';
		case 'aborted':
			return 'CANCELLED';
	}
}
