import {bootstrapRuntimeConfig} from '../bootstrap/bootstrapConfig';
import {normalizeHarnessOverride} from '../bootstrap/harnessOverride';
import {runExec} from '../exec';
import type {ExecRunOptions, ExecRunResult} from '../exec/types';
import type {AthenaHarness} from '../../infra/plugins/config';
import {
	installWorkflowFromSource,
	resolveWorkflow,
	type WorkflowConfig,
} from '../../core/workflows';
import {readGlobalConfig} from '../../infra/plugins/config';
import {
	resolveWorkflowInstall,
	type ResolvedWorkflowSource,
} from '../../infra/plugins/marketplace';
import type {
	InstanceSocketClient,
	InstanceSocketFrame,
	InstanceSocketLogger,
} from './instanceSocketClient';
import {
	createRunStreamClient,
	type RunStreamClient,
	type RunStreamClientOptions,
} from './runStreamClient';
import type {DashboardDecisionInbox} from './dashboardDecisionInbox';
import {
	createRemoteRunEventPublisher,
	type RemoteRunEventPublisher,
} from './remoteRunEventPublisher';
import {
	captureAndUploadArtifacts,
	parseArtifactUploadSpec,
	type UploadObjectFn,
} from './artifactCapture';
import type {PairedFeedPublisher} from './pairedFeedPublisher';

const DEFAULT_MARKETPLACE_SLUG = 'lespaceman/athena-workflow-marketplace';

type JobAssignmentFrame = Extract<
	InstanceSocketFrame,
	{type: 'job_assignment'}
>;

export type RemoteRunSpec = {
	prompt: string;
	athenaSessionId?: string;
	adapterResumeSessionId?: string;
	sessionId?: string;
	projectDir?: string;
	workflow?: {source?: string; ref?: string; version?: string};
	harness?: AthenaHarness;
	env?: Record<string, string>;
	timeoutSec?: number;
	/**
	 * Per-run callback channel minted by the dashboard's `prepareDispatch`.
	 * When both fields are present, the executor opens a dedicated WebSocket
	 * to RunStreamDO instead of relaying frames through the long-lived
	 * instance socket. The per-run channel survives instance-socket
	 * disconnects and replays unacked frames on reconnect — see
	 * `runStreamClient.ts` for the full protocol.
	 */
	callbackWsUrl?: string;
	callbackToken?: string;
};

export type ExecuteRemoteAssignmentInput = {
	assignment: ValidatedAssignment;
	client: Pick<InstanceSocketClient, 'sendRunEvent'>;
	projectDir: string;
	log?: InstanceSocketLogger;
	runExecFn?: (options: ExecRunOptions) => Promise<ExecRunResult>;
	decisionInbox?: DashboardDecisionInbox;
	bootstrapRuntimeConfigFn?: typeof bootstrapRuntimeConfig;
	now?: () => number;
	abortSignal?: AbortSignal;
	/** Test seam — override the per-run stream client factory. */
	createRunStreamClientFn?: (opts: RunStreamClientOptions) => RunStreamClient;
	resolveWorkflowFn?: typeof resolveWorkflow;
	resolveWorkflowInstallFn?: typeof resolveWorkflowInstall;
	installWorkflowFromSourceFn?: typeof installWorkflowFromSource;
	readGlobalConfigFn?: typeof readGlobalConfig;
	uploadArtifactObjectFn?: UploadObjectFn;
	dashboardFeedPublisher?: PairedFeedPublisher;
	/**
	 * Bound on how long to wait for the per-run WebSocket to come up before
	 * falling back to the instance-socket relay. Default 5s — short enough
	 * that a transient outage doesn't stall the user-visible
	 * "assignment received" frame.
	 */
	runStreamConnectTimeoutMs?: number;
};

type JsonExecEvent = {
	type?: unknown;
	ts?: unknown;
	data?: unknown;
};

