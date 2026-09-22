import {describe, expect, it} from 'vitest';
import {waitForShutdownSignal} from './shutdownSignal';

function timeoutHandles(): number {
	return process
		.getActiveResourcesInfo()
		.filter(resource => resource === 'Timeout').length;
}

describe('waitForShutdownSignal', () => {
	it('keeps the event loop alive until a shutdown signal arrives', async () => {
		const before = timeoutHandles();
		const waiting = waitForShutdownSignal();

		// A pending wait must hold a ref'd handle: a runner whose hub is
		// unreachable has no socket, and only this keeps Node from exiting 0.
		expect(timeoutHandles()).toBe(before + 1);

		process.emit('SIGTERM', 'SIGTERM');
		await expect(waiting).resolves.toBe('SIGTERM');
		expect(timeoutHandles()).toBe(before);
		expect(process.listenerCount('SIGTERM')).toBe(0);
		expect(process.listenerCount('SIGINT')).toBe(0);
	});
});
