import {describe, expect, it, vi} from 'vitest';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	executeRemoteAssignment,
	validateDashboardAssignment,
	type ValidatedAssignment,
} from './remoteRunExecutor';
import type {ExecRunOptions} from '../exec/types';
import type {RunStreamClient, RunStreamFrameInput} from './runStreamClient';
import {createDashboardFeedOutbox} from './dashboardFeedPublisher';
import {createPairedFeedPublisher} from './pairedFeedPublisher';

function asValidatedAssignment(frame: {
	type: 'job_assignment';
	runId: string;
	runnerId?: string;
	runSpec?: unknown;
}): ValidatedAssignment {
	const result = validateDashboardAssignment(frame);
	if (result.kind !== 'valid') {
		throw new Error(`test frame should be valid: ${result.rejection.message}`);
	}
	return result.assignment;
}

function makeArtifactRepo(): string {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), 'athena-remote-artifacts-'),
	);
	execFileSync('git', ['init'], {cwd: dir});
	execFileSync('git', ['config', 'user.email', 'test@example.com'], {cwd: dir});
	execFileSync('git', ['config', 'user.name', 'Test'], {cwd: dir});
	fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
	execFileSync('git', ['add', 'base.txt'], {cwd: dir});
	execFileSync('git', ['commit', '-m', 'base'], {cwd: dir});
	fs.writeFileSync(path.join(dir, 'artifact.txt'), 'payload\n');
	return dir;
}

describe('validateDashboardAssignment', () => {
	it('produces a validated assignment with the parsed spec for a well-formed frame', () => {
		const result = validateDashboardAssignment({
			type: 'job_assignment',
			runId: 'run_42',
			runnerId: 'runner_7',
			runSpec: {prompt: 'say hello', sessionId: 'athena-run_42'},
		});

		expect(result).toEqual({
			kind: 'valid',
			assignment: {
				runId: 'run_42',
				runnerId: 'runner_7',
				spec: expect.objectContaining({prompt: 'say hello'}),
				frame: expect.objectContaining({runId: 'run_42'}),
			},
		});
	});

	it('defaults the runnerId to legacy when the frame omits it', () => {
		const result = validateDashboardAssignment({
			type: 'job_assignment',
			runId: 'run_42',
			runSpec: {prompt: 'say hello'},
		});

		expect(result.kind).toBe('valid');
		if (result.kind === 'valid') {
			expect(result.assignment.runnerId).toBe('legacy');
		}
	});

	it('rejects a malformed assignment with a first-class malformed_assignment rejection', () => {
		const result = validateDashboardAssignment({
			type: 'job_assignment',
			runId: 'run_42',
			runSpec: {sessionId: 'athena-run_42'},
		});

		expect(result).toEqual({
			kind: 'rejected',
			rejection: {
				reason: 'malformed_assignment',
				message: 'remote assignment missing prompt',
			},
		});
	});
});

