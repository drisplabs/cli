/**
 * Unit tests for `connect()` covering the hello-frame handshake. The control
 * client must not hang when a transport opens but stalls on the hello frame
 * (a misconfigured proxy, half-open WS, or daemon dying mid-handshake).
 */

import {describe, expect, it, vi} from 'vitest';
import {
	connect,
	GatewayUnauthorizedError,
	GatewayUnreachableError,
} from './client';
import type {ClientTransport, FramedConnection} from '../transport/types';

type StubConnection = FramedConnection & {
	emitFrame: (frame: unknown) => void;
	emitClose: () => void;
	emitError: (err: Error) => void;
	closed: boolean;
	sent: unknown[];
};

function makeStubConnection(): StubConnection {
	const frameHandlers = new Set<(f: unknown) => void>();
	const closeHandlers = new Set<() => void>();
	const errorHandlers = new Set<(err: Error) => void>();
	const sent: unknown[] = [];
	const conn: StubConnection = {
		kind: 'ws',
		peer: 'stub',
		closed: false,
		sent,
		send: frame => {
			sent.push(frame);
		},
		close: () => {
			if (conn.closed) return;
			conn.closed = true;
			for (const cb of closeHandlers) cb();
		},
		onFrame: cb => {
			frameHandlers.add(cb);
			return () => frameHandlers.delete(cb);
		},
		onClose: cb => {
			closeHandlers.add(cb);
			return () => closeHandlers.delete(cb);
		},
		onError: cb => {
			errorHandlers.add(cb);
			return () => errorHandlers.delete(cb);
		},
		emitFrame: frame => {
			for (const cb of frameHandlers) cb(frame);
		},
		emitClose: () => {
			if (conn.closed) return;
			conn.closed = true;
			for (const cb of closeHandlers) cb();
		},
		emitError: err => {
			for (const cb of errorHandlers) cb(err);
		},
	};
	return conn;
}

function makeStubTransport(conn: StubConnection): ClientTransport {
	return {
		kind: 'ws',
		connect: async () => conn,
	};
}

