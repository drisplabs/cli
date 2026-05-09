# Remote-Runtime "Pair Once, Dashboard-Spawned Headless Sessions" — CLI Plan

**Repo:** `~/athena/cli`
**Companion plan:** `~/athena/dashboard/docs/superpowers/plans/2026-05-09-remote-runtime-daemon-ux.md`
**Status:** planning only. No code changes are blessed by this document.

## 1. Context & Problem Statement

A user who wants the dashboard to drive a remote machine today has to understand all of: pairing tokens, runner binding, `dashboard connect`, the gateway plane, the console sidecar, console UI tokens, and local dev origins. The dashboard then dispatches runs to a foreground CLI process the user has to keep alive.

We want one pairing command that leaves the machine ready for dashboard-triggered runs:

1. User opens runner settings in the dashboard.
2. User clicks **Add instance**.
3. Dashboard shows a single line: `drisp dashboard pair <token> [--url <origin>]`.
4. CLI pairs, binds the runner, installs/starts a background runtime daemon, verifies the socket is connected, and exits.
5. User clicks **Run** in the dashboard.
6. Dashboard dispatches the run to the paired machine.
7. Local daemon receives the assignment, spawns a headless Athena/Drisp session, streams `run_event` frames back, handles cancel/timeout.
8. User never opens the local TUI, never runs `dashboard connect`, never edits a sidecar, never thinks about the gateway.

Console (the human-in-the-loop UI tab) stays optional, on a separate plane, gated behind an opinionated `dashboard console enable` command.

### Why this plan exists at all

A previous attempt skipped this planning step and shipped ~290 LOC of CLI implementation as commit **`fd71141 feat: implement remote runtime daemon pairing UX`** _before_ the design was agreed. That commit is treated here as a **committed prototype**, not as Phase 1. The gaps listed in §11 are open work items that need to be closed (in the same branch or via revert + re-implement) before Phase 1 ships.

## 2. Architecture Summary

```
                ┌──────────────────────────────────────────────┐
                │   Dashboard                                  │
                │  ┌────────────────┐    ┌────────────────┐    │
                │  │ Runner setting │    │  Run page UI   │    │
                │  │   (Add inst.)  │    │  (click Run)   │    │
                │  └────────┬───────┘    └────────┬───────┘    │
                │           │                     │            │
                │           ▼                     ▼            │
                │  /api/instances/pair    runs.dispatchManual  │
                │           │                     │            │
                │           │            runRemoteDispatch     │
                │           │                     │            │
                │           │            POST /internal/       │
                │           │            instances/:id/dispatch│
                │           │                     │            │
                │           │             InstanceSocketDO     │
                │           │           (queue+drain+cancel)   │
                └───────────┼─────────────────────┼────────────┘
                            │ refreshToken        │ WSS frames
                            │                     │ (job_assignment,
                            ▼                     │  cancel)
                  ~/.config/athena/                │
                    dashboard.json                 │
                            ▲                     │
                            │ shared file lock    │
                            │                     ▼
                            │           ┌─────────────────────┐
                            │           │  Runtime daemon     │
                            │           │  (long-running,     │
                            │           │   autostarted)      │
                            │           │                     │
                            │           │  • refresh @ T-60s  │
                            │           │  • per-run Abort    │
                            │           │  • exec headless    │
                            │           └─────────┬───────────┘
                            │                     │ runExec
                            │                     │  (onPermission:'fail')
                            │                     ▼
                            │           Athena/Drisp session
                            │           (no TUI, JSON events)
                            │                     │
                            │                     │ run_event frames
                            │                     │ back over same WSS
                            └─────────────────────┘
```

- **Pair response** carries enough context to bind a runner and start the daemon: `instanceId`, `refreshToken`, `runners[]` (with `executionTarget`/`remoteInstanceId`), and dashboard capability ack including `requiredCliVersion`.
- **Daemon** is a single long-running node process, no React/Ink/SQLite, that holds the InstanceSocket open, refreshes proactively, executes job assignments through the existing `executeRemoteAssignment` path, and streams events back.
- **Dashboard's InstanceSocketDO** is the source of truth for "runtime online"; it already queues offline assignments and drains on reconnect, so the daemon does **not** need a local queue.
- **Console plane** (`ConsoleBrokerDO`, `~/.config/athena/channels/console.json`) is wired separately and only when the user runs `dashboard console enable`.

## 3. Current-State Map (file:line)

### CLI (`~/athena/cli`)