describe('executeRemoteAssignment', () => {
	it('runs the assigned prompt and streams exec events back to the dashboard', async () => {
		const sent: unknown[] = [];
		const runExecFn = vi.fn(async (options: ExecRunOptions) => {
			options.stdout?.write(
				JSON.stringify({
					type: 'exec.started',
					ts: 100,
					data: {athenaSessionId: options.athenaSessionId},
				}) + '\n',
			);
			options.stdout?.write(
				JSON.stringify({
					type: 'exec.completed',
					ts: 101,
					data: {success: true, exitCode: 0, finalMessage: 'done'},
				}) + '\n',
			);
			return {
				success: true,
				exitCode: 0,
				athenaSessionId: options.athenaSessionId ?? null,
				adapterSessionId: null,
				finalMessage: 'done',
				tokens: {
					input: null,
					output: null,
					cacheRead: null,
					cacheWrite: null,
					total: null,
					contextSize: null,
					contextWindowSize: null,
				},
				durationMs: 1,
			};
		});

		await executeRemoteAssignment({
			assignment: asValidatedAssignment({
				type: 'job_assignment',
				runId: 'run_42',
				runSpec: {
					prompt: 'say hello',
					sessionId: 'athena-run_42',
					workflow: {ref: 'exploratory-testing@0.0.14'},
					timeoutSec: 12,
					env: {FOO: 'bar'},
				},
			}),
			client: {
				sendRunEvent: frame => sent.push(frame),
			},
			projectDir: '/tmp/project',
			runExecFn,
			bootstrapRuntimeConfigFn: () => ({
				globalConfig: {
					plugins: [],
					additionalDirectories: [],
					workflowMarketplaceSources: [],
					workflowSelections: {},
				},
				projectConfig: {
					plugins: [],
					additionalDirectories: [],
					workflowMarketplaceSources: [],
					workflowSelections: {},
				},
				harness: 'openai-codex',
				isolationConfig: {preset: 'minimal', additionalDirectories: []},
				workflowRef: 'exploratory-testing',
				workflow: undefined,
				workflowPlan: undefined,
				modelName: null,
				warnings: [],
			}),
			resolveWorkflowFn: vi.fn(() => ({
				name: 'exploratory-testing',
				plugins: [],
				promptTemplate: '{input}',
			})),
			now: () => 999,
		});

		expect(runExecFn).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: 'say hello',
				projectDir: '/tmp/project',
				athenaSessionId: 'athena-run_42',
				json: true,
				timeoutMs: 12_000,
			}),
		);
		expect(sent).toContainEqual(
			expect.objectContaining({
				runId: 'run_42',
				seq: 2,
				kind: 'exec.started',
			}),
		);
		expect(sent).toContainEqual(
			expect.objectContaining({
				runId: 'run_42',
				seq: 3,
				kind: 'completion',
				payload: expect.objectContaining({success: true}),
			}),
		);
	});

	it('passes codex runSpec harness through as the OpenAI Codex bootstrap override', async () => {
		const sent: unknown[] = [];
		const runExecFn = vi.fn(async () => ({
			success: true,
			exitCode: 0,
			athenaSessionId: 'athena-run_42',
			adapterSessionId: null,
			finalMessage: 'done',
			tokens: {
				input: null,
				output: null,
				cacheRead: null,
				cacheWrite: null,
				total: null,
				contextSize: null,
				contextWindowSize: null,
			},
			durationMs: 1,
		}));
		const bootstrapRuntimeConfigFn = vi.fn(() => ({
			globalConfig: {
				plugins: [],
				additionalDirectories: [],
				workflowMarketplaceSources: [],
				workflowSelections: {},
			},
			projectConfig: {
				plugins: [],
				additionalDirectories: [],
				workflowMarketplaceSources: [],
				workflowSelections: {},
			},
			harness: 'openai-codex' as const,
			isolationConfig: {preset: 'minimal' as const, additionalDirectories: []},
			workflowRef: undefined,
			workflow: undefined,
			workflowPlan: undefined,
			modelName: null,
			warnings: [],
		}));

		await executeRemoteAssignment({
			assignment: asValidatedAssignment({
				type: 'job_assignment',
				runId: 'run_42',
				runSpec: {
					prompt: 'say hello',
					sessionId: 'athena-run_42',
					harness: 'codex',
				},
			}),
			client: {
				sendRunEvent: frame => sent.push(frame),
			},
			projectDir: '/tmp/project',
			runExecFn,
			bootstrapRuntimeConfigFn,
			now: () => 999,
		});

		expect(bootstrapRuntimeConfigFn).toHaveBeenCalledWith(
			expect.objectContaining({
				harnessOverride: 'openai-codex',
			}),
		);
		expect(runExecFn).toHaveBeenCalledWith(
			expect.objectContaining({
				harness: 'openai-codex',
			}),
		);
	});

	it('passes dashboard continue assignments with separate Athena and adapter resume ids', async () => {
		const runExecFn = vi.fn(async (options: ExecRunOptions) => ({
			success: true,
			exitCode: 0,
			athenaSessionId: options.athenaSessionId ?? null,
			adapterSessionId: options.adapterResumeSessionId ?? null,
			finalMessage: 'done',
			tokens: {
				input: null,
				output: null,
				cacheRead: null,
				cacheWrite: null,
				total: null,
				contextSize: null,
				contextWindowSize: null,
			},
			durationMs: 1,
		}));

		await executeRemoteAssignment({
			assignment: asValidatedAssignment({
				type: 'job_assignment',
				runId: 'run_continue',
				runSpec: {
					prompt: 'continue',
					athenaSessionId: 'athena-existing',
					adapterResumeSessionId: 'codex-thread-123',
				},
			}),
			client: {
				sendRunEvent: vi.fn(),
			},
			projectDir: '/tmp/project',
			runExecFn,
			bootstrapRuntimeConfigFn: () => ({
				globalConfig: {
					plugins: [],
					additionalDirectories: [],
					workflowMarketplaceSources: [],
					workflowSelections: {},
				},
				projectConfig: {
					plugins: [],
					additionalDirectories: [],
					workflowMarketplaceSources: [],
					workflowSelections: {},
				},
				harness: 'openai-codex',
				isolationConfig: {preset: 'minimal', additionalDirectories: []},
				workflowRef: undefined,
				workflow: undefined,
				workflowPlan: undefined,
				modelName: null,
				warnings: [],
			}),
		});

		expect(runExecFn).toHaveBeenCalledWith(
			expect.objectContaining({
				athenaSessionId: 'athena-existing',
				adapterResumeSessionId: 'codex-thread-123',
				dashboardOrigin: 'dashboard',
			}),
		);
	});

	it('passes runSpec env through workflow env without mutating process.env', async () => {
		const original = process.env['ATHENA_REMOTE_ENV_TEST'];
		delete process.env['ATHENA_REMOTE_ENV_TEST'];
		let processEnvSeen: string | undefined;
		const runExecFn = vi.fn(async (options: ExecRunOptions) => {
			processEnvSeen = process.env['ATHENA_REMOTE_ENV_TEST'];
			return {
				success: true,
				exitCode: 0,
				athenaSessionId: options.athenaSessionId ?? null,
				adapterSessionId: null,
				finalMessage: 'done',
				tokens: {
					input: null,
					output: null,
					cacheRead: null,
					cacheWrite: null,
					total: null,
					contextSize: null,
					contextWindowSize: null,
				},
				durationMs: 1,
			};
		});

		try {
			await executeRemoteAssignment({
				assignment: asValidatedAssignment({
					type: 'job_assignment',
					runId: 'run_env',
					runSpec: {
						prompt: 'env',
						env: {ATHENA_REMOTE_ENV_TEST: 'from-run'},
					},
				}),
				client: {sendRunEvent: vi.fn()},
				projectDir: '/tmp/project',
				runExecFn,
				bootstrapRuntimeConfigFn: () => ({
					globalConfig: {
						plugins: [],
						additionalDirectories: [],
						workflowMarketplaceSources: [],
						workflowSelections: {},
					},
					projectConfig: {
						plugins: [],
						additionalDirectories: [],
						workflowMarketplaceSources: [],
						workflowSelections: {},
					},
					harness: 'openai-codex',
					isolationConfig: {preset: 'minimal', additionalDirectories: []},
					workflowRef: undefined,
					workflow: undefined,
					workflowPlan: undefined,
					modelName: null,
					warnings: [],
				}),
			});
			expect(processEnvSeen).toBeUndefined();
			expect(runExecFn).toHaveBeenCalledWith(
				expect.objectContaining({
					workflow: expect.objectContaining({
						env: {ATHENA_REMOTE_ENV_TEST: 'from-run'},
					}),
				}),
			);
		} finally {
			if (original === undefined) {
				delete process.env['ATHENA_REMOTE_ENV_TEST'];
			} else {
				process.env['ATHENA_REMOTE_ENV_TEST'] = original;
			}
		}
	});

	it('keeps concurrent runSpec env overlays separate', async () => {
		const seen: Array<Record<string, string> | undefined> = [];
		const runExecFn = vi.fn(async (options: ExecRunOptions) => {
			seen.push(options.workflow?.env);
			await Promise.resolve();
			return {
				success: true,
				exitCode: 0,
				athenaSessionId: options.athenaSessionId ?? null,
				adapterSessionId: null,
				finalMessage: 'done',
				tokens: {
					input: null,
					output: null,
					cacheRead: null,
					cacheWrite: null,
					total: null,
					contextSize: null,
					contextWindowSize: null,
				},
				durationMs: 1,
			};
		});
		const runtimeConfig = {
			globalConfig: {
				plugins: [],
				additionalDirectories: [],
				workflowMarketplaceSources: [],
				workflowSelections: {},
			},
			projectConfig: {
				plugins: [],
				additionalDirectories: [],
				workflowMarketplaceSources: [],
				workflowSelections: {},
			},
			harness: 'openai-codex' as const,
			isolationConfig: {preset: 'minimal' as const, additionalDirectories: []},
			workflowRef: 'base',
			workflow: {
				name: 'base',
				plugins: [],
				promptTemplate: '{input}',
				env: {BASE: '1'},
			},
			workflowPlan: undefined,
			modelName: null,
			warnings: [],
		};

		await Promise.all([
			executeRemoteAssignment({
				assignment: asValidatedAssignment({
					type: 'job_assignment',
					runId: 'run_env_1',
					runSpec: {prompt: 'one', env: {RUN: 'one'}},
				}),
				client: {sendRunEvent: vi.fn()},
				projectDir: '/tmp/project',
				runExecFn,
				bootstrapRuntimeConfigFn: () => runtimeConfig,
			}),
			executeRemoteAssignment({
				assignment: asValidatedAssignment({
					type: 'job_assignment',
					runId: 'run_env_2',
					runSpec: {prompt: 'two', env: {RUN: 'two'}},
				}),
				client: {sendRunEvent: vi.fn()},
				projectDir: '/tmp/project',
				runExecFn,
				bootstrapRuntimeConfigFn: () => runtimeConfig,
			}),
		]);

		expect(seen).toEqual(
			expect.arrayContaining([
				{BASE: '1', RUN: 'one'},
				{BASE: '1', RUN: 'two'},
			]),
		);
		expect(runtimeConfig.workflow.env).toEqual({BASE: '1'});
	});

	it('passes the dashboard decision inbox to runExec', async () => {
		// A bare consume-only reader — no enqueue/close — must suffice: the
		// executor only polls + marks decisions consumed; enqueue/close stay
		// owned by the daemon.
		const decisionInbox = {
			pendingForSession: vi.fn(() => []),
			markConsumed: vi.fn(),
		};
		const runExecFn = vi.fn(async (options: ExecRunOptions) => ({
			success: true,
			exitCode: 0,
			athenaSessionId: options.athenaSessionId ?? null,
			adapterSessionId: null,
			finalMessage: 'done',
			tokens: {
				input: null,
				output: null,
				cacheRead: null,
				cacheWrite: null,
				total: null,
				contextSize: null,
				contextWindowSize: null,
			},
			durationMs: 1,
		}));

		await executeRemoteAssignment({
			assignment: asValidatedAssignment({
				type: 'job_assignment',
				runId: 'run_decisions',
				runSpec: {prompt: 'needs approval'},
			}),
			client: {sendRunEvent: vi.fn()},
			projectDir: '/tmp/project',
			runExecFn,
			decisionInbox,
			bootstrapRuntimeConfigFn: () => ({
				globalConfig: {
					plugins: [],
					additionalDirectories: [],
					workflowMarketplaceSources: [],
					workflowSelections: {},
				},
				projectConfig: {
					plugins: [],
					additionalDirectories: [],
					workflowMarketplaceSources: [],
					workflowSelections: {},
				},
				harness: 'openai-codex',
				isolationConfig: {preset: 'minimal', additionalDirectories: []},
				workflowRef: undefined,
				workflow: undefined,
				workflowPlan: undefined,
				modelName: null,
				warnings: [],
			}),
		});

		expect(runExecFn).toHaveBeenCalledWith(
			expect.objectContaining({dashboardDecisionInbox: decisionInbox}),
		);
	});

	it('installs a missing marketplace workflow from the remote run spec before bootstrapping', async () => {
		const sent: unknown[] = [];
		const runExecFn = vi.fn(async () => ({
			success: true,
			exitCode: 0,
			athenaSessionId: 'athena-run_42',
			adapterSessionId: null,
			finalMessage: 'done',
			tokens: {
				input: null,
				output: null,
				cacheRead: null,
				cacheWrite: null,
				total: null,
				contextSize: null,
				contextWindowSize: null,
			},
			durationMs: 1,
		}));
		const resolveWorkflowFn = vi.fn(() => {
			throw new Error(
				'Workflow "smoke-testing" not found. Install with: athena workflow install <source> --name smoke-testing',
			);
		});
		const resolvedSource = {
			kind: 'marketplace-remote' as const,
			slug: 'lespaceman/athena-workflow-marketplace',
			owner: 'lespaceman',
			repo: 'athena-workflow-marketplace',
			workflowName: 'smoke-testing',
			version: '0.0.16',
			ref: 'smoke-testing@lespaceman/athena-workflow-marketplace',
			manifestPath: '/tmp/marketplace/.athena-workflow/marketplace.json',
			workflowPath: '/tmp/marketplace/workflows/smoke-testing/workflow.json',
		};
		const resolveWorkflowInstallFn = vi.fn(() => resolvedSource);
		const installWorkflowFromSourceFn = vi.fn(() => 'smoke-testing');
		const bootstrapRuntimeConfigFn = vi.fn(() => ({
			globalConfig: {
				plugins: [],
				additionalDirectories: [],
				workflowMarketplaceSources: [],
				workflowSelections: {},
			},
			projectConfig: {
				plugins: [],
				additionalDirectories: [],
				workflowMarketplaceSources: [],
				workflowSelections: {},
			},
			harness: 'openai-codex' as const,
			isolationConfig: {preset: 'minimal' as const, additionalDirectories: []},
			workflowRef: 'smoke-testing',
			workflow: undefined,
			workflowPlan: undefined,
			modelName: null,
			warnings: [],
		}));

		await executeRemoteAssignment({
			assignment: asValidatedAssignment({
				type: 'job_assignment',
				runId: 'run_42',
				runSpec: {
					prompt: 'define smoke',
					workflow: {
						source: 'marketplace',
						ref: 'smoke-testing@0.0.16',
						version: '0.0.16',
					},
				},
			}),
			client: {
				sendRunEvent: frame => sent.push(frame),
			},
			projectDir: '/tmp/project',
			runExecFn,
			bootstrapRuntimeConfigFn,
			resolveWorkflowFn,
			resolveWorkflowInstallFn,
			installWorkflowFromSourceFn,
			readGlobalConfigFn: () => ({
				plugins: [],
				additionalDirectories: [],
			}),
		});

		expect(resolveWorkflowFn).toHaveBeenCalledWith('smoke-testing');
		expect(resolveWorkflowInstallFn).toHaveBeenCalledWith(
			'smoke-testing@0.0.16',
			['lespaceman/athena-workflow-marketplace'],
		);
		expect(installWorkflowFromSourceFn).toHaveBeenCalledWith(resolvedSource);
		expect(bootstrapRuntimeConfigFn).toHaveBeenCalledWith(
			expect.objectContaining({workflowOverride: 'smoke-testing'}),
		);
		expect(runExecFn).toHaveBeenCalled();
		expect(sent).toContainEqual(
			expect.objectContaining({
				runId: 'run_42',
				kind: 'progress',
				payload: {message: 'assignment received'},
			}),
		);
	});

	it('uses remote workflow source and version when installing a missing workflow', async () => {
		const runExecFn = vi.fn(async () => ({
			success: true,
			exitCode: 0,
			athenaSessionId: 'athena-run_42',
			adapterSessionId: null,
			finalMessage: 'done',
			tokens: {
				input: null,
				output: null,
				cacheRead: null,
				cacheWrite: null,
				total: null,
				contextSize: null,
				contextWindowSize: null,
			},
			durationMs: 1,
		}));
		const resolveWorkflowFn = vi.fn(() => {
			throw new Error(
				'Workflow "custom-flow" not found. Install with: athena workflow install <source> --name custom-flow',
			);
		});
		const resolveWorkflowInstallFn = vi.fn(() => ({
			kind: 'marketplace-remote' as const,
			slug: 'custom/workflows',
			owner: 'custom',
			repo: 'workflows',
			workflowName: 'custom-flow',
			version: '2.0.0',
			ref: 'custom-flow@custom/workflows',
			manifestPath: '/tmp/custom/.athena-workflow/marketplace.json',
			workflowPath: '/tmp/custom/workflows/custom-flow/workflow.json',
		}));
		const installWorkflowFromSourceFn = vi.fn(() => 'custom-flow');

		await executeRemoteAssignment({
			assignment: asValidatedAssignment({
				type: 'job_assignment',
				runId: 'run_custom',
				runSpec: {
					prompt: 'run custom',
					workflow: {
						source: 'custom/workflows',
						ref: 'custom-flow',
						version: '2.0.0',
					},
				},
			}),
			client: {
				sendRunEvent: vi.fn(),
			},
			projectDir: '/tmp/project',
			runExecFn,
			bootstrapRuntimeConfigFn: () => ({
				globalConfig: {
					plugins: [],
					additionalDirectories: [],
					workflowMarketplaceSources: [],
					workflowSelections: {},
				},
				projectConfig: {
					plugins: [],
					additionalDirectories: [],
					workflowMarketplaceSources: [],
					workflowSelections: {},
				},
				harness: 'openai-codex',
				isolationConfig: {preset: 'minimal', additionalDirectories: []},
				workflowRef: 'custom-flow',
				workflow: undefined,
				workflowPlan: undefined,
				modelName: null,
				warnings: [],
			}),
			resolveWorkflowFn,
			resolveWorkflowInstallFn,
			installWorkflowFromSourceFn,
			readGlobalConfigFn: () => ({
				plugins: [],
				additionalDirectories: [],
				workflowMarketplaceSources: ['wrong/source'],
			}),
		});

		expect(resolveWorkflowInstallFn).toHaveBeenCalledWith('custom-flow@2.0.0', [
			'custom/workflows',
		]);
		expect(installWorkflowFromSourceFn).toHaveBeenCalled();
		expect(runExecFn).toHaveBeenCalled();
	});

	it('sends a terminal error when runtime bootstrap fails', async () => {
		const sent: unknown[] = [];

		await executeRemoteAssignment({
			assignment: asValidatedAssignment({
				type: 'job_assignment',
				runId: 'run_42',
				runSpec: {prompt: 'hello'},
			}),
			client: {
				sendRunEvent: frame => sent.push(frame),
			},
			projectDir: '/tmp/project',
			bootstrapRuntimeConfigFn: () => {
				throw new Error('workflow not installed');
			},
			runExecFn: vi.fn(),
			now: () => 123,
		});

		expect(sent).toEqual([
			expect.objectContaining({
				runId: 'run_42',
				seq: 1,
				kind: 'progress',
				payload: {message: 'assignment received'},
			}),
			expect.objectContaining({
				runId: 'run_42',
				seq: 2,
				kind: 'error',
				payload: expect.objectContaining({
					message: 'workflow not installed',
				}),
			}),
		]);
	});

	it('uses the structured exec failure message when the JSON completion is generic', async () => {
		const sent: unknown[] = [];
		const runExecFn = vi.fn(async (options: ExecRunOptions) => {
			options.stdout?.write(
				JSON.stringify({
					type: 'exec.completed',
					ts: 101,
					data: {success: false, exitCode: 4, finalMessage: null},
				}) + '\n',
			);
			return {
				success: false,
				exitCode: 8,
				athenaSessionId: options.athenaSessionId ?? null,
				adapterSessionId: null,
				finalMessage: null,
				tokens: {
					input: null,
					output: null,
					cacheRead: null,
					cacheWrite: null,
					total: null,
					contextSize: null,
					contextWindowSize: null,
				},
				durationMs: 1,
				failure: {
					kind: 'workflow',
					state: 'blocked',
					message: 'Agent did not replace the tracker skeleton.',
				},
			};
		});

		await executeRemoteAssignment({
			assignment: asValidatedAssignment({
				type: 'job_assignment',
				runId: 'run_42',
				runSpec: {prompt: 'hello'},
			}),
			client: {
				sendRunEvent: frame => sent.push(frame),
			},
			projectDir: '/tmp/project',
			runExecFn,
			bootstrapRuntimeConfigFn: () => ({
				globalConfig: {
					plugins: [],
					additionalDirectories: [],
					workflowMarketplaceSources: [],
					workflowSelections: {},
				},
				projectConfig: {
					plugins: [],
					additionalDirectories: [],
					workflowMarketplaceSources: [],
					workflowSelections: {},
				},
				harness: 'openai-codex',
				isolationConfig: {preset: 'minimal', additionalDirectories: []},
				workflowRef: 'playwright-automation',
				workflow: undefined,
				workflowPlan: undefined,
				modelName: null,
				warnings: [],
			}),
		});

		expect(sent).toContainEqual(
			expect.objectContaining({
				runId: 'run_42',
				kind: 'error',
				payload: expect.objectContaining({
					message: 'Agent did not replace the tracker skeleton.',
				}),
			}),
		);
		expect(
			sent.filter(
				frame =>
					typeof frame === 'object' &&
					frame !== null &&
					(frame as {kind?: unknown}).kind === 'error',
			),
		).toHaveLength(1);
	});

	it('sends a terminal error when exec throws before emitting completion', async () => {
		const sent: unknown[] = [];

		await executeRemoteAssignment({
			assignment: asValidatedAssignment({
				type: 'job_assignment',
				runId: 'run_42',
				runSpec: {prompt: 'hello'},
			}),
			client: {
				sendRunEvent: frame => sent.push(frame),
			},
			projectDir: '/tmp/project',
			runExecFn: vi.fn(async () => {
				throw new Error('exec crashed');
			}),
			bootstrapRuntimeConfigFn: () => ({
				globalConfig: {
					plugins: [],
					additionalDirectories: [],
					workflowMarketplaceSources: [],
					workflowSelections: {},
				},
				projectConfig: {
					plugins: [],
					additionalDirectories: [],
					workflowMarketplaceSources: [],
					workflowSelections: {},
				},
				harness: 'openai-codex',
				isolationConfig: {preset: 'minimal', additionalDirectories: []},
				workflowRef: undefined,
				workflow: undefined,
				workflowPlan: undefined,
				modelName: null,
				warnings: [],
			}),
		});

		expect(sent).toContainEqual(
			expect.objectContaining({
				runId: 'run_42',
				kind: 'error',
				payload: expect.objectContaining({
					message: 'exec crashed',
				}),
			}),
		);
	});

	// Regression for the dashboard-relay bug: when runSpec includes
	// callbackWsUrl + callbackToken, executor must route every frame through
	// the per-run RunStreamClient. The legacy instance-socket path silently
	// dropped frames during WS reconnects; the per-run channel queues them
	// and replays after resume. This test only verifies routing — the
	// resilience semantics are covered in runStreamClient.test.ts.
	describe('per-run RunStreamDO channel', () => {
		function makeStubRunStreamClient(): {
			client: RunStreamClient;
			sent: Array<RunStreamFrameInput & {seq: number}>;
			connectCalls: number;
			closed: boolean;
		} {
			const sent: Array<RunStreamFrameInput & {seq: number}> = [];
			let nextSeq = 1;
			let connectCalls = 0;
			let closed = false;
			const client: RunStreamClient = {
				connect: () => {
					connectCalls += 1;
					return Promise.resolve();
				},
				sendEvent: input => {
					const seq = nextSeq++;
					sent.push({...input, seq});
					return seq;
				},
				whenTerminated: () => Promise.resolve(),
				close: async () => {
					closed = true;
				},
			};
			return {
				client,
				sent,
				get connectCalls() {
					return connectCalls;
				},
				get closed() {
					return closed;
				},
			};
		}

		it('routes all frames through the per-run client when callback creds are present', async () => {
			const stub = makeStubRunStreamClient();
			const sentToInstanceSocket: unknown[] = [];
			const runExecFn = vi.fn(async (options: ExecRunOptions) => {
				options.stdout?.write(
					JSON.stringify({
						type: 'exec.started',
						ts: 100,
						data: {athenaSessionId: options.athenaSessionId},
					}) + '\n',
				);
				options.stdout?.write(
					JSON.stringify({
						type: 'runtime.event',
						ts: 101,
						data: {kind: 'tool_call'},
					}) + '\n',
				);
				options.stdout?.write(
					JSON.stringify({
						type: 'exec.completed',
						ts: 102,
						data: {success: true, exitCode: 0, finalMessage: 'done'},
					}) + '\n',
				);
				return {
					success: true,
					exitCode: 0,
					athenaSessionId: options.athenaSessionId ?? null,
					adapterSessionId: null,
					finalMessage: 'done',
					tokens: {
						input: null,
						output: null,
						cacheRead: null,
						cacheWrite: null,
						total: null,
						contextSize: null,
						contextWindowSize: null,
					},
					durationMs: 1,
				};
			});

			await executeRemoteAssignment({
				assignment: asValidatedAssignment({
					type: 'job_assignment',
					runId: 'run_callback',
					runSpec: {
						prompt: 'go',
						sessionId: 'athena-run_callback',
						callbackWsUrl:
							'wss://dash.example/api/runs/run_callback/stream?token=t',
						callbackToken: 't',
					},
				}),
				client: {
					sendRunEvent: frame => sentToInstanceSocket.push(frame),
				},
				projectDir: '/tmp/project',
				runExecFn,
				bootstrapRuntimeConfigFn: () => ({
					globalConfig: {
						plugins: [],
						additionalDirectories: [],
						workflowMarketplaceSources: [],
						workflowSelections: {},
					},
					projectConfig: {
						plugins: [],
						additionalDirectories: [],
						workflowMarketplaceSources: [],
						workflowSelections: {},
					},
					harness: 'openai-codex',
					isolationConfig: {preset: 'minimal', additionalDirectories: []},
					workflowRef: undefined,
					workflow: undefined,
					workflowPlan: undefined,
					modelName: null,
					warnings: [],
				}),
				now: () => 999,
				createRunStreamClientFn: () => stub.client,
			});

			expect(stub.connectCalls).toBe(1);
			expect(stub.closed).toBe(true);
			// Instance-socket relay must NOT receive any run_event frames.
			expect(sentToInstanceSocket).toEqual([]);

			const kinds = stub.sent.map(f => f.kind);
			expect(kinds).toEqual([
				'progress',
				'exec.started',
				'runtime.event',
				'completion',
			]);
			// Sequence numbers come from the per-run client and must be
			// monotonic — RunStreamDO enforces this server-side.
			expect(stub.sent.map(f => f.seq)).toEqual([1, 2, 3, 4]);
		});

		it('falls back to instance socket when per-run connect times out', async () => {
			const sentToInstanceSocket: Array<{kind: string; seq: number}> = [];
			let connectStarted = false;
			let closed = false;
			const stub: RunStreamClient = {
				connect: () => {
					connectStarted = true;
					// Never resolves — simulate a hung connect.
					return new Promise<void>(() => {});
				},
				sendEvent: () => {
					throw new Error('per-run channel should not have been used');
				},
				whenTerminated: () => Promise.resolve(),
				close: async () => {
					closed = true;
				},
			};

			await executeRemoteAssignment({
				assignment: asValidatedAssignment({
					type: 'job_assignment',
					runId: 'run_fallback',
					runSpec: {
						prompt: 'go',
						callbackWsUrl:
							'wss://dash.example/api/runs/run_fallback/stream?token=t',
						callbackToken: 't',
					},
				}),
				client: {
					sendRunEvent: frame =>
						sentToInstanceSocket.push({kind: frame.kind, seq: frame.seq}),
				},
				projectDir: '/tmp/project',
				runExecFn: vi.fn(async () => ({
					success: true,
					exitCode: 0,
					athenaSessionId: null,
					adapterSessionId: null,
					finalMessage: 'ok',
					tokens: {
						input: null,
						output: null,
						cacheRead: null,
						cacheWrite: null,
						total: null,
						contextSize: null,
						contextWindowSize: null,
					},
					durationMs: 1,
				})),
				bootstrapRuntimeConfigFn: () => ({
					globalConfig: {
						plugins: [],
						additionalDirectories: [],
						workflowMarketplaceSources: [],
						workflowSelections: {},
					},
					projectConfig: {
						plugins: [],
						additionalDirectories: [],
						workflowMarketplaceSources: [],
						workflowSelections: {},
					},
					harness: 'openai-codex',
					isolationConfig: {preset: 'minimal', additionalDirectories: []},
					workflowRef: undefined,
					workflow: undefined,
					workflowPlan: undefined,
					modelName: null,
					warnings: [],
				}),
				createRunStreamClientFn: () => stub,
				runStreamConnectTimeoutMs: 25,
			});

			expect(connectStarted).toBe(true);
			expect(closed).toBe(true); // we proactively close the timed-out attempt
			// Fallback path: legacy seq numbering (1-based, increments on each
			// call), routed via the instance socket.
			expect(sentToInstanceSocket[0]).toEqual({kind: 'progress', seq: 1});
			expect(sentToInstanceSocket.length).toBeGreaterThan(0);
		});
	});

	it('captures and publishes artifact manifests before exec completion', async () => {
		const projectDir = makeArtifactRepo();
		const uploaded: string[] = [];
		const sent: Array<{kind: string; payload?: unknown}> = [];
		let hookFeedEvents: unknown;
		const runExecFn = vi.fn(async (options: ExecRunOptions) => {
			const result = {
				success: true,
				exitCode: 0 as const,
				athenaSessionId: options.athenaSessionId ?? null,
				adapterSessionId: 'adapter-1',
				finalMessage: 'done',
				tokens: {
					input: null,
					output: null,
					cacheRead: null,
					cacheWrite: null,
					total: null,
					contextSize: null,
					contextWindowSize: null,
				},
				durationMs: 1,
			};
			hookFeedEvents = await options.beforeTerminalCompletion?.({
				result,
				runId: 'local-run-1',
			});
			options.stdout?.write(
				JSON.stringify({
					type: 'exec.completed',
					data: result,
				}) + '\n',
			);
			return result;
		});

		await executeRemoteAssignment({
			assignment: asValidatedAssignment({
				type: 'job_assignment',
				runId: 'run_artifacts',
				runSpec: {
					prompt: 'hello',
					sessionId: 'athena-artifacts',
					artifactUpload: {
						bucket: 'bucket-1',
						prefix: 'runs/run_artifacts',
						accessToken: 'token',
					},
				},
			}),
			client: {
				sendRunEvent: frame => sent.push(frame),
			},
			projectDir,
			runExecFn,
			bootstrapRuntimeConfigFn: () => ({
				globalConfig: {
					plugins: [],
					additionalDirectories: [],
					workflowMarketplaceSources: [],
					workflowSelections: {},
				},
				projectConfig: {
					plugins: [],
					additionalDirectories: [],
					workflowMarketplaceSources: [],
					workflowSelections: {},
				},
				harness: 'openai-codex',
				isolationConfig: {preset: 'minimal', additionalDirectories: []},
				workflowRef: undefined,
				workflow: undefined,
				workflowPlan: undefined,
				modelName: null,
				warnings: [],
			}),
			now: () => 1_700_000_000_000,
			uploadArtifactObjectFn: async input => {
				uploaded.push(input.objectName);
			},
		});

		expect(uploaded).toEqual([
			expect.stringMatching(/^runs\/run_artifacts\/payloads\//),
			'runs/run_artifacts/manifest.json',
		]);
		expect(sent.at(-1)).toEqual(
			expect.objectContaining({
				kind: 'completion',
				payload: expect.objectContaining({success: true}),
			}),
		);
		expect(runExecFn).toHaveBeenCalledWith(
			expect.objectContaining({
				beforeTerminalCompletion: expect.any(Function),
			}),
		);
		expect(hookFeedEvents).toEqual([
			expect.objectContaining({
				kind: 'artifacts.manifest',
				data: expect.objectContaining({
					manifest: expect.objectContaining({
						objects: expect.objectContaining({
							manifest: 'runs/run_artifacts/manifest.json',
						}),
					}),
				}),
			}),
		]);
	});

	it('persists remote artifact manifest feed events through the paired feed outbox', async () => {
		const projectDir = makeArtifactRepo();
		const outbox = createDashboardFeedOutbox({
			dbPath: path.join(
				fs.mkdtempSync(path.join(os.tmpdir(), 'athena-feed-outbox-')),
				'outbox.db',
			),
		});
		const dashboardFeedPublisher = createPairedFeedPublisher({
			readConfig: () => ({
				dashboardUrl: 'https://dashboard.test',
				instanceId: 'inst-1',
				refreshToken: 'refresh',
				fingerprint: 'fp',
				pairedAt: 1,
			}),
			outbox,
			now: () => 1_700_000_000_000,
		});
		const runExecFn = vi.fn(async (options: ExecRunOptions) => {
			const result = {
				success: true,
				exitCode: 0 as const,
				athenaSessionId: options.athenaSessionId ?? null,
				adapterSessionId: 'adapter-1',
				finalMessage: 'done',
				tokens: {
					input: null,
					output: null,
					cacheRead: null,
					cacheWrite: null,
					total: null,
					contextSize: null,
					contextWindowSize: null,
				},
				durationMs: 1,
			};
			const feedEvents = await options.beforeTerminalCompletion?.({
				result,
				runId: 'local-run-1',
			});
			if (feedEvents) {
				options.dashboardFeedPublisher?.publish({
					origin: options.dashboardOrigin ?? 'local',
					athenaSessionId: options.athenaSessionId ?? 'athena-missing',
					feedEvents,
				});
			}
			return result;
		});

		await executeRemoteAssignment({
			assignment: asValidatedAssignment({
				type: 'job_assignment',
				runId: 'run_artifacts_feed',
				runSpec: {
					prompt: 'hello',
					sessionId: 'athena-artifacts-feed',
					artifactUpload: {
						bucket: 'bucket-1',
						prefix: 'runs/run_artifacts_feed',
						accessToken: 'token',
					},
				},
			}),
			client: {
				sendRunEvent: vi.fn(),
			},
			projectDir,
			runExecFn,
			dashboardFeedPublisher,
			bootstrapRuntimeConfigFn: () => ({
				globalConfig: {
					plugins: [],
					additionalDirectories: [],
					workflowMarketplaceSources: [],
					workflowSelections: {},
				},
				projectConfig: {
					plugins: [],
					additionalDirectories: [],
					workflowMarketplaceSources: [],
					workflowSelections: {},
				},
				harness: 'openai-codex',
				isolationConfig: {preset: 'minimal', additionalDirectories: []},
				workflowRef: undefined,
				workflow: undefined,
				workflowPlan: undefined,
				modelName: null,
				warnings: [],
			}),
			now: () => 1_700_000_000_000,
			uploadArtifactObjectFn: vi.fn(async () => {}),
		});

		const pending = outbox.pendingBatch({limit: 10, now: 1_700_000_000_000});
		expect(pending).toHaveLength(1);
		expect(pending[0]!.envelope).toMatchObject({
			instanceId: 'inst-1',
			athenaSessionId: 'athena-artifacts-feed',
			origin: 'dashboard',
			feedEvent: expect.objectContaining({
				kind: 'artifacts.manifest',
			}),
		});
		dashboardFeedPublisher.close();
		outbox.close();
	});

	it('reports malformed artifact upload specs as terminal assignment errors', async () => {
		const sent: Array<{kind: string; payload?: unknown}> = [];
		const runExecFn = vi.fn(async () => ({
			success: true,
			exitCode: 0 as const,
			athenaSessionId: 'athena-bad-artifacts',
			adapterSessionId: null,
			finalMessage: 'done',
			tokens: {
				input: null,
				output: null,
				cacheRead: null,
				cacheWrite: null,
				total: null,
				contextSize: null,
				contextWindowSize: null,
			},
			durationMs: 1,
		}));

		await executeRemoteAssignment({
			assignment: asValidatedAssignment({
				type: 'job_assignment',
				runId: 'run_bad_artifacts',
				runSpec: {
					prompt: 'hello',
					artifactUpload: {
						bucket: 'bucket-1',
					},
				},
			}),
			client: {
				sendRunEvent: frame => sent.push(frame),
			},
			projectDir: '/tmp/project',
			runExecFn,
			bootstrapRuntimeConfigFn: () => ({
				globalConfig: {
					plugins: [],
					additionalDirectories: [],
					workflowMarketplaceSources: [],
					workflowSelections: {},
				},
				projectConfig: {
					plugins: [],
					additionalDirectories: [],
					workflowMarketplaceSources: [],
					workflowSelections: {},
				},
				harness: 'openai-codex',
				isolationConfig: {preset: 'minimal', additionalDirectories: []},
				workflowRef: undefined,
				workflow: undefined,
				workflowPlan: undefined,
				modelName: null,
				warnings: [],
			}),
		});

		expect(runExecFn).not.toHaveBeenCalled();
		expect(sent.at(-1)).toEqual(
			expect.objectContaining({
				kind: 'error',
				payload: expect.objectContaining({
					message: expect.stringMatching(/artifact upload spec/i),
				}),
			}),
		);
	});

	it('passes cancellation through to exec and reports a terminal error', async () => {
		const sent: unknown[] = [];
		const controller = new AbortController();
		let resolveExec: (value: ExecRunOptions) => void = () => {};
		const execOptions = new Promise<ExecRunOptions>(resolve => {
			resolveExec = resolve;
		});
		const runExecFn = vi.fn(async (options: ExecRunOptions) => {
			resolveExec(options);
			await new Promise<void>(resolve => {
				options.signal?.addEventListener('abort', () => resolve(), {
					once: true,
				});
			});
			return {
				success: false,
				exitCode: 4,
				athenaSessionId: options.athenaSessionId ?? null,
				adapterSessionId: null,
				finalMessage: null,
				tokens: {
					input: null,
					output: null,
					cacheRead: null,
					cacheWrite: null,
					total: null,
					contextSize: null,
					contextWindowSize: null,
				},
				durationMs: 1,
				failure: {
					kind: 'process',
					message: 'Execution cancelled.',
				},
			};
		});

		const pending = executeRemoteAssignment({
			assignment: asValidatedAssignment({
				type: 'job_assignment',
				runId: 'run_cancel',
				runSpec: {prompt: 'hello'},
			}),
			client: {
				sendRunEvent: frame => sent.push(frame),
			},
			projectDir: '/tmp/project',
			runExecFn,
			bootstrapRuntimeConfigFn: () => ({
				globalConfig: {
					plugins: [],
					additionalDirectories: [],
					workflowMarketplaceSources: [],
					workflowSelections: {},
				},
				projectConfig: {
					plugins: [],
					additionalDirectories: [],
					workflowMarketplaceSources: [],
					workflowSelections: {},
				},
				harness: 'openai-codex',
				isolationConfig: {preset: 'minimal', additionalDirectories: []},
				workflowRef: undefined,
				workflow: undefined,
				workflowPlan: undefined,
				modelName: null,
				warnings: [],
			}),
			abortSignal: controller.signal,
		});

		const options = await execOptions;
		expect(options.signal).toBe(controller.signal);
		controller.abort();
		await pending;

		expect(sent).toContainEqual(
			expect.objectContaining({
				runId: 'run_cancel',
				kind: 'error',
				payload: expect.objectContaining({
					message: 'Execution cancelled.',
				}),
			}),
		);
	});
});
