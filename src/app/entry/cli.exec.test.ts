import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const renderMock = vi.fn();
const runExecMock = vi.fn();
const runDashboardMock = vi.fn();
const bootstrapRuntimeConfigMock = vi.fn();
const readConfigMock = vi.fn();
const readGlobalConfigMock = vi.fn();
const writeGlobalConfigMock = vi.fn();
const getMostRecentAthenaSessionMock = vi.fn();
const getSessionMetaMock = vi.fn();
const shouldShowSetupMock = vi.fn();
const resolveThemeMock = vi.fn(() => ({name: 'dark'}));
const initTelemetryMock = vi.fn();
const shutdownTelemetryMock = vi.fn().mockResolvedValue(undefined);
const generateDeviceIdMock = vi.fn(() => 'generated-device-id');
const trackAppLaunchedMock = vi.fn();
const trackErrorMock = vi.fn();
const trackTelemetryOptedOutMock = vi.fn();
const resolveWorkflowInstallMock = vi.fn((source: string) => ({
	kind: 'filesystem' as const,
	workflowPath: source,
}));

const RUN_EXIT_CODE = {
	SUCCESS: 0,
	USAGE: 2,
	BOOTSTRAP: 3,
	RUNTIME: 4,
	TIMEOUT: 6,
	OUTPUT: 7,
} as const;

vi.mock('ink', () => ({
	render: renderMock,
}));

vi.mock('../shell/AppShell', () => ({
	default: () => null,
}));

vi.mock('../../setup/steps/WorkflowInstallWizard', () => ({
	default: () => null,
}));

vi.mock('../commands/builtins/index', () => ({
	registerBuiltins: vi.fn(),
}));

vi.mock('../../infra/plugins/index', () => ({
	readConfig: readConfigMock,
	readGlobalConfig: readGlobalConfigMock,
	resolveActiveWorkflow: ({
		override,
		projectConfig,
		globalConfig,
	}: {
		override?: string;
		projectConfig: {activeWorkflow?: string};
		globalConfig: {activeWorkflow?: string};
	}) => {
		if (override !== undefined) return {name: override, source: 'override'};
		if (projectConfig.activeWorkflow !== undefined)
			return {name: projectConfig.activeWorkflow, source: 'project'};
		if (globalConfig.activeWorkflow !== undefined)
			return {name: globalConfig.activeWorkflow, source: 'global'};
		return {name: 'default', source: 'default'};
	},
}));

vi.mock('../../infra/plugins/config', () => ({
	writeGlobalConfig: writeGlobalConfigMock,
}));

vi.mock('../bootstrap/bootstrapConfig', () => ({
	bootstrapRuntimeConfig: bootstrapRuntimeConfigMock,
}));

vi.mock('../../infra/sessions/index', () => ({
	getMostRecentAthenaSession: getMostRecentAthenaSessionMock,
	getSessionMeta: getSessionMetaMock,
	getLatestRunForSession: () => null,
	listAwaitingAttentionRuns: () => [],
}));

vi.mock('../../setup/shouldShowSetup', () => ({
	shouldShowSetup: shouldShowSetupMock,
}));

vi.mock('./dashboardCommand', () => ({
	runDashboardCommand: runDashboardMock,
}));

vi.mock('../exec', () => ({
	runExec: runExecMock,
	RUN_EXIT_CODE,
}));

vi.mock('../../ui/theme/index', () => ({
	resolveTheme: resolveThemeMock,
}));

vi.mock('../../infra/plugins/marketplace', () => ({
	resolveWorkflowInstall: (...args: unknown[]) =>
		resolveWorkflowInstallMock(...args),
}));

vi.mock('../../infra/telemetry/index', () => ({
	initTelemetry: initTelemetryMock,
	shutdownTelemetry: shutdownTelemetryMock,
	generateDeviceId: generateDeviceIdMock,
	trackAppLaunched: trackAppLaunchedMock,
	trackError: trackErrorMock,
	trackTelemetryOptedOut: trackTelemetryOptedOutMock,
}));

vi.mock('../../shared/utils/processRegistry', () => ({
	processRegistry: {
		registerCleanupHandlers: vi.fn(),
	},
}));

