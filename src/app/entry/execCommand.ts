import crypto from 'node:crypto';
import {
	getMostRecentAthenaSession,
	getSessionMeta,
} from '../../infra/sessions/index';
import type {RuntimeBootstrapOutput} from '../bootstrap/bootstrapConfig';
import {runExec, RUN_EXIT_CODE} from '../exec';
import {createSteerQueue} from '../../core/workflows/steer';
import {localAnswerDecision} from '../exec/permissionHold';
import {
	resolveResumeTarget,
	type ResumeRequest,
	type ResumeTarget,
} from './resumeResolution';

export type ExecCliFlags = {
	continueFlag?: string;
	/**
	 * `--steer <text>` (repeatable, #191): human steers queued for the head of
	 * the first Turn's prompt, in the order given — the local twin of the
	 * hub's `steer` frame, so a parked Run can be steered on `--continue`.
	 */
	steers?: string[];
	json: boolean;
	outputLastMessage?: string;
	ephemeral: boolean;
	timeoutMs?: number;
	verbose: boolean;
	/** `--permission-grace-ms`: overrides the configured grace window (#190). */
	permissionGraceMs?: number;
	/**
	 * `--answer=allow|deny`: the answer for the deferred permission the resumed
	 * Run parked on, replayed into the re-issued call (#190). Only with
	 * `--continue`.
	 */
	answer?: string;
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
	| 'permissionGraceMs'
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
	now?: () => number;
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
	const now = deps.now ?? Date.now;
	const runExecFn = deps.runExecFn ?? runExec;
	const getMostRecentSessionFn =
		deps.getMostRecentSessionFn ?? getMostRecentAthenaSession;
	const getSessionMetaFn = deps.getSessionMetaFn ?? getSessionMeta;

	if (input.flags.ephemeral && input.flags.continueFlag !== undefined) {
		logError('Error: --ephemeral cannot be combined with --continue.');
		return RUN_EXIT_CODE.USAGE;
	}

	if (!isValidTimeout(input.flags.timeoutMs)) {
		logError('Error: --timeout-ms must be a positive number.');
		return RUN_EXIT_CODE.USAGE;
	}

	const graceMs = input.flags.permissionGraceMs;
	if (graceMs !== undefined && (!Number.isFinite(graceMs) || graceMs < 0)) {
		logError('Error: --permission-grace-ms must be a non-negative number.');
		return RUN_EXIT_CODE.USAGE;
	}

	const answer = input.flags.answer;
	if (answer !== undefined && answer !== 'allow' && answer !== 'deny') {
		logError('Error: --answer must be "allow" or "deny".');
		return RUN_EXIT_CODE.USAGE;
	}
	if (answer !== undefined && input.flags.continueFlag === undefined) {
		logError(
			'Error: --answer only applies with --continue (it answers the permission a parked run is waiting on).',
		);
		return RUN_EXIT_CODE.USAGE;
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
		return RUN_EXIT_CODE.RUNTIME;
	}
	if (!continueResolution) {
		return RUN_EXIT_CODE.RUNTIME;
	}

	const localSteers = (input.flags.steers ?? []).filter(
		text => text.trim().length > 0,
	);
	const steerQueue = localSteers.length > 0 ? createSteerQueue() : undefined;
	for (const text of localSteers) {
		steerQueue!.push({text, origin: 'local', receivedAt: now()});
	}

	const result = await runExecFn({
		prompt: input.prompt,
		projectDir: input.projectDir,
		harness: input.runtimeConfig.harness,
		athenaSessionId: continueResolution.athenaSessionId,
		adapterResumeSessionId: continueResolution.adapterResumeSessionId,
		resumeRunId: continueResolution.resumeRunId,
		...(steerQueue ? {steerQueue} : {}),
		isolationConfig: input.runtimeConfig.isolationConfig,
		pluginMcpConfig: input.runtimeConfig.pluginMcpConfig,
		workflow: input.runtimeConfig.workflow,
		workflowPlan: input.runtimeConfig.workflowPlan,
		verbose: input.flags.verbose,
		json: input.flags.json,
		outputLastMessagePath: input.flags.outputLastMessage,
		ephemeral: input.flags.ephemeral,
		timeoutMs: input.flags.timeoutMs,
		permissionGraceMs: graceMs ?? input.runtimeConfig.permissionGraceMs,
		...(answer !== undefined
			? {storedAnswer: localAnswerDecision(answer)}
			: {}),
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
