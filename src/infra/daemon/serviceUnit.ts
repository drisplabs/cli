import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runnerStatePaths} from './stateDir';

export type ServiceInstallResult = {
	ok: boolean;
	platform: 'darwin' | 'linux' | 'unsupported';
	path?: string;
	loadCommand?: string;
	startCommand?: string;
	message?: string;
};

export type ServiceInstallOptions = {
	/** Absolute path to dist/runner.js. */
	runnerEntry: string;
	/** Absolute path to the node binary (typically `process.execPath`). */
	nodeBinary: string;
	env?: NodeJS.ProcessEnv;
	/** Override the platform for tests. */
	platform?: NodeJS.Platform;
	/** Override target install path for tests. */
	targetPath?: string;
};

/**
 * Generate and write a launchd plist (macOS) or systemd user unit (linux) for
 * the `drisp runner` process. The unit names (`ai.drisp.daemon`,
 * `drisp-daemon.service`) predate the runner and are kept so a re-install
 * updates the unit a pre-0.6 pairing wrote instead of leaving two.
 *
 * Idempotent: if the unit file already matches, this is a no-op. The caller
 * runs the platform load command — we don't shell out for them, partly so the
 * user sees what's happening, partly so we don't need to error-handle launchctl
 * failures in this library.
 *
 * Skips silently on unsupported platforms (Windows, BSD) and reports
 * `platform: 'unsupported'`. The user can still run the daemon via
 * `drisp runner` under their own supervisor.
 */
export function installServiceUnit(
	options: ServiceInstallOptions,
): ServiceInstallResult {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const home = env['HOME'] ?? os.homedir();

	if (platform === 'darwin') {
		const target =
			options.targetPath ??
			path.join(home, 'Library', 'LaunchAgents', 'ai.drisp.daemon.plist');
		const paths = runnerStatePaths(env);
		const plist = renderLaunchdPlist({
			label: 'ai.drisp.daemon',
			nodeBinary: options.nodeBinary,
			daemonEntry: options.runnerEntry,
			workingDirectory: home,
			stdoutPath: paths.logPath,
			stderrPath: paths.logPath,
		});
		writeIfChanged(target, plist);
		return {
			ok: true,
			platform: 'darwin',
			path: target,
			loadCommand: `launchctl load -w ${target}`,
			startCommand: 'launchctl start ai.drisp.daemon',
		};
	}

	if (platform === 'linux') {
		const target =
			options.targetPath ??
			path.join(home, '.config', 'systemd', 'user', 'drisp-daemon.service');
		const unit = renderSystemdUnit({
			description: 'Drisp runner',
			nodeBinary: options.nodeBinary,
			daemonEntry: options.runnerEntry,
		});
		writeIfChanged(target, unit);
		return {
			ok: true,
			platform: 'linux',
			path: target,
			loadCommand: 'systemctl --user daemon-reload',
			startCommand: 'systemctl --user enable --now drisp-daemon.service',
		};
	}

	return {
		ok: false,
		platform: 'unsupported',
		message: `service install not supported on ${platform}`,
	};
}

function writeIfChanged(target: string, content: string): void {
	const dir = path.dirname(target);
	fs.mkdirSync(dir, {recursive: true, mode: 0o700});
	let existing: string | null = null;
	try {
		existing = fs.readFileSync(target, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}
	if (existing === content) return;
	fs.writeFileSync(target, content, {mode: 0o600});
}

export function renderLaunchdPlist(input: {
	label: string;
	nodeBinary: string;
	daemonEntry: string;
	workingDirectory: string;
	stdoutPath: string;
	stderrPath: string;
}): string {
	const argv = [input.nodeBinary, input.daemonEntry]
		.map(s => `\t\t<string>${escapeXml(s)}</string>`)
		.join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${escapeXml(input.label)}</string>
	<key>ProgramArguments</key>
	<array>
${argv}
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>WorkingDirectory</key>
	<string>${escapeXml(input.workingDirectory)}</string>
	<key>StandardOutPath</key>
	<string>${escapeXml(input.stdoutPath)}</string>
	<key>StandardErrorPath</key>
	<string>${escapeXml(input.stderrPath)}</string>
	<key>ProcessType</key>
	<string>Background</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(input: {
	description: string;
	nodeBinary: string;
	daemonEntry: string;
}): string {
	return `[Unit]
Description=${input.description}
After=network-online.target

[Service]
Type=simple
ExecStart=${input.nodeBinary} ${input.daemonEntry}
Restart=always
RestartSec=5
SuccessExitStatus=0
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

function escapeXml(input: string): string {
	return input
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
