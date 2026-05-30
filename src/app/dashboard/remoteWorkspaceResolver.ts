import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {daemonStatePaths} from '../../infra/daemon/stateDir';
import type {AssignmentRejectedReason} from './instanceSocketClient';
import type {ValidatedAssignment} from './remoteRunExecutor';

export type RemoteWorkspaceRejection = {
	reason: Extract<
		AssignmentRejectedReason,
		'workspace_unresolved' | 'workspace_invalid'
	>;
	message: string;
};

export type RemoteWorkspaceResolution =
	| {kind: 'resolved'; projectDir: string}
	| {kind: 'rejected'; rejection: RemoteWorkspaceRejection};

export type ResolveRemoteWorkspaceOptions = {
	dashboardUrl?: string;
	env?: NodeJS.ProcessEnv;
};

export function resolveRemoteWorkspace(
	assignment: ValidatedAssignment,
	options: ResolveRemoteWorkspaceOptions = {},
): RemoteWorkspaceResolution {
	const {spec, runId, runnerId} = assignment;

	if (spec.projectDir) {
		return validateProjectDir(spec.projectDir, options.env);
	}

	const sessionId = spec.athenaSessionId ?? spec.sessionId;
	const deploymentSlug = deploymentSlugFromUrl(options.dashboardUrl);
	const stateDir = daemonStatePaths(options.env).dir;
	const projectDir = sessionId
		? path.join(
				stateDir,
				'remote-workspaces',
				deploymentSlug,
				sanitizePathSegment(runnerId),
				'sessions',
				sanitizePathSegment(sessionId),
			)
		: path.join(
				stateDir,
				'remote-workspaces',
				deploymentSlug,
				sanitizePathSegment(runnerId),
				'runs',
				sanitizePathSegment(runId),
			);

	try {
		fs.mkdirSync(projectDir, {recursive: true, mode: 0o700});
		if (process.platform !== 'win32') {
			try {
				fs.chmodSync(projectDir, 0o700);
			} catch {
				// best-effort; validation below still catches inaccessible paths
			}
		}
	} catch (err) {
		return {
			kind: 'rejected',
			rejection: {
				reason: 'workspace_unresolved',
				message: `failed to create remote workspace: ${
					err instanceof Error ? err.message : String(err)
				}`,
			},
		};
	}

	return validateProjectDir(projectDir, options.env);
}

function validateProjectDir(
	projectDir: string,
	env: NodeJS.ProcessEnv = process.env,
): RemoteWorkspaceResolution {
	const resolved = path.resolve(projectDir);
	if (!path.isAbsolute(projectDir)) {
		return {
			kind: 'rejected',
			rejection: {
				reason: 'workspace_invalid',
				message: `remote workspace must be an absolute path: ${projectDir}`,
			},
		};
	}
	const home = path.resolve(env['HOME'] ?? os.homedir());
	if (resolved === home) {
		return {
			kind: 'rejected',
			rejection: {
				reason: 'workspace_invalid',
				message: 'remote workspace cannot be the user home directory',
			},
		};
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(resolved);
	} catch {
		return {
			kind: 'rejected',
			rejection: {
				reason: 'workspace_invalid',
				message: `remote workspace does not exist: ${resolved}`,
			},
		};
	}
	if (!stat.isDirectory()) {
		return {
			kind: 'rejected',
			rejection: {
				reason: 'workspace_invalid',
				message: `remote workspace is not a directory: ${resolved}`,
			},
		};
	}
	return {kind: 'resolved', projectDir: resolved};
}

function deploymentSlugFromUrl(dashboardUrl: string | undefined): string {
	if (!dashboardUrl) return 'unknown-dashboard';
	try {
		const url = new URL(dashboardUrl);
		return sanitizePathSegment(url.host);
	} catch {
		return sanitizePathSegment(dashboardUrl);
	}
}

function sanitizePathSegment(value: string): string {
	const cleaned = value
		.trim()
		.replaceAll(/[^a-zA-Z0-9._-]+/g, '-')
		.replaceAll(/^-+|-+$/g, '');
	return cleaned.length > 0 ? cleaned : 'unknown';
}