vi.mock('../../harnesses/registry', () => ({
	listHarnessAdapters: () => [
		{id: 'claude-code', label: 'Claude Code', enabled: true},
		{id: 'openai-codex', label: 'OpenAI Codex', enabled: true},
		{id: 'opencode', label: 'OpenCode', enabled: false},
	],
}));

type CliRunResult = {
	exitSpy: ReturnType<typeof vi.spyOn>;
	errorSpy: ReturnType<typeof vi.spyOn>;
	logSpy: ReturnType<typeof vi.spyOn>;
	restore: () => void;
};

const BASE_CONFIG = {
	plugins: [] as string[],
	additionalDirectories: [] as string[],
	setupComplete: true,
	deviceId: 'device-id-1',
};

const BASE_RUNTIME_BOOTSTRAP = {
	globalConfig: BASE_CONFIG,
	projectConfig: BASE_CONFIG,
	harness: 'claude-code' as const,
	isolationConfig: {preset: 'guarded' as const, pluginDirs: []},
	pluginMcpConfig: undefined,
	workflowRef: undefined,
	workflow: undefined,
	workflowPlan: undefined,
	modelName: null,
	personalMcpServers: [] as Array<Record<string, unknown>>,
	personalSkills: [] as Array<Record<string, unknown>>,
	capabilityConflicts: {
		mcpServers: [] as Array<Record<string, unknown>>,
		skills: [] as Array<Record<string, unknown>>,
	},
	warnings: [] as string[],
};

async function runCli(args: string[]): Promise<CliRunResult> {
	vi.resetModules();
	const previousArgv = process.argv;
	process.argv = ['node', 'athena-flow', ...args];

	const exitSpy = vi
		.spyOn(process, 'exit')
		.mockImplementation((() => undefined) as never);
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

	await import('./cli.tsx');
	await new Promise(resolve => setImmediate(resolve));

	return {
		exitSpy,
		errorSpy,
		logSpy,
		restore: () => {
			process.argv = previousArgv;
			exitSpy.mockRestore();
			errorSpy.mockRestore();
			logSpy.mockRestore();
		},
	};
}

