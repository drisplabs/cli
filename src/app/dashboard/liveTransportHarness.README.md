# Live-transport dashboard-daemon harness

A reusable, replayable integration harness for the dashboard-daemon
reconnect/reconcile path. It boots the **real** `runDashboardRuntimeDaemon`
against a local `http` + `ws` server on a loopback port, so it exercises the
production transport — real `ws` socket (access token sent as a WebSocket
subprotocol) and the real `fetch`-based attachment reconcile — rather than the
injected seams the unit tests use.

This is the live-transport companion to the in-process unit coverage in
`runtimeDaemon.test.ts` (issue #35); it does not re-implement that in-process
reconnect-guard test.

## What it verifies

Each scenario is reported as a `HarnessVerificationResult` check
(`{ ok, summary, checks: [{ label, status, message }] }`, the same shape as the
adapter harnesses in `src/harnesses/`):

1. **Graceful degradation on 503 reconcile** — the daemon connects the real
   socket, the attachment reconcile hits a real `503`, and the daemon stays
   connected in push-only mode instead of tearing the control channel down.
2. **Assignment admitted over the wire** — the server sends a real
   `job_assignment` frame and observes the daemon send `assignment_accepted`
   back over the socket.
3. **Reconnect after close** — the server drops the socket and the daemon
   re-establishes it through the real reconnect loop.

## How to run

```sh
npx vitest run src/app/dashboard/liveTransportHarness.test.ts
```

The harness runs fully offline: it binds only to `127.0.0.1` on an ephemeral
port and needs no real dashboard, credentials, or network access.

### Expected output

A passing run prints the standard Vitest summary, for example:

```
 ✓ src/app/dashboard/liveTransportHarness.test.ts (1 test) ...

 Test Files  1 passed (1)
      Tests  1 passed (1)
```

### Exit codes

- `0` — every scenario passed (`result.ok === true`).
- `1` — at least one scenario failed; the failing check's `label: message` is
  printed in the assertion error so you can see which scenario regressed.

## Cleanup guarantee

Teardown runs in a `finally` block even when a scenario fails: the daemon is
stopped, the `ws` and `http` servers are closed, and the temporary workspace
directory (created under the OS temp dir) is removed. No ports, timers, or
disk artifacts are left behind, and the working tree is never modified.

## Calling it directly

The harness is also exported as a function for programmatic use:

```ts
import {runLiveTransportHarness} from './liveTransportHarness';

const result = await runLiveTransportHarness();
if (!result.ok) {
	for (const check of result.checks) {
		console.log(
			`${check.status.toUpperCase()} ${check.label}: ${check.message}`,
		);
	}
	process.exitCode = 1;
}
```
