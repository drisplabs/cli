import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {WorkflowPlan} from '../../core/workflows/plan';
import type {WorkflowConfig} from '../../core/workflows/types';
import type {PersistedWorkflowRun} from '../../core/workflows/runState';
import type {HarnessProcessConfig} from '../../core/runtime/process';

/** Only hashes are persisted. Environment values and credentials are never copied. */
export function executionIdentity(input: {
	projectDir: string;
	harness: string;
	workflow?: WorkflowConfig;
	isolationConfig?: HarnessProcessConfig;
	workflowPlan?: WorkflowPlan;
	pluginMcpConfig?: string;
}): string {
	const {env: _env, workflowFile, ...workflow} = input.workflow ?? {};
	const instructions = workflowFile
		? fs.readFileSync(path.resolve(input.projectDir, workflowFile), 'utf8')
		: '';
	const config = input.isolationConfig;
	const semanticConfig = config
		? {
				preset: config.preset,
				model: config.model,
				additionalDirectories: config.additionalDirectories,
				allowedTools: config.allowedTools,
				effort: config.effort,
				plugins: config.pluginDirs?.map(dir =>
					pluginIdentity(path.resolve(input.projectDir, dir)),
				),
			}
		: undefined;
	const digest = crypto
		.createHash('sha256')
		.update(
			stableJson({
				harness: input.harness,
				workflow,
				instructions,
				config: semanticConfig,
				mcpServers: mcpSemantics(input.pluginMcpConfig),
				workflowMcpServers: mcpSemantics(input.workflowPlan?.pluginMcpConfig),
				workflowPlugins: input.workflowPlan?.resolvedPlugins.map(plugin => ({
					ref: plugin.ref,
					version: plugin.version,
					content: pluginIdentity(
						input.harness === 'openai-codex'
							? plugin.codexPluginDir
							: plugin.claudeArtifactDir,
					),
				})),
			}),
		)
		.digest('hex');
	return JSON.stringify({
		version: 1,
		workflowName: input.workflow?.name,
		harness: input.harness,
		digest,
	});
}

// Hash installed instructions and executable plugin assets, never their cache path.
// Credentials and endpoint overrides can be refreshed without replacing a Run.
function pluginIdentity(root: string): string {
	const hash = crypto.createHash('sha256');
	const ancestors = new Set<string>();
	function visit(dir: string): void {
		const real = fs.realpathSync(dir);
		if (ancestors.has(real)) throw new Error(`Cyclic plugin directory: ${dir}`);
		ancestors.add(real);
		for (const entry of fs
			.readdirSync(dir, {withFileTypes: true})
			.sort((a, b) => a.name.localeCompare(b.name))) {
			if (
				['.git', 'node_modules', '.env'].includes(entry.name) ||
				entry.name.startsWith('.env.')
			)
				continue;
			const file = path.join(dir, entry.name);
			const kind = entry.isSymbolicLink() ? fs.statSync(file) : entry;
			if (kind.isDirectory()) visit(file);
			else if (kind.isFile()) {
				hash.update(path.relative(root, file));
				if (entry.name === '.mcp.json') {
					hash.update(stableJson(mcpSemantics(file)));
				} else hash.update(fs.readFileSync(file));
			}
		}
		ancestors.delete(real);
	}
	visit(root);
	return hash.digest('hex');
}

/** Pin effective server membership and launch settings, not refreshable credentials. */
function mcpSemantics(file?: string): Record<string, unknown> {
	if (!file) return {};
	const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid MCP configuration');
	const servers = (value as {mcpServers?: unknown}).mcpServers ?? {};
	if (typeof servers !== 'object' || Array.isArray(servers))
		throw new Error('Invalid MCP server definitions');
	return Object.fromEntries(
		Object.entries(servers).map(([name, config]) => {
			if (!config || typeof config !== 'object' || Array.isArray(config))
				throw new Error(`Invalid MCP server definition: ${name}`);
			const {
				env: _env,
				headers: _headers,
				url: _url,
				options: _options,
				...semantics
			} = config as Record<string, unknown>;
			return [name, semantics];
		}),
	);
}

function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, next: unknown) => {
		if (next && typeof next === 'object' && !Array.isArray(next)) {
			return Object.fromEntries(
				Object.entries(next).sort(([a], [b]) => a.localeCompare(b)),
			);
		}
		return next;
	});
}

export function validateResumeIdentity(
	previous: PersistedWorkflowRun,
	identity: string,
	workflowName?: string,
): string | undefined {
	if (previous.workflowName !== workflowName) {
		throw new Error(
			`Cannot continue workflow '${previous.workflowName ?? '(none)'}' as '${workflowName ?? '(none)'}'. Select the original workflow or start a new Run.`,
		);
	}
	if (!previous.executionIdentityJson) {
		return 'This historical Run has no saved execution identity; resuming with the selected workflow. Original instructions and capabilities cannot be verified.';
	}
	let saved: {version?: number; digest?: string};
	try {
		const value: unknown = JSON.parse(previous.executionIdentityJson);
		if (!value || typeof value !== 'object')
			throw new Error('Invalid identity');
		saved = value as typeof saved;
	} catch {
		throw new Error(
			'Saved execution identity is unreadable; start a new Run instead of silently replacing it.',
		);
	}
	const current = JSON.parse(identity) as {digest: string};
	if (saved.version !== 1 || saved.digest !== current.digest) {
		throw new Error(
			'Workflow instructions, harness, model, or execution settings changed since this Run was saved. Restore the original settings or start a new Run.',
		);
	}
	return undefined;
}
