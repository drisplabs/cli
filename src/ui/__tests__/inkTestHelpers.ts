import {expect, vi} from 'vitest';

// Ink processes stdin and re-renders asynchronously, so a fixed sleep after
// `stdin.write` races the render under CPU load. Poll instead. The 4s cap sits
// below vitest's 5s test timeout so a miss reports the failed assertion rather
// than a bare timeout.
export function waitFor(assertion: () => void): Promise<void> {
	return vi.waitFor(assertion, {timeout: 4000, interval: 10});
}

export function waitForFrame(
	lastFrame: () => string | undefined,
	text: string,
): Promise<void> {
	return waitFor(() => {
		expect(lastFrame() ?? '').toContain(text);
	});
}

// A new frame is painted on commit, but Ink's `useInput` (re)subscribes its
// handler in a passive effect that runs afterwards. A key written in between
// is dropped (first mount) or handled by the previous render's closure. Wait
// for the frame, then let the passive effects flush before the next key.
export async function waitForInputReady(
	lastFrame: () => string | undefined,
	text: string,
): Promise<void> {
	await waitForFrame(lastFrame, text);
	await new Promise(resolve => setImmediate(resolve));
}
