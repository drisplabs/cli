import type {AthenaConfig} from '../../infra/plugins/config';
import type {WorkflowConfig} from '../../core/workflows/types';
import {DEFAULT_PERMISSION_GRACE_MS} from '../../core/workflows/types';
import {
	HARNESS_PROCESS_PRESETS,
	resolveHarnessProcessPreset,
	type HarnessProcessPreset,
} from '../../core/runtime/process';

/** Pure precedence rules. File reads, Git, registration and asset writes belong to bootstrap. */
export function resolveExecutionSettings(input: {
	globalConfig: AthenaConfig;
	projectConfig: AthenaConfig;
	workflow?: WorkflowConfig;
	isolationPreset: HarnessProcessPreset;
}) {
	const {
		globalConfig,
		projectConfig,
		workflow: activeWorkflow,
		isolationPreset: initialIsolationPreset,
	} = input;
	const warnings: string[] = [];
	const configModel =
		projectConfig.model || globalConfig.model || activeWorkflow?.model;
	const configEffort = activeWorkflow?.effort;

	let isolationPreset = initialIsolationPreset;
	if (activeWorkflow?.isolation) {
		// A workflow.json may still spell its preset the pre-0.6 way (#185);
		// read it through the same resolver the CLI flag uses, and say so.
		const resolved = resolveHarnessProcessPreset(activeWorkflow.isolation);
		if (resolved?.deprecation) {
			warnings.push(
				`Workflow '${activeWorkflow.name}' isolation ${resolved.deprecation}`,
			);
		}
		const workflowIdx = resolved
			? HARNESS_PROCESS_PRESETS.indexOf(resolved.preset)
			: -1;
		const userIdx = HARNESS_PROCESS_PRESETS.indexOf(isolationPreset);
		if (resolved && workflowIdx > userIdx) {
			warnings.push(
				`Workflow '${activeWorkflow.name}' requires '${resolved.preset}' isolation (upgrading from '${isolationPreset}')`,
			);
			isolationPreset = resolved.preset;
		}
	}

	return {
		model: configModel,
		effort: configEffort,
		isolationPreset,
		warnings,
		additionalDirectories: [
			...globalConfig.additionalDirectories,
			...projectConfig.additionalDirectories,
		],
		permissionGraceMs:
			projectConfig.permissionGraceMs ??
			globalConfig.permissionGraceMs ??
			DEFAULT_PERMISSION_GRACE_MS,
		provenance: {
			model: projectConfig.model
				? 'project'
				: globalConfig.model
					? 'global'
					: activeWorkflow?.model
						? 'workflow'
						: 'harness-default',
			permissionGraceMs:
				projectConfig.permissionGraceMs !== undefined
					? 'project'
					: globalConfig.permissionGraceMs !== undefined
						? 'global'
						: 'default',
		},
	};
}
