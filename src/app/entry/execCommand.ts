import crypto from 'node:crypto';
import {
	getMostRecentAthenaSession,
	getSessionMeta,
} from '../../infra/sessions/index';
import type {RuntimeBootstrapOutput} from '../bootstrap/bootstrapConfig';
import {runExec, EXEC_EXIT_CODE} from '../exec';
import {
	resolveResumeTarget,
	type ResumeRequest,
	type ResumeTarget,
} from './resumeResolution';

export type ExecCliFlags = {
	continueFlag?: string;
	json: boolean;
	outputLastMessage?: string;
	ephemeral: boolean;
	timeoutMs?: number;
	verbose: boolean;
	channels?: readonly string[];
};

export type ExecRuntimeConfig = Pick<
	RuntimeBootstrapOutput,
	| 'harness'
	| 'isolationConfig'
	| 'pluginMcpConfig'
	| 'workflow'
	| 'workflowPlan'
	| 'personalMcpServers'
	| 'personalSkills'
	| 'capabilityConflicts'
>;

export type RunExecCommandInput = {
	projectDir: string;
	prompt: string;
	flags: ExecCliFlags;
	runtimeConfig: ExecRuntimeConfig;
};

export type RunExecCommandDeps = {
	logError?: (message: string) => void;
	createSessionId?: () => string;
	runExecFn?: typeof runExec;
	getMostRecentSessionFn?: typeof getMostRecentAthenaSession;
	getSessionMetaFn?: typeof getSessionMeta;
};

function isValidTimeout(timeoutMs: number | undefined): boolean {
	if (timeoutMs === undefined) return true;
	return Number.isFinite(timeoutMs) && timeoutMs > 0;
}

function continueFlagToRequest(
	continueFlag: string | undefined,
): ResumeRequest {
	// undefined → no --continue → fresh session
	if (continueFlag === undefined) return {kind: 'fresh'};
	// '' → bare --continue → resume the most recent session
	if (continueFlag === '') return {kind: 'most-recent'};
	// 'id' → --continue <id> → resume that explicit session
	return {kind: 'explicit', sessionId: continueFlag};
}

export async function runExecCommand(
	input: RunExecCommandInput,
	deps: RunExecCommandDeps = {},
): Promise<number> {
	const logError = deps.logError ?? console.error;
	const createSessionId = deps.createSessionId ?? crypto.randomUUID;
	const runExecFn = deps.runExecFn ?? runExec;
	const getMostRecentSessionFn =
		deps.getMostRecentSessionFn ?? getMostRecentAthenaSession;
	const getSessionMetaFn = deps.getSessionMetaFn ?? getSessionMeta;

	if (input.flags.ephemeral && input.flags.continueFlag !== undefined) {
		logError('Error: --ephemeral cannot be combined with --continue.');
		return EXEC_EXIT_CODE.USAGE;
	}

	if (!isValidTimeout(input.flags.timeoutMs)) {
		logError('Error: --timeout-ms must be a positive number.');
		return EXEC_EXIT_CODE.USAGE;
	}

	let continueResolution: ResumeTarget | undefined;
	try {
		continueResolution = resolveResumeTarget({
			projectDir: input.projectDir,
			request: continueFlagToRequest(input.flags.continueFlag),
			// Headless exec treats a missing resume target as a hard error rather
			// than silently starting fresh, so a resume request that finds nothing
			// exits non-zero for callers/scripts.
			missingRecentPolicy: 'error',
			messages: {
				unknownExplicit: sessionId =>
					`Error: Unknown Athena session ID: ${sessionId}`,
				missingRecent:
					'Error: --continue was provided but no previous Athena sessions exist for this project.',
			},
			createSessionId,
			getMostRecentSessionFn,
			getSessionMetaFn,
			logError,
		});
	} catch (error) {
		logError(
			`Error: Failed to resolve --continue session: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return EXEC_EXIT_CODE.RUNTIME;
	}
	if (!continueResolution) {
		return EXEC_EXIT_CODE.RUNTIME;
	}

	const result = await runExecFn({
		prompt: input.prompt,
		projectDir: input.projectDir,
		harness: input.runtimeConfig.harness,
		athenaSessionId: continueResolution.athenaSessionId,
		adapterResumeSessionId: continueResolution.adapterResumeSessionId,
		resumeRunId: continueResolution.resumeRunId,
		isolationConfig: input.runtimeConfig.isolationConfig,
		pluginMcpConfig: input.runtimeConfig.pluginMcpConfig,
		workflow: input.runtimeConfig.workflow,
		workflowPlan: input.runtimeConfig.workflowPlan,
		verbose: input.flags.verbose,
		json: input.flags.json,
		outputLastMessagePath: input.flags.outputLastMessage,
		ephemeral: input.flags.ephemeral,
		timeoutMs: input.flags.timeoutMs,
		channels: input.flags.channels,
		// Reporting-only summary: strip to name + source layer so secret-bearing
		// MCP env/command/args and skill paths never reach the startup notice or
		// the exec.started event (R3).
		personalCapabilities: {
			mcpServers: input.runtimeConfig.personalMcpServers.map(server => ({
				name: server.name,
				sourceLayer: server.sourceLayer,
			})),
			skills: input.runtimeConfig.personalSkills.map(skill => ({
				name: skill.name,
				sourceLayer: skill.sourceLayer,
			})),
		},
		// Same strip for shadowed (conflicting) capabilities — name + source
		// layer only, never the personal MCP env/command/args or skill path (R7).
		capabilityConflicts: {
			mcpServers: input.runtimeConfig.capabilityConflicts.mcpServers.map(
				server => ({
					name: server.name,
					sourceLayer: server.sourceLayer,
				}),
			),
			skills: input.runtimeConfig.capabilityConflicts.skills.map(skill => ({
				name: skill.name,
				sourceLayer: skill.sourceLayer,
			})),
		},
	});

	return result.exitCode;
}
