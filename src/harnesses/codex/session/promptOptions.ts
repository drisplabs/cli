import type {
	HarnessProcessConfig,
	HarnessProcessOverride,
	HarnessProcessPreset,
	TurnContinuation,
} from '../../../core/runtime/process';
import type {WorkflowPlan} from '../../../core/workflows';
import {
	resolveCodexMcpConfig,
	resolveCodexWorkflowPlugins,
} from './sessionAssets';
import {HANDOFF_COMPACT_PROMPT} from '../../../core/compaction/handoffInstructions';

/**
 * String variants of the app-server's `AskForApproval` (see the generated
 * protocol type). The legacy 'auto-edit' / 'full-auto' names are rejected by
 * codex-cli 0.142+ with -32600 "unknown variant".
 */
export type CodexApprovalPolicy =
	| 'untrusted'
	| 'on-failure'
	| 'on-request'
	| 'never';
export type CodexSandbox =
	| 'read-only'
	| 'workspace-write'
	| 'danger-full-access';

export type CodexPromptOptions = {
	continuation?: TurnContinuation;
	model?: string;
	developerInstructions?: string;
	agentRoots?: string[];
	plugins: Array<{
		ref: string;
		pluginName: string;
		marketplacePath: string;
	}>;
	config?: Record<string, unknown>;
	ephemeral?: boolean;
	approvalPolicy: CodexApprovalPolicy;
	sandbox: CodexSandbox;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value === 'object' && value !== null) {
		return value as Record<string, unknown>;
	}
	return null;
}

function resolveIsolation(preset?: HarnessProcessPreset): {
	approvalPolicy: CodexApprovalPolicy;
	sandbox: CodexSandbox;
} {
	switch (preset) {
		case 'guarded':
			return {approvalPolicy: 'on-request', sandbox: 'read-only'};
		case 'autonomous':
			// Codex parity with the Claude harness's bypassPermissions: full
			// access, never ask. ('auto-edit' is not a valid AskForApproval
			// variant in codex-cli 0.142+ — it failed every spawn.)
			return {approvalPolicy: 'never', sandbox: 'danger-full-access'};
		case 'standard':
		case undefined:
			return {approvalPolicy: 'on-request', sandbox: 'workspace-write'};
	}
}

export function buildCodexPromptOptions(input: {
	processConfig?: HarnessProcessConfig;
	continuation?: TurnContinuation;
	configOverride?: HarnessProcessOverride;
	workflowPlan?: WorkflowPlan;
	pluginMcpConfig?: string;
	ephemeral?: boolean;
}): CodexPromptOptions {
	const override = asRecord(input.configOverride);
	const modelFromOverride =
		typeof override?.['model'] === 'string' ? override['model'] : undefined;
	const developerInstructions =
		typeof override?.['developerInstructions'] === 'string'
			? override['developerInstructions']
			: undefined;
	const modelFromProcess =
		typeof input.processConfig?.model === 'string'
			? input.processConfig.model
			: undefined;
	const isolation = resolveIsolation(input.processConfig?.preset);

	return {
		continuation: input.continuation,
		model: modelFromOverride ?? modelFromProcess,
		developerInstructions,
		agentRoots:
			input.workflowPlan?.agentRoots && input.workflowPlan.agentRoots.length > 0
				? input.workflowPlan.agentRoots
				: undefined,
		plugins: resolveCodexWorkflowPlugins(input.workflowPlan),
		config: {
			// Steer Codex's history compaction toward a handoff-style summary.
			// `compact_prompt` replaces the default summarization prompt.
			compact_prompt: HANDOFF_COMPACT_PROMPT,
			...(resolveCodexMcpConfig(input.pluginMcpConfig, input.workflowPlan) ??
				{}),
		},
		ephemeral: input.ephemeral,
		approvalPolicy: isolation.approvalPolicy,
		sandbox: isolation.sandbox,
	};
}
