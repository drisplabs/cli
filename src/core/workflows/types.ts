/**
 * Workflow configuration — loaded from workflow.json.
 *
 * Workflows live in ~/.config/athena/workflows/{name}/workflow.json
 * and orchestrate multiple plugins via marketplace refs.
 */

/**
 * Default {@link LoopConfig.maxTurnTokenCount}: ~65% of a 200k model window.
 *
 * The bound must sit well under the window (ADR 0014 §5): a Handover fork
 * inherits the full conversation and summarizing N tokens requires ingesting
 * ~N, so headroom to hold the conversation *and* emit the Handoff file can
 * only come from triggering early — forking creates no room. Claude Code
 * additionally clamps its knob to a 100k floor (measured on 2.1.217; see
 * qa/max-turn-token-count.md), so values below 100k are silently raised there.
 */
export const DEFAULT_MAX_TURN_TOKEN_COUNT = 130000;

/**
 * Default {@link LoopConfig.nudgeCap}: consecutive undeclared, progress-free
 * stops tolerated before the Run suspends in `awaiting_attention` (ADR 0014
 * §3). The cap resets whenever the Journal advances between stops, so only
 * unproductive repeated stops escalate.
 */
export const DEFAULT_NUDGE_CAP = 3;

/**
 * Default {@link LoopConfig.retryCap}: consecutive transient Turn failures
 * tolerated before the Run suspends in `awaiting_attention` (ADR 0014 §4).
 * Resets whenever a Turn completes without failing.
 */
export const DEFAULT_RETRY_CAP = 3;

/**
 * Default {@link LoopConfig.handoverCap}: consecutive **unproductive**
 * Handovers tolerated before the Run suspends in `awaiting_attention` (ADR
 * 0018 §2). A Handover is unproductive when the Turn it ended left the
 * Journal hash unchanged since the previous Turn boundary — the session it
 * distilled added nothing durable. A productive Handover resets the streak;
 * so does a wake, because a human reply is new information. Legitimately long
 * Runs are chains of productive Handovers and never trip it.
 */
export const DEFAULT_HANDOVER_CAP = 3;

/**
 * Default base for {@link LoopConfig.retryBackoffMs}. Retry N waits
 * `retryBackoffMs * 2^(N-1)` before resuming the same Agent Session.
 */
export const DEFAULT_RETRY_BACKOFF_MS = 10_000;

/**
 * Default permission grace window (#190): how long an unattended Workflow
 * Run holds a permission request no rule answers, waiting for an attached
 * hub to answer it, before refusing the call as "deferred" and parking the
 * Run as needs-human. Configurable as `permissionGraceMs` in
 * `~/.config/athena/config.json` / `.athena/config.json`, and per run with
 * `drisp run --permission-grace-ms`. With no hub attached nothing can answer,
 * so the request is deferred at once regardless of the window.
 */
export const DEFAULT_PERMISSION_GRACE_MS = 60_000;

export type LoopConfig = {
	enabled: boolean;
	/**
	 * Substring that signals the workflow completed successfully.
	 * Defaults to `<!-- WORKFLOW_COMPLETE -->` when omitted.
	 */
	completionMarker?: string;
	maxIterations: number;
	/**
	 * Consecutive Nudges tolerated without Journal progress before the Run
	 * suspends (ADR 0014 §3). Resets whenever the Journal changes between
	 * stops. Defaults to {@link DEFAULT_NUDGE_CAP} when omitted.
	 */
	nudgeCap?: number;
	/**
	 * Consecutive transient Turn failures tolerated before the Run suspends
	 * (ADR 0014 §4). Resets on any Turn that completes without failing.
	 * Defaults to {@link DEFAULT_RETRY_CAP} when omitted.
	 */
	retryCap?: number;
	/**
	 * Consecutive unproductive Handovers tolerated before the Run suspends
	 * (ADR 0018 §2) — a Handover whose Turn left the Journal unchanged. Resets
	 * on a productive Handover and on a wake. Defaults to
	 * {@link DEFAULT_HANDOVER_CAP} when omitted. A workflow that expects long
	 * orientation phases can raise it knowingly.
	 */
	handoverCap?: number;
	/**
	 * Base backoff before retrying a transient failure; retry N waits
	 * `retryBackoffMs * 2^(N-1)`. Defaults to
	 * {@link DEFAULT_RETRY_BACKOFF_MS} when omitted.
	 */
	retryBackoffMs?: number;
	/**
	 * Harness-neutral token bound for one Turn's conversation. Maps onto each
	 * harness's autocompact knob (Claude `CLAUDE_CODE_AUTO_COMPACT_WINDOW`,
	 * Codex `model_auto_compact_token_limit`) so `PreCompact` fires — and
	 * Handover can intercept it — at a configured point well under the model
	 * window. Defaults to {@link DEFAULT_MAX_TURN_TOKEN_COUNT} when omitted.
	 * The dial trading context freshness against Handover frequency.
	 */
	maxTurnTokenCount?: number;
	/**
	 * Prefix that signals the agent needs a human — a question only they can
	 * answer, or an external blocker only they can clear. Defaults to
	 * `<!-- NEEDS_HUMAN` when omitted.
	 */
	needsHumanMarker?: string;
	/**
	 * @deprecated Pre-0.6 name of {@link LoopConfig.needsHumanMarker}; read as
	 * an alias when `needsHumanMarker` is absent. Removed in 0.7.0 (#185).
	 */
	blockedMarker?: string;
	/**
	 * Relative path to the journal file. Supports `{sessionId}` substitution.
	 * Defaults to `.athena/{sessionId}/journal.md` when omitted.
	 */
	journalPath?: string;
	/**
	 * @deprecated Pre-0.6 name of {@link LoopConfig.journalPath}; read as an
	 * alias when `journalPath` is absent. Removed in 0.7.0 (#185).
	 */
	trackerPath?: string;
	/**
	 * Prompt template for iterations 2+; supports the {journalPath} placeholder
	 * (and, until 0.7.0, its deprecated {trackerPath} spelling).
	 */
	continuePrompt?: string;
};