describe('cli exec mode', () => {
	beforeEach(() => {
		renderMock.mockReset();
		renderMock.mockReturnValue({
			waitUntilExit: vi.fn().mockResolvedValue(undefined),
		});
		runExecMock.mockReset();
		bootstrapRuntimeConfigMock.mockReset();
		readConfigMock.mockReset();
		readGlobalConfigMock.mockReset();
		writeGlobalConfigMock.mockReset();
		getMostRecentAthenaSessionMock.mockReset();
		getSessionMetaMock.mockReset();
		shouldShowSetupMock.mockReset();
		resolveThemeMock.mockReset();
		initTelemetryMock.mockReset();
		shutdownTelemetryMock.mockClear();
		generateDeviceIdMock.mockClear();
		trackAppLaunchedMock.mockReset();
		trackErrorMock.mockReset();
		trackTelemetryOptedOutMock.mockReset();
		resolveWorkflowInstallMock.mockReset();
		resolveWorkflowInstallMock.mockImplementation((source: string) => ({
			kind: 'filesystem' as const,
			workflowPath: source,
		}));

		readConfigMock.mockReturnValue(BASE_CONFIG);
		readGlobalConfigMock.mockReturnValue(BASE_CONFIG);
		bootstrapRuntimeConfigMock.mockReturnValue(BASE_RUNTIME_BOOTSTRAP);
		resolveThemeMock.mockReturnValue({name: 'dark'});
		runExecMock.mockResolvedValue({exitCode: RUN_EXIT_CODE.SUCCESS});
		runDashboardMock.mockReset();
		runDashboardMock.mockResolvedValue(0);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('dispatches exec command to runExec and bypasses Ink render', async () => {
		const cli = await runCli(['exec', 'hello from test']);
		try {
			expect(runExecMock).toHaveBeenCalledTimes(1);
			expect(runExecMock).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: 'hello from test',
				}),
			);
			expect(renderMock).not.toHaveBeenCalled();
			expect(cli.exitSpy).toHaveBeenCalledWith(RUN_EXIT_CODE.SUCCESS);
			expect(bootstrapRuntimeConfigMock).toHaveBeenCalledWith(
				expect.objectContaining({
					showSetup: false,
				}),
			);
			expect(shouldShowSetupMock).not.toHaveBeenCalled();
		} finally {
			cli.restore();
		}
	});

	it('keeps top-level help focused on supported user-facing commands', async () => {
		const cli = await runCli(['--help']);
		try {
			const help = cli.logSpy.mock.calls
				.map(call => String(call[0]))
				.join('\n');

			expect(help).toContain('dashboard <sub>');
			expect(help).toContain('exec "<prompt>"');
			// One door into drisp (#183): no second runner, no channel surface.
			expect(help).not.toContain('gateway');
			expect(help).not.toContain('Gateway');
			expect(help).not.toContain('channel');
			expect(help).not.toContain('telegram');
			expect(help).not.toContain('--bot-token');
			expect(help).not.toContain('--user-id');
			expect(help).not.toContain('--chat-id');
			expect(help).not.toContain('--token');
			expect(help).not.toContain('--tls-ca');
			expect(help).not.toContain('--tls-cert');
			expect(help).not.toContain('--tls-key');
			expect(help).not.toContain('--bind');
			expect(help).not.toContain('--insecure');
			expect(help).not.toContain('--grace-period-ms');
			expect(help).not.toContain('connect');
		} finally {
			cli.restore();
		}
	});

	it('fails fast when exec prompt is missing', async () => {
		const cli = await runCli(['exec']);
		try {
			expect(runExecMock).not.toHaveBeenCalled();
			expect(bootstrapRuntimeConfigMock).not.toHaveBeenCalled();
			expect(cli.exitSpy).toHaveBeenCalledWith(RUN_EXIT_CODE.USAGE);
		} finally {
			cli.restore();
		}
	});

	it('rejects --ephemeral with --continue', async () => {
		const cli = await runCli(['exec', 'hello', '--ephemeral', '--continue']);
		try {
			expect(runExecMock).not.toHaveBeenCalled();
			expect(cli.exitSpy).toHaveBeenCalledWith(RUN_EXIT_CODE.USAGE);
		} finally {
			cli.restore();
		}
	});

	it('rejects the removed channel and gateway commands as unknown', async () => {
		for (const command of ['channel', 'gateway']) {
			const cli = await runCli([command, 'status']);
			try {
				expect(runExecMock).not.toHaveBeenCalled();
				expect(renderMock).not.toHaveBeenCalled();
				expect(cli.exitSpy).toHaveBeenCalledWith(1);
				const stderr = cli.errorSpy.mock.calls
					.map(call => String(call[0]))
					.join('\n');
				expect(stderr).toContain(`Unknown command: ${command}`);
			} finally {
				cli.restore();
			}
		}
	});

	it('resolves bare --continue to most recent session', async () => {
		getMostRecentAthenaSessionMock.mockReturnValue({
			id: 'athena-1',
			adapterSessionIds: ['adapter-1', 'adapter-2'],
		});

		const cli = await runCli(['exec', 'hello', '--continue']);
		try {
			expect(runExecMock).toHaveBeenCalledWith(
				expect.objectContaining({
					athenaSessionId: 'athena-1',
					adapterResumeSessionId: 'adapter-2',
				}),
			);
			expect(cli.exitSpy).toHaveBeenCalledWith(RUN_EXIT_CODE.SUCCESS);
		} finally {
			cli.restore();
		}
	});

	it('fails when explicit --continue session id is unknown', async () => {
		getSessionMetaMock.mockReturnValue(null);

		const cli = await runCli(['exec', 'hello', '--continue=missing']);
		try {
			expect(runExecMock).not.toHaveBeenCalled();
			expect(cli.exitSpy).toHaveBeenCalledWith(RUN_EXIT_CODE.RUNTIME);
		} finally {
			cli.restore();
		}
	});

	it('keeps interactive mode path unchanged', async () => {
		const cli = await runCli([]);
		try {
			expect(runExecMock).not.toHaveBeenCalled();
			expect(renderMock).toHaveBeenCalledTimes(1);
			expect(renderMock.mock.calls[0]?.[1]).not.toHaveProperty(
				'incrementalRendering',
			);
			expect(cli.exitSpy).not.toHaveBeenCalled();
			expect(shouldShowSetupMock).toHaveBeenCalled();
		} finally {
			cli.restore();
		}
	});

	it('suppresses the first-run telemetry notice in exec mode', async () => {
		readGlobalConfigMock.mockReturnValue({
			...BASE_CONFIG,
			deviceId: undefined,
		});

		const cli = await runCli(['exec', 'hello from test', '--json']);
		try {
			expect(writeGlobalConfigMock).toHaveBeenCalledWith({
				deviceId: 'generated-device-id',
			});
			expect(cli.logSpy).not.toHaveBeenCalledWith(
				expect.stringContaining('Athena collects anonymous usage data'),
			);
			expect(cli.exitSpy).toHaveBeenCalledWith(RUN_EXIT_CODE.SUCCESS);
		} finally {
			cli.restore();
		}
	});

	it('tracks telemetry opt-out for the CLI disable command', async () => {
		readGlobalConfigMock.mockReturnValue({
			...BASE_CONFIG,
			telemetry: true,
		});

		const cli = await runCli(['telemetry', 'disable']);
		try {
			expect(initTelemetryMock).toHaveBeenCalledWith(
				expect.objectContaining({
					deviceId: 'device-id-1',
					telemetryEnabled: true,
				}),
			);
			expect(trackTelemetryOptedOutMock).toHaveBeenCalledTimes(1);
			expect(shutdownTelemetryMock).toHaveBeenCalled();
			expect(writeGlobalConfigMock).toHaveBeenCalledWith({telemetry: false});
		} finally {
			cli.restore();
		}
	});

	it('uses exec-specific bootstrap exit code in exec mode', async () => {
		bootstrapRuntimeConfigMock.mockImplementation(() => {
			throw new Error('bootstrap failed');
		});

		const cli = await runCli(['exec', 'hello']);
		try {
			expect(runExecMock).not.toHaveBeenCalled();
			expect(renderMock).not.toHaveBeenCalled();
			expect(cli.exitSpy).toHaveBeenCalledWith(RUN_EXIT_CODE.BOOTSTRAP);
		} finally {
			cli.restore();
		}
	});

	it('preserves interactive bootstrap failure exit code', async () => {
		bootstrapRuntimeConfigMock.mockImplementation(() => {
			throw new Error('bootstrap failed');
		});

		const cli = await runCli([]);
		try {
			expect(runExecMock).not.toHaveBeenCalled();
			expect(renderMock).not.toHaveBeenCalled();
			expect(cli.exitSpy).toHaveBeenCalledWith(1);
		} finally {
			cli.restore();
		}
	});

	it('passes --harness override to bootstrapRuntimeConfig', async () => {
		const cli = await runCli(['exec', 'hello', '--harness=openai-codex']);
		try {
			expect(bootstrapRuntimeConfigMock).toHaveBeenCalledWith(
				expect.objectContaining({
					harnessOverride: 'openai-codex',
				}),
			);
			expect(cli.exitSpy).toHaveBeenCalledWith(RUN_EXIT_CODE.SUCCESS);
		} finally {
			cli.restore();
		}
	});

	describe('run is the command; exec is its deprecated alias (#185)', () => {
		// Every field of the runExec call except the freshly minted session id.
		function lastExecCall(): Record<string, unknown> {
			const {athenaSessionId, ...rest} = runExecMock.mock.calls.at(-1)![0];
			expect(athenaSessionId).toEqual(expect.any(String));
			return rest;
		}

		it('dispatches run to runExec exactly like exec', async () => {
			const viaRun = await runCli(['run', 'hello from test', '--json']);
			let runCall: Record<string, unknown>;
			try {
				expect(runExecMock).toHaveBeenCalledTimes(1);
				runCall = lastExecCall();
				expect(viaRun.exitSpy).toHaveBeenCalledWith(RUN_EXIT_CODE.SUCCESS);
				expect(renderMock).not.toHaveBeenCalled();
			} finally {
				viaRun.restore();
			}

			runExecMock.mockClear();
			const viaExec = await runCli(['exec', 'hello from test', '--json']);
			try {
				expect(runExecMock).toHaveBeenCalledTimes(1);
				expect(lastExecCall()).toEqual(runCall);
				expect(viaExec.exitSpy).toHaveBeenCalledWith(RUN_EXIT_CODE.SUCCESS);
			} finally {
				viaExec.restore();
			}
		});

		it('prints a one-line deprecation notice to stderr for exec, and none for run', async () => {
			const viaExec = await runCli(['exec', 'hello']);
			try {
				const notices = viaExec.errorSpy.mock.calls
					.map(call => String(call[0]))
					.filter(line => /deprecated/i.test(line));
				expect(notices).toHaveLength(1);
				expect(notices[0]).toContain('drisp exec');
				expect(notices[0]).toContain('drisp run');
				expect(notices[0]).toContain('0.7.0');
				expect(notices[0]).not.toContain('\n');
			} finally {
				viaExec.restore();
			}

			const viaRun = await runCli(['run', 'hello']);
			try {
				const notices = viaRun.errorSpy.mock.calls
					.map(call => String(call[0]))
					.filter(line => /deprecated/i.test(line));
				expect(notices).toHaveLength(0);
			} finally {
				viaRun.restore();
			}
		});

		it('fails fast with a run usage line when the prompt is missing', async () => {
			const cli = await runCli(['run']);
			try {
				expect(runExecMock).not.toHaveBeenCalled();
				expect(cli.exitSpy).toHaveBeenCalledWith(RUN_EXIT_CODE.USAGE);
				expect(cli.errorSpy).toHaveBeenCalledWith(
					expect.stringContaining('run "<prompt>"'),
				);
			} finally {
				cli.restore();
			}
		});

		it('names run, not exec, in the top-level help', async () => {
			const cli = await runCli(['--help']);
			try {
				const help = cli.logSpy.mock.calls
					.map(call => String(call[0]))
					.join('\n');
				expect(help).toContain('run "<prompt>"');
				expect(help).not.toContain('exec "<prompt>"');
				expect(help).toContain('guarded (default)');
				expect(help).not.toContain('strict (default)');
			} finally {
				cli.restore();
			}
		});
	});

	describe('isolation presets: guarded / standard / autonomous (#185)', () => {
		it.each([
			['guarded', 'guarded'],
			['standard', 'standard'],
			['autonomous', 'autonomous'],
		])(
			'resolves the new preset name %s with no notice',
			async (flag, preset) => {
				const cli = await runCli(['run', 'hello', `--isolation=${flag}`]);
				try {
					expect(bootstrapRuntimeConfigMock).toHaveBeenCalledWith(
						expect.objectContaining({isolationPreset: preset}),
					);
					expect(cli.errorSpy).not.toHaveBeenCalled();
				} finally {
					cli.restore();
				}
			},
		);

		it.each([
			['strict', 'guarded'],
			['minimal', 'standard'],
			['permissive', 'autonomous'],
		])(
			'maps the old preset %s onto %s and prints a notice to stderr',
			async (oldName, newName) => {
				const cli = await runCli(['run', 'hello', `--isolation=${oldName}`]);
				try {
					expect(bootstrapRuntimeConfigMock).toHaveBeenCalledWith(
						expect.objectContaining({isolationPreset: newName}),
					);
					const notices = cli.errorSpy.mock.calls.map(call => String(call[0]));
					expect(notices).toHaveLength(1);
					expect(notices[0]).toContain(`'${oldName}'`);
					expect(notices[0]).toContain(`'${newName}'`);
					expect(notices[0]).toContain('0.7.0');
				} finally {
					cli.restore();
				}
			},
		);

		it('falls back to guarded on an unknown preset, naming the valid ones', async () => {
			const cli = await runCli(['run', 'hello', '--isolation=bogus']);
			try {
				expect(bootstrapRuntimeConfigMock).toHaveBeenCalledWith(
					expect.objectContaining({isolationPreset: 'guarded'}),
				);
				expect(cli.errorSpy).toHaveBeenCalledWith(
					expect.stringContaining("using 'guarded'"),
				);
			} finally {
				cli.restore();
			}
		});
	});

	it('rejects invalid --harness value', async () => {
		const cli = await runCli(['exec', 'hello', '--harness=invalid']);
		try {
			expect(bootstrapRuntimeConfigMock).not.toHaveBeenCalled();
			expect(cli.exitSpy).toHaveBeenCalledWith(RUN_EXIT_CODE.USAGE);
			expect(cli.errorSpy).toHaveBeenCalledWith(
				expect.stringContaining('Invalid harness'),
			);
		} finally {
			cli.restore();
		}
	});

	it('omits harnessOverride when --harness is not provided', async () => {
		const cli = await runCli(['exec', 'hello']);
		try {
			expect(bootstrapRuntimeConfigMock).toHaveBeenCalledWith(
				expect.objectContaining({
					harnessOverride: undefined,
				}),
			);
		} finally {
			cli.restore();
		}
	});

	it('passes --workflow override into bootstrapRuntimeConfig without writing config', async () => {
		const cli = await runCli(['exec', 'hello', '--workflow=ad-hoc-workflow']);
		try {
			expect(bootstrapRuntimeConfigMock).toHaveBeenCalledWith(
				expect.objectContaining({
					workflowOverride: 'ad-hoc-workflow',
				}),
			);
			expect(writeGlobalConfigMock).not.toHaveBeenCalledWith(
				expect.objectContaining({activeWorkflow: expect.anything()}),
			);
			expect(runExecMock).toHaveBeenCalled();
		} finally {
			cli.restore();
		}
	});

	it('--dry-run prints bootstrap summary and skips runExec', async () => {
		bootstrapRuntimeConfigMock.mockReturnValue({
			...BASE_RUNTIME_BOOTSTRAP,
			isolationConfig: {preset: 'standard' as const, pluginDirs: ['/p1']},
			workflow: {name: 'pretend-workflow', version: '1.2.3'},
		});
		const cli = await runCli([
			'exec',
			'noop',
			'--workflow=pretend-workflow',
			'--dry-run',
		]);
		try {
			expect(runExecMock).not.toHaveBeenCalled();
			const printed = cli.logSpy.mock.calls.map(c => String(c[0])).join('\n');
			expect(printed).toContain('athena-flow run --dry-run');
			expect(printed).toContain('pretend-workflow [override]');
			expect(printed).toContain('isolation (final): standard');
			expect(printed).toContain('/p1');
			expect(cli.exitSpy).toHaveBeenCalledWith(0);
		} finally {
			cli.restore();
		}
	});

	it('--dry-run reports configured personal capabilities with source layers (AC2)', async () => {
		bootstrapRuntimeConfigMock.mockReturnValue({
			...BASE_RUNTIME_BOOTSTRAP,
			personalMcpServers: [
				{
					name: 'fs',
					command: 'npx',
					args: ['-y', 'server'],
					env: {API_KEY: 'super-secret'},
					sourceLayer: 'global',
				},
				{name: 'db', command: 'dbmcp', sourceLayer: 'project'},
			],
			personalSkills: [
				{
					name: 'greet',
					source: './greet',
					path: '/abs/greet',
					sourceLayer: 'project',
				},
			],
		});
		const cli = await runCli(['exec', 'noop', '--dry-run']);
		try {
			const printed = cli.logSpy.mock.calls.map(c => String(c[0])).join('\n');
			expect(printed).toContain('personal capabilities:');
			expect(printed).toContain('personal mcp servers:');
			expect(printed).toContain('- fs [global]');
			expect(printed).toContain('- db [project]');
			expect(printed).toContain('personal skills:');
			expect(printed).toContain('- greet [project]');
			// never leak secrets (env values / command / args / path)
			expect(printed).not.toContain('super-secret');
			expect(printed).not.toContain('/abs/greet');
			expect(cli.exitSpy).toHaveBeenCalledWith(0);
		} finally {
			cli.restore();
		}
	});

	it('--dry-run prints a none-state when no personal capabilities are configured (AC3)', async () => {
		const cli = await runCli(['exec', 'noop', '--dry-run']);
		try {
			const printed = cli.logSpy.mock.calls.map(c => String(c[0])).join('\n');
			expect(printed).toContain('personal capabilities:');
			expect(printed).toContain('personal mcp servers: <none>');
			expect(printed).toContain('personal skills:      <none>');
			expect(cli.exitSpy).toHaveBeenCalledWith(0);
		} finally {
			cli.restore();
		}
	});

	it('--dry-run reports personal capabilities shadowed by workflow plugins (AC4)', async () => {
		bootstrapRuntimeConfigMock.mockReturnValue({
			...BASE_RUNTIME_BOOTSTRAP,
			capabilityConflicts: {
				mcpServers: [
					{
						name: 'shared-mcp',
						command: 'personal-cmd',
						args: ['--x'],
						env: {API_KEY: 'super-secret'},
						sourceLayer: 'global',
					},
				],
				skills: [
					{
						name: 'shared-skill',
						source: './shared',
						path: '/abs/shared',
						sourceLayer: 'project',
					},
				],
			},
		});
		const cli = await runCli(['exec', 'noop', '--dry-run']);
		try {
			const printed = cli.logSpy.mock.calls.map(c => String(c[0])).join('\n');
			expect(printed).toContain('conflicts (shadowed by workflow plugin):');
			expect(printed).toContain('- shared-mcp [global]');
			expect(printed).toContain('- shared-skill [project]');
			// never leak secrets (env values / command / args / path)
			expect(printed).not.toContain('super-secret');
			expect(printed).not.toContain('/abs/shared');
			expect(printed).not.toContain('personal-cmd');
			expect(cli.exitSpy).toHaveBeenCalledWith(0);
		} finally {
			cli.restore();
		}
	});

	it('--dry-run prints a none-state for conflicts when there are none (AC4 none)', async () => {
		const cli = await runCli(['exec', 'noop', '--dry-run']);
		try {
			const printed = cli.logSpy.mock.calls.map(c => String(c[0])).join('\n');
			expect(printed).toContain(
				'conflicts (shadowed by workflow plugin): <none>',
			);
			expect(cli.exitSpy).toHaveBeenCalledWith(0);
		} finally {
			cli.restore();
		}
	});

	it('--dry-run is rejected outside exec mode', async () => {
		const cli = await runCli(['--dry-run']);
		try {
			expect(runExecMock).not.toHaveBeenCalled();
			expect(renderMock).not.toHaveBeenCalled();
			expect(cli.exitSpy).toHaveBeenCalledWith(RUN_EXIT_CODE.USAGE);
			expect(cli.errorSpy).toHaveBeenCalledWith(
				expect.stringContaining('--dry-run is only supported in exec mode'),
			);
		} finally {
			cli.restore();
		}
	});

	it('routes dashboard pair through runDashboardCommand with url/name flags', async () => {
		const cli = await runCli([
			'dashboard',
			'pair',
			'tok_1',
			'--url',
			'http://localhost:5173',
			'--name',
			'macbook',
		]);
		try {
			expect(runDashboardMock).toHaveBeenCalledTimes(1);
			expect(runDashboardMock).toHaveBeenCalledWith({
				subcommand: 'pair',
				subcommandArgs: ['tok_1'],
				flags: {
					url: 'http://localhost:5173',
					name: 'macbook',
					json: false,
				},
			});
			expect(cli.exitSpy).toHaveBeenCalledWith(0);
		} finally {
			cli.restore();
		}
	});

	it('forwards --json to runDashboardCommand', async () => {
		const cli = await runCli(['dashboard', 'status', '--json']);
		try {
			expect(runDashboardMock).toHaveBeenCalledWith({
				subcommand: 'status',
				subcommandArgs: [],
				flags: {url: undefined, name: undefined, json: true},
			});
		} finally {
			cli.restore();
		}
	});

	it('routes workflow install through the interactive install wizard path', async () => {
		const cli = await runCli(['workflow', 'install', 'e2e-test-builder']);
		try {
			await new Promise(resolve => setImmediate(resolve));
			expect(renderMock).toHaveBeenCalledTimes(1);
			expect(resolveWorkflowInstallMock).toHaveBeenCalledWith(
				'e2e-test-builder',
				['lespaceman/athena-workflow-marketplace'],
			);
			expect(cli.exitSpy).not.toHaveBeenCalled();
		} finally {
			cli.restore();
		}
	});
});