| Concern                                                                  | Location                                                                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Pair handler                                                             | `src/app/entry/dashboardCommand.ts:202-331`                                                    |
| Config write (atomic, mode 0600)                                         | `src/infra/config/dashboardClient.ts:67-107`                                                   |
| Fingerprint computation                                                  | `src/app/entry/dashboardCommand.ts:156-164`                                                    |
| Refresh + cross-process file lock                                        | `src/infra/config/dashboardAuth.ts:46-196`                                                     |
| `dashboard connect` (single-shot)                                        | `src/app/entry/dashboardCommand.ts:470-580`                                                    |
| `dashboard doctor [--runner]`                                            | `src/app/entry/dashboardCommand.ts:582-772`                                                    |
| `dashboard console link`                                                 | `src/app/entry/dashboardCommand.ts:774-890`                                                    |
| `executeRemoteAssignment` (now accepts `abortSignal`)                    | `src/app/dashboard/remoteRunExecutor.ts:138-310`                                               |
| `runExec` abort listener                                                 | `src/app/exec/runner.ts:213-223` (calls `registerFailure`/`sessionController.kill()` on abort) |
| InstanceSocket client (subprotocol auth, 30s heartbeat)                  | `src/app/dashboard/instanceSocketClient.ts`                                                    |
| Frame types                                                              | `src/app/dashboard/instanceSocketClient.ts:12-19`                                              |
| **Committed prototype daemon** (commit `fd71141`)                        | `src/app/dashboard/runtimeDaemon.ts:51-176`                                                    |
| **Committed prototype `dashboard daemon foreground`** (commit `fd71141`) | `src/app/entry/dashboardCommand.ts:426-468`                                                    |
| Capability field sent on pair (currently `version`, see §11)             | `src/app/entry/dashboardCommand.ts:232-237`                                                    |

### Dashboard (`~/athena/dashboard`) — for cross-reference

| Concern                             | Location                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Pairing token mint                  | `convex/instances.ts:70-96` (`createPairing`)                                                           |
| Pair endpoint                       | `src/lib/api/instances-api.ts:45-57` → `consumePairing` `convex/instances.ts:141-219`                   |
| Auto-bind runner on pair            | `convex/instances.ts:191-204` (already does this when `runnerId` passed)                                |
| Refresh endpoint                    | `src/lib/api/instances-api.ts:59-71` → `rotateRefresh` `convex/instances.ts:221-262`                    |
| Runner GET endpoint                 | `src/lib/api/instances-api.ts:73-118` (`handleRunnerStatus`)                                            |
| Remote dispatch                     | `convex/runs/dispatch.ts:159-273` (`runRemoteDispatch`)                                                 |
| InstanceSocketDO queue/drain/cancel | `src/lib/durable-objects/instance-socket-do.ts:139-221`                                                 |
| Console plane                       | `src/lib/api/console-api.ts`, `src/lib/durable-objects/console-broker-do.ts`, `convex/console.ts:71-88` |
| Pairing dialog UI                   | `src/components/instances/pairing-dialog.tsx`                                                           |
| Runner settings page                | `src/routes/app.runners.$runnerId.settings.tsx:106-180`                                                 |

### Existing CLI plans of interest

- `docs/plans/2026-05-04-dashboard-pair-cli-plan.md` — original `dashboard` command-group landing plan.
- `docs/plans/2026-05-02-remote-gateway-plan.md` — gateway transport extraction (UDS→WS).
- `docs/plans/2026-05-04-console-channel-adapter-plan.md` — console adapter design (separate plane).
- `docs/plans/2026-05-04-gateway-boundary-cleanup-plan.md` — app↔gateway boundary tightening.

## 3a. Prerequisite Checklists

### Dashboard prerequisites (must land before CLI Phase 1 is considered green)