/**
 * A plugin dependency with an explicit version pin.
 * Used in workflows to lock a specific plugin version.
 */
export type PluginDependency = {
	ref: string;
	version: string;
};

/**
 * A plugin specifier: either a bare marketplace ref string (resolves to latest)
 * or a structured dependency with a pinned version.
 */
export type PluginSpec = string | PluginDependency;

/** Extract the marketplace ref from a PluginSpec. */
export function pluginSpecRef(spec: PluginSpec): string {
	return typeof spec === 'string' ? spec : spec.ref;
}

/** Extract the pinned version from a PluginSpec, if any. */
export function pluginSpecVersion(spec: PluginSpec): string | undefined {
	return typeof spec === 'string' ? undefined : spec.version;
}

export type WorkflowConfig = {
	name: string;
	description?: string;
	version?: string;
	plugins: PluginSpec[];
	promptTemplate: string;
	loop?: LoopConfig;
	isolation?: string;
	/**
	 * **Ask rules** (#189, provisional): tool-name patterns — `*`, an exact
	 * tool name, or `mcp__server__*` — whose permission prompts must always
	 * reach a person. Unattended (`drisp run`, no hub attached) a matching
	 * prompt parks the Run as needs-human naming the pattern; it is never
	 * answered by the isolation preset's policy, even under `autonomous`.
	 * Gates as data (decision + consequences) supersede this once
	 * drisplabs/drisp-desktop#39 fixes the Workflow format.
	 */
	askRules?: string[];
	model?: string;
	/** Reasoning effort level to pin for the harness (low/medium/high/xhigh/max) */
	effort?: string;
	env?: Record<string, string>;
	/** Path to workflow orchestration doc, passed as --append-system-prompt-file */
	workflowFile?: string;
	/** Example prompts shown in the empty-state onboarding screen */
	examplePrompts?: string[];
};

export type WorkflowSourceMetadata =
	| {kind: 'marketplace-remote'; ref: string; version?: string}
	| {
			kind: 'marketplace-local';
			repoDir: string;
			workflowName: string;
			version?: string;
	  }
	| {kind: 'filesystem'; path: string};

export type ResolvedWorkflowConfig = WorkflowConfig & {
	__source?: WorkflowSourceMetadata;
};

export type ResolvedWorkflowPlugin = {
	ref: string;
	pluginName: string;
	marketplaceName: string;
	version?: string;
	pluginDir: string;
	claudeArtifactDir: string;
	codexPluginDir: string;
	codexMarketplacePath: string;
};

export type ResolvedLocalWorkflowPlugin = {
	ref: string;
	pluginDir: string;
};

export type CodexWorkflowPluginRef = {
	ref: string;
	pluginName: string;
	marketplacePath: string;
	version?: string;
};

/**
 * Terminal and non-terminal states for a workflow run.
 *
 * `awaiting_attention` is the one non-terminal give-up state (ADR 0014): the
 * Run is suspended until a human replies. `blocked` and `exhausted` are no
 * longer emitted — a declared `WORKFLOW_BLOCKED` and the `maxIterations`
 * ceiling both resolve to `awaiting_attention` — but they remain valid values
 * for historical `workflow_runs` rows.
 */
export type RunStatus =
	| 'running'
	| 'awaiting_attention'
	| 'completed'
	| 'blocked'
	| 'exhausted'
	| 'failed'
	| 'cancelled';
