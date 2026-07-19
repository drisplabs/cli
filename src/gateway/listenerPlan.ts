/**
 * One owner for the "may this listener be exposed?" policy.
 *
 * The security invariant — don't expose a non-loopback bind without TLS or a
 * token, and warn when `--insecure` ships the token in plaintext — was
 * previously re-derived across four modules: {@link requireTokenForBind} in
 * auth.ts, the loopback guard in the WS transport, and the daemon's
 * `allowNonLoopback` derivation plus its insecure warning. `planListener`
 * gathers the derivation into a single call: it enforces the token/TLS rule,
 * computes `allowNonLoopback`, and returns any warnings for the daemon to
 * print. The transport then receives a validated config and re-checks nothing.
 */

import {requireTokenForBind} from './auth';
import {
	isLoopbackHost,
	type GatewayListenSpec,
	type GatewayTlsConfig,
} from './paths';

export type ListenerPlan = {
	transport:
		| {kind: 'uds'; socketPath: string}
		| {
				kind: 'tcp';
				host: string;
				port: number;
				/** Whether the transport may bind a non-loopback host. */
				allowNonLoopback: boolean;
				tls?: GatewayTlsConfig;
		  };
	/** Non-fatal advisories for the caller to surface (e.g. plaintext token). */
	warnings: string[];
};

/**
 * Validate a listen spec against the bind-safety policy and produce the
 * transport config plus any warnings. Throws when the spec would expose a
 * non-loopback bind without a token or without TLS/`--insecure`.
 */
export function planListener(
	spec: GatewayListenSpec,
	token: string | undefined,
): ListenerPlan {
	requireTokenForBind(spec, token);

	if (spec.kind === 'uds') {
		return {
			transport: {kind: 'uds', socketPath: spec.socketPath},
			warnings: [],
		};
	}

	const warnings: string[] = [];
	if (spec.insecure && !spec.tls && !isLoopbackHost(spec.host)) {
		warnings.push(
			`athena-gateway: WARNING --insecure is set on a non-loopback bind (${spec.host}:${spec.port}); ` +
				`token travels in plaintext. Use only behind TLS-terminating reverse proxy or Tailscale/WireGuard tunnel.`,
		);
	}

	return {
		transport: {
			kind: 'tcp',
			host: spec.host,
			port: spec.port,
			allowNonLoopback: spec.insecure || Boolean(spec.tls),
			...(spec.tls ? {tls: spec.tls} : {}),
		},
		warnings,
	};
}
