import {
	runRunnerCommand,
	type RunnerCommandDeps,
	type RunnerCommandFlags,
	type RunnerCommandInput,
} from './runnerCommand';

/**
 * `drisp dashboard` — the pre-0.6 name of `drisp runner` (#188). Kept for one
 * release as an alias: every subcommand maps onto its runner equivalent, and
 * the one-line notice below is printed once per invocation. Removed in 0.7.0.
 *
 *   dashboard daemon foreground | connect  → drisp runner
 *   dashboard daemon start                 → drisp runner --detach
 *   dashboard daemon stop | restart | install → drisp runner stop | restart | install
 *   dashboard daemon reload                → (was a no-op; still one)
 *   dashboard pair | status | logs | runs | refresh | doctor | list | unpair
 *                                          → the same word under drisp runner
 */

export const DASHBOARD_DEPRECATION_NOTICE =
	'drisp dashboard is deprecated and is removed in 0.7.0; use drisp runner instead.';

export type DashboardCommandInput = {
	subcommand: string;
	subcommandArgs: string[];
	flags: RunnerCommandFlags;
};

export type DashboardToRunnerMapping =
	| {kind: 'runner'; input: RunnerCommandInput}
	| {kind: 'noop'; message: string};

export function mapDashboardToRunner(
	input: DashboardCommandInput,
): DashboardToRunnerMapping {
	const {subcommand, subcommandArgs, flags} = input;
	const runner = (
		next: string,
		args: string[] = [],
		extraFlags: Partial<RunnerCommandFlags> = {},
	): DashboardToRunnerMapping => ({
		kind: 'runner',
		input: {
			subcommand: next,
			subcommandArgs: args,
			flags: {...flags, ...extraFlags},
		},
	});
	if (subcommand === '' || subcommand === 'help' || subcommand === '--help') {
		return runner('help');
	}
	if (subcommand === 'connect') return runner('', subcommandArgs);
	if (subcommand === 'daemon') {
		const [mode, ...rest] = subcommandArgs;
		switch (mode) {
			case 'foreground':
				return runner('', rest);
			case 'start':
				return runner('', rest, {detach: true});
			case 'stop':
			case 'restart':
			case 'install':
				return runner(mode, rest);
			case 'reload':
				return {
					kind: 'noop',
					message:
						'runner: reload is a no-op (the runner re-reads its pairing on every reconnect); use "drisp runner restart" to cycle it.',
				};
			default:
				return runner('daemon', subcommandArgs);
		}
	}
	return runner(subcommand, subcommandArgs);
}

export async function runDashboardCommand(
	input: DashboardCommandInput,
	deps: RunnerCommandDeps = {},
): Promise<number> {
	const logOut = deps.logOut ?? ((m: string) => process.stdout.write(m + '\n'));
	const logError =
		deps.logError ?? ((m: string) => process.stderr.write(m + '\n'));
	logError(DASHBOARD_DEPRECATION_NOTICE);
	const mapped = mapDashboardToRunner(input);
	if (mapped.kind === 'noop') {
		logOut(mapped.message);
		return 0;
	}
	return runRunnerCommand(mapped.input, deps);
}