describe('connect() hello handshake', () => {
	it('rejects with GatewayUnreachableError when hello never arrives', async () => {
		vi.useFakeTimers();
		try {
			const conn = makeStubConnection();
			const promise = connect({
				socketPath: '/unused',
				token: 't',
				timeoutMs: 50,
				transport: makeStubTransport(conn),
			});
			// Attach the rejection assertion *before* advancing the timer so the
			// catch handler is wired before the rejection fires (otherwise
			// vitest reports an unhandled rejection).
			const assertion = expect(promise).rejects.toThrow(
				/hello not received within 50ms/,
			);
			await vi.advanceTimersByTimeAsync(60);
			await assertion;
			expect(conn.closed).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects with GatewayUnreachableError when the transport closes before hello', async () => {
		const conn = makeStubConnection();
		const promise = connect({
			socketPath: '/unused',
			token: 't',
			timeoutMs: 1_000,
			transport: makeStubTransport(conn),
		});
		// Let the connect() microtasks register frame/close handlers and send
		// the connect frame, then close the transport before any reply.
		await Promise.resolve();
		conn.emitClose();
		await expect(promise).rejects.toBeInstanceOf(GatewayUnreachableError);
		await expect(promise).rejects.toThrow(/closed before hello frame/);
	});

	it('rejects with GatewayUnreachableError when the transport errors before hello', async () => {
		const conn = makeStubConnection();
		const promise = connect({
			socketPath: '/unused',
			token: 't',
			timeoutMs: 1_000,
			transport: makeStubTransport(conn),
		});
		await Promise.resolve();
		conn.emitError(new Error('ECONNRESET'));
		await expect(promise).rejects.toBeInstanceOf(GatewayUnreachableError);
		await expect(promise).rejects.toThrow(/transport error: ECONNRESET/);
		expect(conn.closed).toBe(true);
	});

	it('surfaces unauthorized hello as GatewayUnauthorizedError', async () => {
		const conn = makeStubConnection();
		const promise = connect({
			socketPath: '/unused',
			token: 't',
			timeoutMs: 1_000,
			transport: makeStubTransport(conn),
		});
		await Promise.resolve();
		conn.emitFrame({
			ok: false,
			error: {code: 'unauthorized', message: 'invalid token'},
		});
		await expect(promise).rejects.toBeInstanceOf(GatewayUnauthorizedError);
		expect(conn.closed).toBe(true);
	});

	it('completes when the hello arrives ok:true', async () => {
		const conn = makeStubConnection();
		const promise = connect({
			socketPath: '/unused',
			token: 't',
			timeoutMs: 1_000,
			transport: makeStubTransport(conn),
		});
		await Promise.resolve();
		conn.emitFrame({ok: true, hello: {daemonPid: 1, startedAt: 0}});
		const client = await promise;
		expect(client).toBeDefined();
		expect(conn.sent[0]).toEqual({kind: 'connect', token: 't'});
		client.close();
	});

	it('keeps the handshake and request routing intact when a frame is coalesced into the hello tick', async () => {
		// A transport can dispatch several framed lines from one wire chunk in a
		// single synchronous tick. handleFrame gates on helloAcked, which is now
		// flipped the instant the hello frame is consumed (not a microtask later),
		// so a frame arriving in the same tick as the hello routes through the
		// normal path instead of hitting the nulled preHelloResolve. This is a
		// no-regression guard: the drop itself isn't observable through the public
		// API here (nothing is pending and no push is subscribed at hello time),
		// but the handshake must survive the coalesced frame and stay usable.
		const conn = makeStubConnection();
		const promise = connect({
			socketPath: '/unused',
			token: 't',
			timeoutMs: 1_000,
			transport: makeStubTransport(conn),
		});
		await Promise.resolve();
		// hello + a second frame, same tick, before connect()'s continuation runs.
		conn.emitFrame({ok: true, hello: {daemonPid: 1, startedAt: 0}});
		conn.emitFrame({push_id: 'p1', kind: 'coalesced-noise', payload: {}});
		const client = await promise;
		expect(client).toBeDefined();

		// The request/response path still works after the coalesced frame.
		const request = client.request<{value: true}, {ok: true}>(
			'relay.question.request',
			{value: true},
		);
		const sent = conn.sent[1] as {request_id: string};
		conn.emitFrame({
			request_id: sent.request_id,
			ok: true,
			payload: {ok: true},
		});
		await expect(request).resolves.toEqual({ok: true});
		client.close();
	});

	it('does not time out a request when timeoutMs is null', async () => {
		vi.useFakeTimers();
		try {
			const conn = makeStubConnection();
			const promise = connect({
				socketPath: '/unused',
				token: 't',
				timeoutMs: 50,
				transport: makeStubTransport(conn),
			});
			await Promise.resolve();
			conn.emitFrame({ok: true, hello: {daemonPid: 1, startedAt: 0}});
			const client = await promise;

			const request = client.request<{value: true}, {ok: true}>(
				'relay.question.request',
				{value: true},
				{timeoutMs: null},
			);
			let settled = false;
			void request.then(() => {
				settled = true;
			});

			await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
			expect(settled).toBe(false);

			const sent = conn.sent[1] as {request_id: string};
			conn.emitFrame({
				request_id: sent.request_id,
				ok: true,
				payload: {ok: true},
			});
			await expect(request).resolves.toEqual({ok: true});
			client.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it('falls back to the client timeout when request timeoutMs is undefined', async () => {
		vi.useFakeTimers();
		try {
			const conn = makeStubConnection();
			const promise = connect({
				socketPath: '/unused',
				token: 't',
				timeoutMs: 50,
				transport: makeStubTransport(conn),
			});
			await Promise.resolve();
			conn.emitFrame({ok: true, hello: {daemonPid: 1, startedAt: 0}});
			const client = await promise;

			const request = client.request<{value: true}, {ok: true}>(
				'relay.question.request',
				{value: true},
				{timeoutMs: undefined},
			);
			let rejected = false;
			void request.catch(() => {
				rejected = true;
			});

			await vi.advanceTimersByTimeAsync(49);
			expect(rejected).toBe(false);

			const assertion = expect(request).rejects.toThrow(
				/request relay.question.request timed out/,
			);
			await vi.advanceTimersByTimeAsync(1);
			await assertion;
			client.close();
		} finally {
			vi.useRealTimers();
		}
	});
});
