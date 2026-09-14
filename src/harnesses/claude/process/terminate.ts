import type {ChildProcess} from 'node:child_process';

const pending = new WeakMap<ChildProcess, Promise<void>>();
const GRACE_MS = 3000;

/** One termination per child. Escalation is a signal, not proof the Turn settled. */
export function terminateClaudeProcess(
	child: ChildProcess,
	waitForExit: () => Promise<unknown>,
): Promise<void> {
	const existing = pending.get(child);
	if (existing) return existing;
	const exit = waitForExit();
	const stopping = (async () => {
		const timer = setTimeout(() => child.kill('SIGKILL'), GRACE_MS);
		try {
			child.kill();
			await exit;
		} finally {
			clearTimeout(timer);
		}
	})();
	pending.set(child, stopping);
	return stopping;
}