- [ ] Pair-response: add `requiredCliVersion: string` (informational, CLI warns on mismatch).
- [ ] Pair-response: add `capabilityAck: { runtimeDaemon, consoleAdapter, instanceSocket }` echoing server-supported capabilities.
- [ ] Pair-response: confirm shape of `runners[]` (already present at `convex/instances.ts:191-204`); document that `accessToken`/`expiresInSec` are NOT returned by pair, only by refresh (`convex/http.ts:324-329`).
- [ ] InstanceSocketDO `handleCancel` purges any matching pending assignment from the queue when the socket is offline (see §6.cancel-while-offline).
- [ ] InstanceSocketDO `drainPending` revalidates each queued assignment's run status before sending (skips if status is `cancelled`/`failed`/`succeeded`).
- [ ] Run-page UI copy distinguishes "queued: awaiting_instance" from "internal error" (renders "Waiting for runtime daemon").
- [ ] Pairing-dialog UI surfaces a single command with a copy button.
- [ ] `consumePairing` accepts both `capabilities.version` (legacy) and `capabilities.cliVersion` (new) for one CLI release window — see §11.
- [ ] Optional: pair-response includes `dashboardOrigin` so a future CLI release can drop `--url`.
- [ ] Phase 2: `GET /api/instances/:id/active-runs` (daemon crash recovery).
- [ ] Phase 2: `POST /api/instances/:id/revoke` (`unpair`).
- [ ] Phase 2: distinct "runtime online" / "console connected" pills.

### CLI prerequisites

