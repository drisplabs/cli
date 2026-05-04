/**
 * Internal configuration for the console adapter.
 *
 * `parseConfig` produces this shape from sidecar JSON; `ConsoleAdapter`
 * consumes it. `brokerClientFactory` is a test seam — production code goes
 * through the default factory in `client.ts`.
 */

import type {ConsoleBrokerClient} from './client';

export type ConsoleAdapterOptions = {
	/** WSS endpoint for the broker adapter socket. */
	brokerUrl: string;
	/** Broker-visible runner identity for this paired CLI. */
	runnerId: string;
	/** Optional workspace/org/account id surfaced to the broker. */
	workspaceId?: string;
	/** Inline token (tests + local dev). Production uses `tokenPath`. */
	pairingToken?: string;
	/** Filesystem path to the pairing token. Read at start time. */
	tokenPath?: string;
	/** Optional CA bundle for self-signed broker TLS. */
	tlsCaPath?: string;
	/** Override broker-client factory for tests. */
	brokerClientFactory?: ConsoleBrokerClientFactory;
};

export type ConsoleBrokerClientFactory = (input: {
	brokerUrl: string;
	pairingToken: string;
	tlsCaPath?: string;
	log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
}) => ConsoleBrokerClient;
