import {describe, expect, it} from 'vitest';
import {planListener} from './listenerPlan';
import type {GatewayListenSpec} from './paths';

const TOKEN = 'secret-token-1234';
const TLS = {certPath: '/tmp/cert.pem', keyPath: '/tmp/key.pem'};

describe('planListener', () => {
	it('returns a uds transport with no warnings and no token requirement', () => {
		const spec: GatewayListenSpec = {kind: 'uds', socketPath: '/tmp/a.sock'};
		const plan = planListener(spec, undefined);
		expect(plan).toEqual({
			transport: {kind: 'uds', socketPath: '/tmp/a.sock'},
			warnings: [],
		});
	});

	it('allows a loopback tcp bind without a token and does not allow non-loopback', () => {
		const spec: GatewayListenSpec = {
			kind: 'tcp',
			host: '127.0.0.1',
			port: 8123,
			insecure: false,
		};
		const plan = planListener(spec, undefined);
		expect(plan.transport).toEqual({
			kind: 'tcp',
			host: '127.0.0.1',
			port: 8123,
			allowNonLoopback: false,
		});
		expect(plan.warnings).toEqual([]);
	});

	it('throws when a non-loopback bind has no token', () => {
		const spec: GatewayListenSpec = {
			kind: 'tcp',
			host: '10.0.0.5',
			port: 8123,
			insecure: true,
		};
		expect(() => planListener(spec, '')).toThrow(/without token/);
	});

	it('throws when a non-loopback bind has a token but no TLS and no --insecure', () => {
		const spec: GatewayListenSpec = {
			kind: 'tcp',
			host: '10.0.0.5',
			port: 8123,
			insecure: false,
		};
		expect(() => planListener(spec, TOKEN)).toThrow(/without TLS/);
	});

	it('warns and allows non-loopback when --insecure without TLS', () => {
		const spec: GatewayListenSpec = {
			kind: 'tcp',
			host: '10.0.0.5',
			port: 8123,
			insecure: true,
		};
		const plan = planListener(spec, TOKEN);
		expect(plan.transport).toEqual({
			kind: 'tcp',
			host: '10.0.0.5',
			port: 8123,
			allowNonLoopback: true,
		});
		expect(plan.warnings).toHaveLength(1);
		expect(plan.warnings[0]).toMatch(
			/--insecure is set on a non-loopback bind/,
		);
	});

	it('allows non-loopback under TLS with no plaintext warning', () => {
		const spec: GatewayListenSpec = {
			kind: 'tcp',
			host: '10.0.0.5',
			port: 8123,
			insecure: false,
			tls: TLS,
		};
		const plan = planListener(spec, TOKEN);
		expect(plan.transport).toEqual({
			kind: 'tcp',
			host: '10.0.0.5',
			port: 8123,
			allowNonLoopback: true,
			tls: TLS,
		});
		expect(plan.warnings).toEqual([]);
	});
});
