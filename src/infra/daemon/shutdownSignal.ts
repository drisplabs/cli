/**
 * Resolve with the signal name on the first SIGINT / SIGTERM, holding the
 * process open until then.
 *
 * Signal listeners do not keep Node's event loop alive, and the runtime's own
 * timers are unref'd. A runner that cannot reach the hub has no socket either,
 * so without a ref'd handle here it would drain the loop and exit 0 — which a
 * launchd / systemd unit (restart on non-zero only) treats as a clean stop.
 */
export function waitForShutdownSignal(): Promise<NodeJS.Signals> {
	return new Promise(resolve => {
		const keepAlive = setInterval(() => {}, 2 ** 31 - 1);
		const onSignal = (signal: NodeJS.Signals): void => {
			clearInterval(keepAlive);
			process.off('SIGINT', onSignal);
			process.off('SIGTERM', onSignal);
			resolve(signal);
		};
		process.on('SIGINT', onSignal);
		process.on('SIGTERM', onSignal);
	});
}