- [ ] Daemon process model finalised (separate `dist/dashboard-daemon.js` entry, no React/Ink/SQLite).
- [ ] Daemon state directory `~/.local/state/drisp/` (XDG) with `.pid`/`.log`/`.sock` files at 0600.
- [ ] Refresh-token sharing strategy locked: daemon reuses `refreshDashboardAccessToken` (`src/infra/config/dashboardAuth.ts:46`) so the existing file lock serializes refreshes across daemon and foreground commands.
- [ ] Proactive refresh at `expiresInSec - 60` with circuit breaker (5 failures / 5 minutes) on persistent 401.
- [ ] Capability field renamed `version` → `cliVersion` in `pair` request body (`dashboardCommand.ts:232-237`) **after** dashboard accepts both.
- [ ] PID-file exclusive lock at `~/.local/state/drisp/dashboard-daemon.pid` to prevent duplicate daemons.
- [ ] `unpair` wired to stop daemon → revoke server-side → remove credentials.
- [ ] `dashboard connect` converted to a deprecation alias that prints a notice and execs `daemon foreground`.
- [ ] CLI entry path resolved via `fileURLToPath(import.meta.url)` instead of `process.argv[1]`.
- [ ] Daemon spawn passes a whitelisted env, not `process.env`.
- [ ] Concurrency cap (`MAX_CONCURRENT_RUNS`, default 1) honored; over-cap assignments rejected with `run_event kind:'rejected'`.
- [ ] Cancel path verified: each harness adapter's `sessionController.kill()` is safe before the controller has started.
- [ ] Tests in §10 added (or the prototype's tests reworked accordingly).
- [ ] Decision recorded: rework the `fd71141` prototype in-place, or revert and re-implement.

## 4. Target UX

```
$ drisp dashboard pair pair_x9k4… --url https://drisp.ai
dashboard: paired to https://drisp.ai as inst_abc123
dashboard: bound runner Nightly QA (runner_42)
dashboard: runtime daemon installed (~/Library/LaunchAgents/ai.drisp.daemon.plist)
dashboard: runtime daemon connected (verified socket open)
dashboard: ready. Click Run in the dashboard.
```

```
$ drisp dashboard pair pair_x9k4… --url https://drisp.ai
dashboard: re-pairing inst_abc123 (token rotated)
dashboard: runtime daemon already running, restarted with new token
dashboard: ready.
```

```
$ drisp dashboard pair pair_x9k4… --url https://drisp.ai
dashboard pair: cli version 0.6.1 is older than the dashboard's required >=0.7.0.
dashboard pair: upgrade with `npm i -g @athenaflow/cli` then re-run pair.
[exit 1]
```

```
$ drisp dashboard pair pair_x9k4… --url https://drisp.ai
dashboard: paired to https://drisp.ai as inst_abc123
dashboard: bound runner Nightly QA (runner_42)
dashboard: runtime daemon started but did not reach the socket within 10s.
dashboard pair: pairing succeeded; tail logs with `drisp dashboard logs --follow`.
[exit 0]   # pairing succeeded; daemon issue is a warning, not a failure
```

```
$ drisp dashboard status
dashboard: paired to https://drisp.ai as inst_abc123
runner:    Nightly QA (runner_42) bound to this instance
daemon:    running (pid 4123, since 2026-05-09 09:14, 2 runs completed, 0 active)
socket:    connected (last frame 12s ago)
token:     fresh, expires in 14m
```

```
$ drisp dashboard status         # daemon down
dashboard: paired to https://drisp.ai as inst_abc123
runner:    Nightly QA (runner_42) bound to this instance
daemon:    NOT running. Start it with `drisp dashboard daemon start`.
socket:    n/a
[exit 1]
```

```
$ drisp dashboard status         # runner bound elsewhere
dashboard: paired to https://drisp.ai as inst_abc123
runner:    Nightly QA (runner_42) bound to inst_xyz789 (NOT this machine)
daemon:    running but will not receive runs for runner_42.
[exit 1]
```

```
$ drisp dashboard runs --active
runId       runner       started        seq    status
run_77      runner_42    12s ago        184    running
```

```
$ drisp dashboard logs --tail 5 --follow
2026-05-09T09:14:02 INFO  socket connected as inst_abc123
2026-05-09T09:14:31 INFO  job_assignment runId=run_77
2026-05-09T09:14:31 INFO  exec.start runId=run_77
…
```

```
# Dashboard click "Run" while daemon offline
[Run page UI] Waiting for runtime daemon (paired machine appears offline).
              The run will start automatically when the daemon reconnects.
```

```
# Dashboard click "Cancel" mid-run
$ drisp dashboard logs
2026-05-09T09:14:53 INFO  cancel frame for runId=run_77
2026-05-09T09:14:53 INFO  exec aborted (signal=SIGTERM, runId=run_77)
2026-05-09T09:14:54 INFO  run_event runId=run_77 kind=error message=Execution cancelled.
```

```
# Pair from generic Instances page (no runner_id was attached to the token)
$ drisp dashboard pair pair_x9k4… --url https://drisp.ai
dashboard: paired to https://drisp.ai as inst_abc123
dashboard: no runner bound to this pairing token.
dashboard: bind a runner from runner settings, then this machine will receive its runs.
dashboard: runtime daemon connected (verified socket open)
dashboard: ready (no runs will arrive until you bind a runner).
```

```
# Pair token whose runner is already bound to a different machine
$ drisp dashboard pair pair_x9k4… --url https://drisp.ai
dashboard: paired to https://drisp.ai as inst_abc123
dashboard: rebinding runner Nightly QA (runner_42) — was bound to inst_xyz789
dashboard: runtime daemon connected (verified socket open)
dashboard: ready. The other machine will stop receiving runs for runner_42.
```

```
# Dashboard click "Run" while daemon ONLINE (happy path, no terminal output)
[Run page UI] Running on Nightly QA (Mac mini, daemon online).
              ▼ Live event stream
              09:14:31  exec.start
              09:14:32  tool: bash …
              09:14:34  …
```

```
# Dashboard click "Run" while daemon OFFLINE
[Run page UI] Waiting for runtime daemon (paired machine appears offline).
              The run will start automatically when the daemon reconnects.
              [Cancel run]
```

```
$ drisp dashboard unpair          # network OK, full success
dashboard: stopping runtime daemon (pid 4123)
dashboard: revoking refresh token at https://drisp.ai
dashboard: unpaired (credentials removed, daemon stopped, autostart disabled)
```

```
$ drisp dashboard unpair          # server unreachable, partial success
dashboard: stopping runtime daemon (pid 4123)
dashboard: revoke failed: could not reach https://drisp.ai (network error)
dashboard: removed local credentials and stopped daemon anyway.
dashboard: WARNING — refresh token may still be valid until you revoke it from the dashboard UI.
[exit 0]   # local state is consistent; warn user
```

```
$ drisp dashboard unpair          # daemon already stopped
dashboard: runtime daemon not running (skipping stop)
dashboard: revoking refresh token at https://drisp.ai
dashboard: unpaired (credentials removed, autostart disabled)
```

```
$ drisp dashboard unpair          # not paired
dashboard unpair: not paired (nothing to do)
[exit 0]
```

## 5. CLI Command Model

### User-facing

| Command                                                      | Behavior                                                                                                                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drisp dashboard pair <token> [--url <origin>] [--name <n>]` | POST `/api/instances/pair`, persist refresh token at `0600`, parse `runners[]`, install/start daemon, **probe socket** (max 10s), print verified status. |
| `drisp dashboard status`                                     | Print pairing state, runner binding, daemon process state (PID/uptime/active runs), socket health, token freshness. Non-zero on any unhealthy axis.      |
| `drisp dashboard logs [--tail N] [--follow]`                 | Tail `~/.local/state/drisp/dashboard-daemon.log`.                                                                                                        |
| `drisp dashboard runs [--active] [--limit N]`                | List runs the daemon has handled (in-memory ring buffer or sqlite — see §6).                                                                             |
| `drisp dashboard unpair`                                     | Stop daemon → disable autostart → revoke refresh token via dashboard → remove `dashboard.json`. Best-effort but reports each step's status.              |
| `drisp dashboard console enable <runnerId>`                  | Opinionated wrapper: writes `console.json`, reloads gateway. Replaces today's `dashboard console link` for normal users.                                 |

### Hidden / debug

| Command                                               | Behavior                                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `drisp dashboard daemon start\|stop\|restart\|reload` | Local IPC against daemon UDS.                                                                       |
| `drisp dashboard daemon foreground`                   | Run daemon in foreground (process supervisors, debugging). Already prototyped.                      |
| `drisp dashboard refresh`                             | Manual token refresh (existing).                                                                    |
| `drisp dashboard doctor [--runner <id>]`              | Existing health-check command, unchanged.                                                           |
| `drisp dashboard connect`                             | **Deprecated alias.** Prints "deprecated, use `daemon foreground`", then execs `daemon foreground`. |
| `drisp dashboard console link <runnerId>`             | Existing primitive, unchanged but no longer the recommended path.                                   |

## 6. Daemon Architecture

### Process model

- Single long-running node process. No React, no Ink, no SQLite (the dashboard owns persistence).
- Started by launchd (macOS) or systemd user unit (linux); `nohup` fallback on unsupported platforms.
- Its own bundled entry: a new `tsup` entry `src/app/entry/dashboardDaemon.ts` → `dist/dashboard-daemon.js` so the executable is small and excludes React/Ink/SQLite from its bundle.

### Files / paths

- Credentials: `~/.config/athena/dashboard.json` (already exists, mode 0600). Unchanged.
- Daemon state dir: `~/.local/state/drisp/` (XDG) — created mode 0700.
  - `dashboard-daemon.pid` — exclusive-lock-based PID file. Write+lock+truncate; lock released on exit.
  - `dashboard-daemon.log` — append-only, rotating at 5MB × 5 files.
  - `dashboard-daemon.sock` — local UDS for `status`/`logs`/`stop`/`restart`/`reload` IPC. Mode 0600.
- launchd plist: `~/Library/LaunchAgents/ai.drisp.daemon.plist` — `KeepAlive`, `RunAtLoad`, `WorkingDirectory=$HOME`, `StandardOutPath`/`ErrorPath` to log file. **Not loaded** until `pair` confirms user consent.
- systemd unit: `~/.config/systemd/user/drisp-daemon.service` — `Restart=always`, `WantedBy=default.target`.

### Token strategy

- Reuse `refreshDashboardAccessToken` (`src/infra/config/dashboardAuth.ts:46`) so the daemon and any foreground CLI command share the same lock at `~/.config/athena/dashboard.json.lock`.
- Schedule a refresh at `expiresInSec - 60`. On a 401 from socket connect, force-refresh-and-retry once; if that 401s too, treat as fatal pairing failure (likely revoked) and exit, letting the supervisor restart-loop until the user re-pairs.
- Circuit-break: after 5 consecutive refresh failures within 5 minutes, sleep 5 minutes before retrying — refresh tokens are single-use, a tight loop will burn rotation history.

### WebSocket reconnect

- Existing `runtimeDaemon.ts:42` backoff `[1s, 2s, 5s, 10s, 30s]` is fine. Reset to 0 on successful connect.
- When the dashboard disconnects with a `cancel` reason or 4xx-equivalent close code, surface as fatal (don't reconnect tightly).

### Assignment flow

- Dashboard already queues offline (`instance-socket-do.ts:153-158`) and drains on reconnect (`:199-221`). The daemon never needs its own queue.
- Per-runId `AbortController` map already in `runtimeDaemon.ts:75`. Add a `MAX_CONCURRENT_RUNS` cap (default 1, configurable via `~/.config/athena/dashboard.json` `daemon.concurrency` key). When at cap, send a `run_event` `kind:'rejected'` frame and skip exec.
- Headless exec: existing path through `executeRemoteAssignment` → `runExec` with `onPermission:'fail'`, `onQuestion:'fail'`, `signal: abortSignal`, `verbose:false`, `ephemeral:false`, `json:true`.
- Cancellation: `cancel` frame → `controller.abort()` → `runExec`'s abort listener calls `registerFailure({kind:'process', message:'Execution cancelled.'})` which calls `sessionController.kill()` (`runner.ts:202-211`). **Confirm in each harness adapter that `kill()` is safe before the controller has started.**
- Crash recovery: Phase 1 — none. The daemon dies, the dashboard's run-lease expires, the run is marked failed. Phase 2 adds startup reconciliation via a new `GET /api/instances/:id/active-runs` endpoint.

### `runs` data

- In-memory ring buffer (last 100 runs). `dashboard runs` queries the daemon via UDS. No on-disk persistence in Phase 1.

### Version compatibility

- CLI sends `capabilities.runtimeDaemon: true` and `capabilities.cliVersion: <pkg.version>` on `pair`.
- Dashboard pair response includes `requiredCliVersion`. CLI compares with semver; if local is older, refuse to install the daemon and print upgrade instructions.

### Security boundaries

- All daemon-owned files are 0600, parent dirs 0700.
- Daemon does not bind any inbound TCP. Only outbound WSS to the pinned `dashboardUrl` (no redirect-following to a different origin).
- Local UDS only accepts the calling user (Unix file permissions); messages have a short JSON shape (`{cmd: 'status'|'stop'|'restart'|'reload'|'runs'}`) and the daemon validates each.
- `runSpec` validation: require `prompt` (string, non-empty), reject unknown top-level keys, no shell-injection through env (env vars are passed only to `runExec` which already sanitizes).
- Logs redact any string matching `(access|refresh)?_?token`, `Bearer …`, `Sec-WebSocket-Protocol: …`.

## 7. Cross-Repo Handoff (CLI ↔ Dashboard)

The CLI plan assumes the dashboard provides:

1. **Pair endpoint response** with `runners[]` (✅ already), plus new `requiredCliVersion: string` and (optional) `dashboardOrigin: string` so future CLI versions can drop `--url`.
2. **`GET /api/runners/:id`** returning `{executionTarget, remoteInstanceId}` (✅ already at `instances-api.ts:73-118`).
3. **Pair endpoint** echoes a `capabilityAck` object listing which client capabilities the dashboard recognised, so a too-old CLI sending unknown flags learns about it.
4. **Run-page UI copy** distinguishes "queued: awaiting instance" from "internal error".
5. **Phase 2:** new endpoints `GET /api/instances/:id/active-runs` (crash recovery) and `POST /api/instances/:id/revoke` (used by `unpair`).
6. **Phase 2:** distinct UI badges for "runtime online" (InstanceSocketDO) vs "console connected" (ConsoleBrokerDO).

Conversely, the CLI commits to:

- Sending `capabilities.runtimeDaemon` (already done in commit `fd71141`).
- Sending `capabilities.cliVersion` — **note:** the prototype currently sends `capabilities.version` (`dashboardCommand.ts:232-237`). Phase 1 renames the field to `cliVersion`; the dashboard accepts both for one release before dropping `version`.
- Using subprotocol auth on the InstanceSocket (already done).
- Sending `assignment_accepted` exactly once per `job_assignment` (already done in `instanceSocketClient.ts:139`).
- Streaming `run_event` frames with monotonically increasing `seq`.
- `unpair`: revoke server-side (Phase 2 endpoint), then delete local credentials.

## 8. Backward Compatibility & Migration

- **Already-paired instances:** nothing breaks. Refresh tokens still work. Next `dashboard pair` (re-pair) opts them into the daemon.
- **Users using `dashboard connect`:** keeps working but prints a deprecation note and execs `daemon foreground`. Power-users who run it under their own supervisor are unaffected.
- **Existing `console.json` sidecars:** untouched. `dashboard console link` keeps working. `dashboard console enable` is the new opinionated wrapper.
- **Old CLI + new dashboard:** pair response with new fields is forward-compatible (CLI ignores unknown fields). Old CLI omits `runtimeDaemon` capability; dashboard treats those instances as "manual connect required" and shows that on the run page.
- **New CLI + old dashboard:** pair succeeds; if `requiredCliVersion` or `capabilityAck` is missing, CLI prints a non-fatal warning and proceeds.

## 9. Security & Safety

- Token storage permissions enforced (already 0600 on `dashboard.json`).
- Daemon attack surface: outbound-only WSS, no TCP listener, UDS at 0600.
- Public-tunnel/local-dev: dashboard origin pinned at pair time, daemon refuses redirects to a different origin.
- Pairing token: ephemeral, single-use, short TTL; never logged, never echoed.
- Malicious dashboard: `runSpec` validated; `onPermission:'fail'` blocks any tool the workflow author didn't pre-approve; no shell escape from env.
- Logs: redact tokens.
- `unpair`: server revoke first, then local removal. If revoke fails (network), continue with local removal but warn.

## 10. Testing Plan

### CLI tests (vitest, DI fakes — pattern from `runtimeDaemon.test.ts`, `dashboardCommand.test.ts`)

| #   | Test                                                                                               |
| --- | -------------------------------------------------------------------------------------------------- |
| 1   | `pair` happy path: starts daemon, probes socket, reports verified connection                       |
| 2   | `pair` writes config atomically (temp + rename) and at mode 0600                                   |
| 3   | `pair` is idempotent (re-pair restarts daemon with new token)                                      |
| 4   | `pair` exits 0 even when daemon spawn fails (warn-only) — currently broken                         |
| 5   | `pair` with too-old CLI vs `requiredCliVersion` exits 1 with upgrade message                       |
| 6   | `pair` rejects `--url` mismatch with previously paired origin                                      |
| 7   | Daemon connects and reconnects (already covered in `runtimeDaemon.test.ts`)                        |
| 8   | Daemon refreshes token at `expiresInSec - 60` (new)                                                |
| 9   | Daemon respects `MAX_CONCURRENT_RUNS`; N+1 assignment yields `kind:'rejected'`                     |
| 10  | Job assignment invokes `runExec` with `onPermission:'fail'`, `onQuestion:'fail'`, abortable signal |
| 11  | Duplicate `job_assignment` for same `runId` does NOT duplicate execution (already covered)         |
| 12  | `run_event` frames have monotonically increasing `seq`                                             |
| 13  | `cancel` frame mid-run aborts the session and emits a `kind:'error'` frame within 2s               |
| 14  | Daemon "already running" guard: second `pair` reuses existing daemon (PID file lock)               |
| 15  | `unpair` stops daemon, revokes server-side, removes credentials — currently broken                 |
| 16  | `dashboard daemon foreground` subcommand wired correctly — currently untested                      |
| 17  | `dashboard daemon stop` over UDS returns 0 and the daemon exits within 5s                          |
| 18  | `dashboard status` reports daemon-down vs daemon-up vs runner-bound-elsewhere correctly            |
| 19  | `dashboard logs --tail` reads from rotating log file                                               |
| 20  | Refresh failure during reconnect: backoff increases, no tight loop                                 |
| 21  | Two concurrent assignments with different `runId`s execute in parallel (up to cap)                 |

### E2E / manual

- Fresh machine: `pair` → click Run in dashboard → headless session runs → events appear in dashboard run page.
- Cancel from dashboard: session killed within 2s; `run_event kind:'error'` arrives.
- Sleep 10 minutes / wake / next dispatch works without manual intervention.
- 30s network drop: daemon reconnects; assignments queued during drop drain on reconnect; no duplicate runs.
- `kill -9` daemon mid-run: dashboard sees lease expire, run marked failed; restarted daemon picks up next assignment cleanly.
- Console feature still optional and independent: enabling it does not affect normal dispatch.

## 11. Status of the Existing Committed Code (prototype, not Phase 1)

Commit **`fd71141 feat: implement remote runtime daemon pairing UX`** on `main` shipped the prototype before this plan was written: `runtimeDaemon.ts`, `runtimeDaemon.test.ts`, the `dashboard daemon foreground` subcommand, abort wiring through `remoteRunExecutor.ts`/`runner.ts`/`exec/types.ts`, and a `capabilities.runtimeDaemon` field on the pair request. This plan does **not** bless that commit as the Phase-1 deliverable. The gaps below must be closed (in a follow-up commit, by reverting `fd71141` and re-implementing, or by amending the unreleased branch) before Phase 1 is considered started. The plan leaves the choice between _rework-in-place_ and _revert-then-rebuild_ to the reviewer.

| Gap                                                                                                                                                                        | Phase-1 fix                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultStartRuntimeDaemon` returns `ok:true, connected:false` after detached spawn (no probe, no `child.on('error')`)                                                     | Add a verify-then-return loop: poll the daemon's UDS or the dashboard's `/api/instances/:id/socket-status` until connected, max 10s                                                                                   |
| `pair` exits 1 when paired-but-daemon-failed                                                                                                                               | Exit 0 with a warning; pairing on disk is the source of truth                                                                                                                                                         |
| Daemon's refresh callback wired with `'connect'` label, ignoring the `'daemon'` label `runtimeDaemon.ts` passes                                                            | Honor the label or drop the parameter from `RunDashboardRuntimeDaemonOptions`                                                                                                                                         |
| **Capability field name mismatch:** prototype sends `capabilities.version` (`dashboardCommand.ts:232-237`), this plan and the dashboard plan say `capabilities.cliVersion` | Rename CLI to `cliVersion`; dashboard accepts both for one CLI release window before removing `version` (negotiated in companion plan). Bump CLI minor version in the same change so dashboard can detect the cutover |
| CLI entry resolved via `process.argv[1]`                                                                                                                                   | Resolve via `fileURLToPath(import.meta.url)` or a build-time injected entry path                                                                                                                                      |
| No "already running" guard                                                                                                                                                 | PID-file exclusive lock at `~/.local/state/drisp/dashboard-daemon.pid`                                                                                                                                                |
| `unpair` removes credentials but does NOT stop the daemon                                                                                                                  | Wire `unpair` to send `stop` via UDS, then revoke server-side, then remove file                                                                                                                                       |
| `dashboard connect` still overlaps `daemon foreground`                                                                                                                     | Convert `connect` into a deprecation alias                                                                                                                                                                            |
| Detached spawn passes `process.env` wholesale                                                                                                                              | Whitelist a small env: `HOME`, `PATH`, `LANG`, `XDG_*`, `ATHENA_DASHBOARD_ORIGIN` (if explicitly set)                                                                                                                 |
| CLI assumed dashboard contracts (`runners[]`, `GET /api/runners/:id`, `capabilities.runtimeDaemon`) before locking them in the dashboard plan                              | Companion plan now lists them as prerequisites — confirm landed before declaring Phase 1 done                                                                                                                         |
| Test gaps: `daemon foreground`, `pair` failure paths, "already running", refresh-fail-during-reconnect, two concurrent assignments                                         | Add per §10                                                                                                                                                                                                           |

## 12. Phased Rollout

### Phase 1 — Daemonized remote runs, no console dependency

- Reconcile prototype against this plan (or revert) (§11).
- `pair` verifies daemon connection before reporting success; warn-not-fail on daemon-only failure.
- `unpair` stops daemon + revokes server token + removes credentials.
- `dashboard status`, `dashboard logs`, `dashboard runs`.
- Idempotent re-pair.
- "Already running" guard via PID file.
- All Phase-1 tests in §10.

### Phase 2 — Service install / autostart, robust lifecycle

- launchd plist + systemd user unit, generated by `pair` with explicit user prompt.
- UDS IPC: `daemon stop|restart|reload|status|runs`.
- Crash recovery via `GET /api/instances/:id/active-runs`.
- Refresh-token revoke on `unpair` via `POST /api/instances/:id/revoke`.

### Phase 3 — Optional console & cleanup

- `dashboard console enable <runnerId>` opinionated wrapper.
- Hide `dashboard connect` (deprecation print + exec daemon foreground).
- Deprecate manual `dashboard console link` once `enable` is stable.
- Cleanup gateway-only paths no longer needed for normal users.

## 13. Risks & Open Questions

**Risks**

- Daemon detached spawn from `pair` races with parent exit. Verify-then-return pattern is the mitigation.
- launchd/systemd install needs user-shell context; `pair` over SSH may need a fallback (manual `nohup` install).
- File-lock contention on slow disks; existing 30s `withLock` timeout is enough but worth noting in the daemon log.
- Concurrent re-pair from two terminals can spawn overlapping daemons; PID-file exclusive lock mitigates.
- Token-refresh tight loop on persistent 401 — circuit-break at 5 failures/5 min.

**Open questions**

- Should the pair token encode the dashboard origin so `--url` becomes optional? (Pair UI could embed a base64'd origin in the token; CLI splits, validates against the URL the user opened.)
- Multi-org account: one machine paired to two orgs simultaneously? Phase 1 says no — one config slot.
- Default `MAX_CONCURRENT_RUNS`: 1, or follow runner's dashboard-side `concurrencyCap`?
- Log rotation: 5×5MB, or larger? Disk-cheap defaults are fine but document it.
- `unpair` — server revoke synchronous (block on success) or fire-and-forget?

## 14. Verification of This Plan

- `ls ~/athena/cli/docs/plans/2026-05-09-remote-runtime-daemon-ux.md` returns this file.
- `ls ~/athena/dashboard/docs/superpowers/plans/2026-05-09-remote-runtime-daemon-ux.md` returns the companion file.
- Each file's "Cross-Repo Handoff" section names the other.
- Spot-check 5 random file:line citations against current code.
- No source files modified, no tests run, no commits made as part of writing this plan.
