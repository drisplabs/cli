# Live-transport dashboard-daemon harness

A reusable, replayable integration harness for the dashboard daemon's wire
contract: a **fake hub built from the `@drisp/protocol` schemas**, driven over
a **real** transport. It boots the production `runDashboardRuntimeDaemon`
against a local `http` + `ws` server on a loopback port, so it exercises the
production path — real `ws` socket (access token sent as a WebSocket
subprotocol), the `hello` handshake, frame normalisation through the package,
and the real `fetch`-based attachment reconcile — rather than the injected
seams the unit tests use. The Workflow store is real too, pointed at a temp
directory: the inventory on `hello` and the `workflows.changed` push after an
install go through the real store read and the real directory watch.

This is the live-transport companion to the in-process unit coverage in
`runtimeDaemon.test.ts`; it does not re-implement that in-process
reconnect-guard test.

## Two hubs

The fake hub speaks one of two frame-name sets, selected with `hubProtocol`:

| `hubProtocol` | Sends `hello`?                 | Hub → runner names         | Expects runner → hub names          |
| ------------- | ------------------------------ | -------------------------- | ----------------------------------- |
| `legacy`      | no (the hub that exists today) | `job_assignment`, `cancel` | `run_event`, `feed_event`, …        |
| `canonical`   | yes, with `PROTOCOL_VERSION`   | `run.start`, `stop`        | `event` (`stream: 'run' \| 'feed'`) |

`steer`, `needs_human`, `hello`, `workflows.changed`, and `error` exist only
under the new names and are the same in both modes. Every frame the runner puts on the wire is parsed
with `FrameSchema` and checked to be in the hub's name set; a frame under the
wrong set is reported by the last check.

## What it verifies

Each scenario is reported as a `HarnessVerificationResult` check
(`{ ok, summary, checks: [{ label, status, message }] }`, the same shape as the
adapter harnesses in `src/harnesses/`):

1. **Versioned hello first** — the first frame on the wire is
   `hello{protocolVersion, role: 'runner', instanceId, workflows}`, with
   `workflows` listing the built-in Workflow (versioned by the CLI) and the one
   seeded in the temp store.
2. **Graceful degradation on 503 reconcile** — the attachment reconcile hits a
   real `503` and the daemon stays connected in push-only mode.
3. **Wire mode negotiated** — `legacy` when the hub said nothing, `canonical`
   once its `hello` carried our version (`daemon.snapshot().wireMode`).
4. **Assignment admitted over the wire** — the hub's assignment frame (under
   its own name) is admitted and `assignment_accepted` comes back.
5. **Run stream and needs_human on the wire** — the Run's stream arrives under
   the hub's name set and the parked Run is reported with `needs_human`
   carrying a `question` Interruption addressed by a request id (a permission
   deferred after the grace window, #190).
6. **Answer stored and Run woken while parked** — the hub's `answer` for that
   request (under its own name set) is acked, kept in the decision inbox for
   replay, recorded on the parked Run's record, and wakes the Run: the
   executor is re-launched with a wake reply naming the answer and the Run is
   active again.
7. **Steer delivered into the next Turn** — a `steer` sent while the woken
   Run's first Turn is in flight is recorded on the Run, left out of that Turn,
   and delivered at the head of the next Turn's prompt (a real Workflow Runner
   over a fake harness), with a Journal entry naming its origin.
8. **Phase event on the feed stream** — Turn 1 leaves a Turn Protocol block in
   the Journal; the real Workflow Runner reports the change of step, which is
   published through the real paired feed publisher (its outbox in the temp
   workspace) and reaches the hub as a `phase` FeedEvent on the feed stream
   under the hub's name set, parsing under `PhaseFeedEventSchema`; the hub
   acks it.
9. **Malformed frames answered with error** — a non-frame object and invalid
   JSON are each answered with `error{code: 'malformed_frame'}`; the socket
   stays up.
10. **Stop cancels the run** — the hub's stop frame (under its own name) aborts
    the Run.
11. **Workflow store change pushed** — writing a Workflow into the store (the
    way `drisp workflow install` does) produces a `workflows.changed` with the
    full new inventory; removing one produces another without it.
12. **Reconnect after close** — the daemon re-establishes the socket, sends
    `hello` first again (with the store as it is now), and re-negotiates the
    wire mode.
13. **Every runner frame in the expected name set** — no schema or name-set
    violations across the whole session.

## How to run

```sh
npx vitest run src/app/dashboard/liveTransportHarness.test.ts
```

The test runs the harness once per hub mode. It runs fully offline: it binds
only to `127.0.0.1` on an ephemeral port and needs no real dashboard,
credentials, or network access.

### Expected output

A passing run prints the standard Vitest summary, for example:

```
 ✓ src/app/dashboard/liveTransportHarness.test.ts (2 tests) ...

 Test Files  1 passed (1)
      Tests  2 passed (2)
```

### Exit codes

- `0` — every scenario passed in both modes (`result.ok === true`).
- `1` — at least one scenario failed; the failing check's `label: message` is
  printed in the assertion error so you can see which scenario regressed.

## Cleanup guarantee

Teardown runs in a `finally` block even when a scenario fails: the daemon is
stopped, the `ws` and `http` servers are closed, and the temporary workspace
and Workflow-store directories (created under the OS temp dir) are removed. No ports, timers, or
disk artifacts are left behind, and the working tree is never modified.

## Calling it directly

The harness is also exported as a function for programmatic use:

```ts
import {runLiveTransportHarness} from './liveTransportHarness';

for (const hubProtocol of ['legacy', 'canonical'] as const) {
	const result = await runLiveTransportHarness({hubProtocol});
	if (!result.ok) {
		for (const check of result.checks) {
			console.log(
				`${check.status.toUpperCase()} ${check.label}: ${check.message}`,
			);
		}
		process.exitCode = 1;
	}
}
```