export function parseRemoteRunSpec(value: unknown): RemoteRunSpec | null {
	if (typeof value !== 'object' || value === null) return null;
	const obj = value as Record<string, unknown>;
	const prompt = obj['prompt'];
	if (typeof prompt !== 'string' || prompt.trim().length === 0) return null;
	const env = obj['env'];
	const workflow = obj['workflow'];
	const callbackWsUrl = obj['callbackWsUrl'];
	const callbackToken = obj['callbackToken'];
	const workflowObj =
		typeof workflow === 'object' && workflow !== null
			? (workflow as Record<string, unknown>)
			: null;
	return {
		prompt,
		athenaSessionId:
			typeof obj['athenaSessionId'] === 'string' &&
			obj['athenaSessionId'].length > 0
				? obj['athenaSessionId']
				: undefined,
		adapterResumeSessionId:
			typeof obj['adapterResumeSessionId'] === 'string' &&
			obj['adapterResumeSessionId'].length > 0
				? obj['adapterResumeSessionId']
				: undefined,
		sessionId:
			typeof obj['sessionId'] === 'string' && obj['sessionId'].length > 0
				? obj['sessionId']
				: undefined,
		projectDir:
			typeof obj['projectDir'] === 'string' && obj['projectDir'].length > 0
				? obj['projectDir']
				: undefined,
		workflow:
			workflowObj && typeof workflowObj['ref'] === 'string'
				? {
						ref: workflowObj['ref'],
						...(typeof workflowObj['source'] === 'string'
							? {source: workflowObj['source']}
							: {}),
						...(typeof workflowObj['version'] === 'string'
							? {version: workflowObj['version']}
							: {}),
					}
				: undefined,
		harness: normalizeHarnessOverride(obj['harness']),
		env:
			typeof env === 'object' && env !== null
				? Object.fromEntries(
						Object.entries(env as Record<string, unknown>).filter(
							(entry): entry is [string, string] =>
								typeof entry[1] === 'string',
						),
					)
				: undefined,
		timeoutSec:
			typeof obj['timeoutSec'] === 'number' &&
			Number.isFinite(obj['timeoutSec'])
				? obj['timeoutSec']
				: undefined,
		callbackWsUrl:
			typeof callbackWsUrl === 'string' && callbackWsUrl.length > 0
				? callbackWsUrl
				: undefined,
		callbackToken:
			typeof callbackToken === 'string' && callbackToken.length > 0
				? callbackToken
				: undefined,
	};
}

/**
 * A Dashboard assignment that has passed the single validation gate: its
 * `runSpec` parsed cleanly (prompt guaranteed present) and its identity fields
 * are normalized. Workspace resolution, admission, and Run launch all consume
 * this instead of reparsing the raw frame. The raw `frame` is retained for
 * orthogonal concerns (e.g. artifact-upload spec parsing) that read the raw
 * `runSpec` shape rather than the validated `RemoteRunSpec`.
 */
export type ValidatedAssignment = {
	runId: string;
	runnerId: string;
	spec: RemoteRunSpec;
	frame: JobAssignmentFrame;
};

export type AssignmentValidation =
	| {kind: 'valid'; assignment: ValidatedAssignment}
	| {
			kind: 'rejected';
			rejection: {reason: 'malformed_assignment'; message: string};
	  };

/**
 * The one validation path for a Dashboard assignment: parse + validate the
 * frame once into a {@link ValidatedAssignment} or a first-class rejection.
 */
export function validateDashboardAssignment(
	frame: JobAssignmentFrame,
): AssignmentValidation {
	const spec = parseRemoteRunSpec(frame.runSpec);
	if (!spec) {
		return {
			kind: 'rejected',
			rejection: {
				reason: 'malformed_assignment',
				message: 'remote assignment missing prompt',
			},
		};
	}
	return {
		kind: 'valid',
		assignment: {
			runId: frame.runId,
			runnerId: frame.runnerId ?? 'legacy',
			spec,
			frame,
		},
	};
}

function workflowNameFromRef(ref: string | undefined): string | undefined {
	if (!ref) return undefined;
	const [name] = ref.split('@', 1);
	return name && name.length > 0 ? name : undefined;
}

function isMissingWorkflowError(err: unknown, workflowName: string): boolean {
	return (
		err instanceof Error &&
		err.message.includes(`Workflow "${workflowName}" not found`)
	);
}

function configuredWorkflowSources(
	readGlobalConfigFn: typeof readGlobalConfig,
): string[] {
	const sources = readGlobalConfigFn().workflowMarketplaceSources;
	return sources && sources.length > 0 ? sources : [DEFAULT_MARKETPLACE_SLUG];
}

function workflowInstallRef(spec: RemoteRunSpec): string | undefined {
	const ref = spec.workflow?.ref;
	if (!ref) return undefined;
	const version = spec.workflow?.version;
	if (version && !ref.includes('@')) {
		return `${ref}@${version}`;
	}
	return ref;
}

function workflowInstallSources(
	spec: RemoteRunSpec,
	readGlobalConfigFn: typeof readGlobalConfig,
): string[] {
	const source = spec.workflow?.source?.trim();
	if (source && source !== 'marketplace') {
		return [source];
	}
	return configuredWorkflowSources(readGlobalConfigFn);
}

