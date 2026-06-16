import {
	readConfig,
	readGlobalConfig,
	writeGlobalConfig,
	writeProjectConfig,
	type PersonalMcpServer,
	type PersonalMcpServers,
} from '../../infra/plugins/config';
import {resolveEffectiveCapabilities} from '../../infra/capabilities/effective';

export type McpCommandInput = {
	subcommand: string;
	subcommandArgs: string[];
	/** Tokens after the literal `--`: the server command followed by its args. */
	serverCommandTokens: string[];
	projectDir: string;
};

export type McpCommandDeps = {
	readGlobalConfig?: typeof readGlobalConfig;
	readProjectConfig?: typeof readConfig;
	writeGlobalConfig?: typeof writeGlobalConfig;
	writeProjectConfig?: typeof writeProjectConfig;
	logError?: (message: string) => void;
	logOut?: (message: string) => void;
};

type ParsedArgs = {
	project: boolean;
	global: boolean;
	env: string[];
	positional: string[];
};

function parseArgs(
	args: string[],
	context: string,
): ParsedArgs | {error: string} {
	let project = false;
	let global = false;
	const env: string[] = [];
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--project') {
			project = true;
		} else if (arg === '--global') {
			global = true;
		} else if (arg === '--env') {
			const value = args[i + 1];
			if (value === undefined) {
				return {error: `mcp ${context}: --env requires a KEY=VALUE argument`};
			}
			env.push(value);
			i++;
		} else if (arg.startsWith('--')) {
			return {error: `Unknown flag for mcp ${context}: ${arg}`};
		} else {
			positional.push(arg);
		}
	}
	if (project && global) {
		return {
			error: `mcp ${context}: --project and --global are mutually exclusive`,
		};
	}
	return {project, global, env, positional};
}

function parseEnv(entries: string[]): Record<string, string> | {error: string} {
	const env: Record<string, string> = {};
	for (const entry of entries) {
		const eq = entry.indexOf('=');
		if (eq <= 0) {
			return {error: `Invalid --env value (expected KEY=VALUE): ${entry}`};
		}
		env[entry.slice(0, eq)] = entry.slice(eq + 1);
	}
	return env;
}

export function runMcpCommand(
	input: McpCommandInput,
	deps: McpCommandDeps = {},
): number {
	const readGlobal = deps.readGlobalConfig ?? readGlobalConfig;
	const readProject = deps.readProjectConfig ?? readConfig;
	const writeGlobal = deps.writeGlobalConfig ?? writeGlobalConfig;
	const writeProject = deps.writeProjectConfig ?? writeProjectConfig;
	const logError = deps.logError ?? console.error;
	const logOut = deps.logOut ?? console.log;

	const {subcommand} = input;

	if (subcommand === 'add') {
		const parsed = parseArgs(input.subcommandArgs, 'add');
		if ('error' in parsed) {
			logError(parsed.error);
			return 1;
		}
		const name = parsed.positional[0];
		if (!name) {
			logError('mcp add: missing server name');
			return 1;
		}
		const [command, ...args] = input.serverCommandTokens;
		if (!command) {
			logError(
				`mcp add: missing server command. Usage: mcp add ${name} -- <command> [args...]`,
			);
			return 1;
		}
		const envResult = parseEnv(parsed.env);
		if ('error' in envResult) {
			logError(envResult.error);
			return 1;
		}

		const server: PersonalMcpServer = {command};
		if (args.length > 0) {
			server.args = args;
		}
		if (Object.keys(envResult).length > 0) {
			server.env = envResult;
		}

		const layer = parsed.project ? 'project' : 'global';
		const existing =
			(layer === 'project'
				? readProject(input.projectDir).mcpServers
				: readGlobal().mcpServers) ?? {};
		const overwriting = name in existing;
		const merged = {...existing, [name]: server};
		if (layer === 'project') {
			writeProject(input.projectDir, {mcpServers: merged});
		} else {
			writeGlobal({mcpServers: merged});
		}
		logOut(
			`${overwriting ? 'Overwrote' : 'Added'} personal MCP server '${name}' [${layer}]`,
		);
		return 0;
	}

	if (subcommand === 'list') {
		const parsed = parseArgs(input.subcommandArgs, 'list');
		if ('error' in parsed) {
			logError(parsed.error);
			return 1;
		}

		// Single-layer listing. env values are intentionally never printed.
		const listSingleLayer = (servers: PersonalMcpServers, label: string) => {
			const names = Object.keys(servers);
			if (names.length === 0) {
				logOut(`No personal MCP servers configured (${label}).`);
				return;
			}
			logOut(`Personal MCP servers (${label}):`);
			for (const name of names) {
				logOut(`  ${name}  ${servers[name].command}`);
			}
		};

		if (parsed.global) {
			listSingleLayer(readGlobal().mcpServers ?? {}, 'global');
			return 0;
		}
		if (parsed.project) {
			listSingleLayer(
				readProject(input.projectDir).mcpServers ?? {},
				'project',
			);
			return 0;
		}

		const {mcpServers} = resolveEffectiveCapabilities({
			globalConfig: readGlobal(),
			projectConfig: readProject(input.projectDir),
		});
		if (mcpServers.length === 0) {
			logOut('No personal MCP servers configured.');
			return 0;
		}
		logOut('Personal MCP servers (effective):');
		for (const server of mcpServers) {
			logOut(`  ${server.name}  ${server.command} [${server.sourceLayer}]`);
		}
		return 0;
	}

	if (subcommand === 'remove') {
		const parsed = parseArgs(input.subcommandArgs, 'remove');
		if ('error' in parsed) {
			logError(parsed.error);
			return 1;
		}
		const name = parsed.positional[0];
		if (!name) {
			logError('mcp remove: missing server name');
			return 1;
		}
		const layer = parsed.project ? 'project' : 'global';
		const existing =
			(layer === 'project'
				? readProject(input.projectDir).mcpServers
				: readGlobal().mcpServers) ?? {};
		if (!(name in existing)) {
			logError(
				`mcp remove: no personal MCP server '${name}' found in ${layer} config`,
			);
			return 1;
		}
		const next = {...existing};
		delete next[name];
		if (layer === 'project') {
			writeProject(input.projectDir, {mcpServers: next});
		} else {
			writeGlobal({mcpServers: next});
		}
		logOut(`Removed personal MCP server '${name}' [${layer}]`);
		return 0;
	}

	logError(`Unknown mcp subcommand: ${subcommand}`);
	return 1;
}
