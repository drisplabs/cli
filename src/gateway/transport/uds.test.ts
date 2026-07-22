import {describe, expect, it} from 'vitest';
import {createUdsClientTransport, createUdsServerTransport} from './uds';

describe('UDS transport factories', () => {
	it('exposes separate server and client transports for the control plane', () => {
		const server = createUdsServerTransport({
			socketPath: '/tmp/athena-test.sock',
		});
		const client = createUdsClientTransport({
			socketPath: '/tmp/athena-test.sock',
			timeoutMs: 100,
		});

		expect(server.kind).toBe('uds');
		expect(client.kind).toBe('uds');
		expect(typeof server.listen).toBe('function');
		expect(typeof client.connect).toBe('function');
	});

	it('describes its socket path without needing to listen', () => {
		const server = createUdsServerTransport({
			socketPath: '/tmp/athena-describe.sock',
		});
		expect(server.describe()).toEqual({
			kind: 'uds',
			socketPath: '/tmp/athena-describe.sock',
		});
	});
});