function ensureRemoteWorkflowInstalled(input: {
	spec: RemoteRunSpec;
	resolveWorkflowFn: typeof resolveWorkflow;
	resolveWorkflowInstallFn: typeof resolveWorkflowInstall;
	installWorkflowFromSourceFn: typeof installWorkflowFromSource;
	readGlobalConfigFn: typeof readGlobalConfig;
}): string | undefined {
	const ref = workflowInstallRef(input.spec);
	const workflowName = workflowNameFromRef(ref);
	if (!workflowName) return undefined;

	try {
		input.resolveWorkflowFn(workflowName);
		return workflowName;
	} catch (err) {
		if (!isMissingWorkflowError(err, workflowName)) {
			throw err;
		}
	}

	const resolved: ResolvedWorkflowSource = input.resolveWorkflowInstallFn(
		ref!,
		workflowInstallSources(input.spec, input.readGlobalConfigFn),
	);
	return input.installWorkflowFromSourceFn(resolved);
}

function eventKind(event: JsonExecEvent): string {
	if (event.type === 'exec.completed') {
		const data = event.data as {success?: unknown} | null;
		return data?.success === false ? 'error' : 'completion';
	}
	return typeof event.type === 'string' && event.type.length > 0
		? event.type
		: 'progress';
}

function eventPayload(event: JsonExecEvent): unknown {
	if (event.type === 'exec.completed') {
		const data = event.data as {success?: unknown; failure?: unknown} | null;
		if (data?.success === false) {
			return {
				...(typeof event.data === 'object' && event.data !== null
					? event.data
					: {}),
				message:
					typeof data.failure === 'object' &&
					data.failure !== null &&
					typeof (data.failure as {message?: unknown}).message === 'string'
						? (data.failure as {message: string}).message
						: 'remote execution failed',
			};
		}
	}
	return event.data ?? null;
}

function mergeRunSpecEnvIntoWorkflow(
	workflow: WorkflowConfig | undefined,
	env: Record<string, string> | undefined,
): WorkflowConfig | undefined {
	if (!env || Object.keys(env).length === 0) return workflow;
	const mergedEnv = {...(workflow?.env ?? {}), ...env};
	if (workflow) {
		return {...workflow, env: mergedEnv};
	}
	return {
		name: 'dashboard-remote',
		plugins: [],
		promptTemplate: '{input}',
		env: mergedEnv,
	};
}

