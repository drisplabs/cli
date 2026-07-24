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
 * §3). The cap resets whenever the Tracker advances between stops, so only
 * unproductive repeated stops escalate.
 */
export const DEFAULT_NUDGE_CAP = 3;

export type LoopConfig = {
	enabled: boolean;
	/**
	 * Substring that signals the workflow completed successfully.
	 * Defaults to `<!-- WORKFLOW_COMPLETE -->` when omitted.
	 */
	completionMarker?: string;
	maxIterations: number;
	/**
	 * Consecutive Nudges tolerated without Tracker progress before the Run
	 * suspends (ADR 0014 §3). Resets whenever the Tracker changes between
	 * stops. Defaults to {@link DEFAULT_NUDGE_CAP} when omitted.
	 */
	nudgeCap?: number;
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
	 * Prefix that signals the workflow is blocked.
	 * Defaults to `<!-- WORKFLOW_BLOCKED` when omitted.
	 */
	blockedMarker?: string;
	/**
	 * Relative path to the tracker file. Supports `{sessionId}` substitution.
	 * Defaults to `.athena/{sessionId}/tracker.md` when omitted.
	 */
	trackerPath?: string;
	/** Prompt template for iterations 2+; supports {trackerPath} placeholder */
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