export async function executeRemoteAssignment({
	assignment,
	client,
	projectDir,
	log = () => {},
	runExecFn = runExec,
	decisionInbox,
	bootstrapRuntimeConfigFn = bootstrapRuntimeConfig,
	now = Date.now,
	abortSignal,
	createRunStreamClientFn = createRunStreamClient,
	resolveWorkflowFn = resolveWorkflow,
	resolveWorkflowInstallFn = resolveWorkflowInstall,
	installWorkflowFromSourceFn = installWorkflowFromSource,
	readGlobalConfigFn = readGlobalConfig,
	uploadArtifactObjectFn,
	dashboardFeedPublisher,
	runStreamConnectTimeoutMs = 5_000,
}: ExecuteRemoteAssignmentInput): Promise<void> {
	const lastTerminalFailureMessage: {current: string | null} = {current: null};
	const deferredFailedCompletion: {current: JsonExecEvent | null} = {
		current: null,
	};

	// The assignment was already validated once at intake, so the spec is
	// guaranteed present and we consume it directly — no reparse. The raw frame
	// is retained only for orthogonal concerns (artifact-upload spec parsing).
	const {spec, runId, frame} = assignment;

	const runEventPublisher: RemoteRunEventPublisher =
		await createRemoteRunEventPublisher({
			runId,
			callbackWsUrl: spec.callbackWsUrl,
			callbackToken: spec.callbackToken,
			client,
			log,
			now,
			createRunStreamClient: createRunStreamClientFn,
			runStreamConnectTimeoutMs,
		});

	const send = (kind: string, payload: unknown, ts = now()): void => {
		if (
			kind === 'error' &&
			typeof payload === 'object' &&
			payload !== null &&
			typeof (payload as {message?: unknown}).message === 'string'
		) {
			lastTerminalFailureMessage.current = (
				payload as {message: string}
			).message;
		}
		runEventPublisher.publish(kind, payload, ts);
	};

	send('progress', {message: 'assignment received'});

	try {
		let artifactUploadSpec;
		try {
			artifactUploadSpec = parseArtifactUploadSpec(frame.runSpec);
		} catch (err) {
			send('error', {
				message: err instanceof Error ? err.message : String(err),
			});
			return;
		}

		let runtimeConfig: ReturnType<typeof bootstrapRuntimeConfig>;
		try {
			const workflowOverride = ensureRemoteWorkflowInstalled({
				spec,
				resolveWorkflowFn,
				resolveWorkflowInstallFn,
				installWorkflowFromSourceFn,
				readGlobalConfigFn,
			});
			runtimeConfig = bootstrapRuntimeConfigFn({
				projectDir,
				showSetup: false,
				isolationPreset: 'minimal',
				harnessOverride: spec.harness,
				workflowOverride,
			});
		} catch (err) {
			send('error', {
				message: err instanceof Error ? err.message : String(err),
			});
			return;
		}
		for (const warning of runtimeConfig.warnings) {
			send('warning', {message: warning});
		}

		let buffered = '';
		const stdout = {
			write(chunk: string): boolean {
				buffered += chunk;
				let newline = buffered.indexOf('\n');
				while (newline >= 0) {
					const line = buffered.slice(0, newline).trim();
					buffered = buffered.slice(newline + 1);
					if (line.length > 0) {
						try {
							const event = JSON.parse(line) as JsonExecEvent;
							const data = event.data as {success?: unknown} | null;
							if (event.type === 'exec.completed' && data?.success === false) {
								deferredFailedCompletion.current = event;
								continue;
							}
							send(eventKind(event), eventPayload(event), now());
						} catch (err) {
							send('progress', {line});
							log(
								'warn',
								`remote run emitted malformed JSONL: ${
									err instanceof Error ? err.message : String(err)
								}`,
							);
						}
					}
					newline = buffered.indexOf('\n');
				}
				return true;
			},
		};
		const stderr = {
			write(chunk: string): boolean {
				const text = chunk.trim();
				if (text.length > 0) send('stderr', {text});
				return true;
			},
		};

		try {
			const workflow = mergeRunSpecEnvIntoWorkflow(
				runtimeConfig.workflow,
				spec.env,
			);
			const result = await runExecFn({
				prompt: spec.prompt,
				projectDir,
				harness: runtimeConfig.harness,
				athenaSessionId:
					spec.athenaSessionId ?? spec.sessionId ?? `athena-${runId}`,
				adapterResumeSessionId: spec.adapterResumeSessionId,
				isolationConfig: runtimeConfig.isolationConfig,
				pluginMcpConfig: runtimeConfig.pluginMcpConfig,
				workflow,
				workflowPlan: runtimeConfig.workflowPlan,
				dashboardOrigin: 'dashboard',
				json: true,
				verbose: false,
				ephemeral: false,
				timeoutMs: spec.timeoutSec ? spec.timeoutSec * 1000 : undefined,
				signal: abortSignal,
				stdout,
				stderr,
				...(decisionInbox ? {dashboardDecisionInbox: decisionInbox} : {}),
				...(dashboardFeedPublisher ? {dashboardFeedPublisher} : {}),
				...(artifactUploadSpec
					? {
							beforeTerminalCompletion: async ({result, runId}) => {
								const artifactRunId = runId ?? assignment.runId;
								const {feedEvent} = await captureAndUploadArtifacts({
									spec: artifactUploadSpec,
									projectDir,
									runId: artifactRunId,
									result,
									now,
									...(uploadArtifactObjectFn
										? {uploadObject: uploadArtifactObjectFn}
										: {}),
								});
								return [feedEvent];
							},
						}
					: {}),
			});
			const failedCompletion = deferredFailedCompletion.current;
			if (failedCompletion) {
				const data =
					typeof failedCompletion.data === 'object' &&
					failedCompletion.data !== null
						? failedCompletion.data
						: {};
				send(
					'error',
					{
						...data,
						success: result.success,
						exitCode: result.exitCode,
						athenaSessionId: result.athenaSessionId,
						adapterSessionId: result.adapterSessionId,
						finalMessage: result.finalMessage,
						tokens: result.tokens,
						durationMs: result.durationMs,
						message:
							result.failure?.message ??
							(eventPayload(failedCompletion) as {message?: string}).message ??
							'remote execution failed',
					},
					typeof failedCompletion.ts === 'number' ? failedCompletion.ts : now(),
				);
				return;
			}
			if (
				result.failure &&
				result.failure.message !== lastTerminalFailureMessage.current
			) {
				send('error', {
					success: result.success,
					exitCode: result.exitCode,
					athenaSessionId: result.athenaSessionId,
					adapterSessionId: result.adapterSessionId,
					finalMessage: result.finalMessage,
					tokens: result.tokens,
					durationMs: result.durationMs,
					message: result.failure.message,
				});
			}
		} catch (err) {
			send('error', {
				message: err instanceof Error ? err.message : String(err),
			});
		}
	} finally {
		// Wait briefly for the server to ack the terminal frame (so `finalize`
		// fires on the dashboard) but cap at 10s — if the server is
		// unreachable we still need to release the daemon's reference.
		await runEventPublisher.close();
	}
}
