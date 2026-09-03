# ADR 0017 - One runner process, one runner.db, a pid file instead of a control socket

Status: Active
Date: 2026-09-03
Relates to: ADR 0001 (the dashboard runtime daemon owns paired execution), ADR 0006 (one owner
for a database, a shared versioned-open primitive)

## Context

The machine side of the runner ↔ hub protocol was the **dashboard daemon**: `drisp dashboard
daemon start|stop|foreground` around `runtimeDaemon.ts`, with

- two standalone SQLite files in the state dir, `dashboard-feed-outbox.db` (the durable feed
  queue the paired feed publisher drains) and `dashboard-decision-inbox.db` (the hub's answers
  waiting for a local Run) — two owners, two open paths, both versionless (ADR 0006 §2);
- a **control socket** (`dashboard-daemon.sock`, a length-prefixed JSON protocol over UDS) that
  `dashboard status|runs|stop|restart|reload` spoke to, next to the pid file that already said
  whether the daemon was alive;
- a name that described the hub it talks to rather than what it is. The glossary already called
  the component that drives a Workflow Run the **Runner**; the process that hosts it was "the
  daemon".

The control socket was a second transport with its own framing, its own stale-socket handling,
and its own failure modes (a live listener at the path aborts startup; a client timeout reads as
"not running"), for two read-mostly queries and a stop that a signal delivers just as well.

## Decision

**1. One process, named for what it is: `drisp runner`.** `startRunnerProcess`
(`src/app/runner/runnerProcess.ts`) is the process: it takes the log file, the pid file,
`runner.db`, the instance-socket runtime (`runtimeDaemon.ts`, unchanged in ownership per ADR
0001), and the status file, in that order, and releases them in reverse. The foreground
`drisp runner` and the detached entry (`dist/runner.js`, the `drisp-runner` bin, what the service
unit runs) run exactly this. Events leave the machine only over the instance socket. `drisp
dashboard` is a deprecated alias for one release (removed in 0.7.0), as is the
`drisp-dashboard-daemon` bin / `dist/dashboard-daemon.js` entry, so a service unit written before
0.6 keeps starting the runner.

**2. One `runner.db`, versioned, one owner.** `openRunnerDb` (`src/app/runner/runnerDb.ts`) owns
the schema: `dashboard_feed_outbox` and `dashboard_decision_inbox`, each with the exact shape it
had in its standalone file, under a `schema_version` guard (`RUNNER_DB_SCHEMA_VERSION = 1`) through
the ADR 0006 primitive. The runner opens the file once and hands the handle to
`createDashboardFeedOutbox({db})` and `createDashboardDecisionInbox({db})`; closing a sharer
leaves the owner's handle open. A local `drisp run` or the interactive TUI, which enqueue feed
events and drain decisions with no runner in the process, open their own handle to the same file
(WAL) — the shared-open pattern. Per-session data (`session.db`, `feed_events`, `runtime_events`)
stays per session.

**Migration, once and idempotent.** On every open, a legacy file found beside `runner.db` is
attached, its rows copied with `INSERT OR IGNORE` and their ids kept (delivery sequence numbers
are the feed ack key and the hub's `feedSeq` ordering; inbox ids are what `markConsumed` names),
and the file removed with its `-wal` / `-shm`. A second open finds nothing to import; a legacy
file that reappears cannot double rows (the unique keys reject them); an unreadable legacy file
is left in place and reported, and the runner still starts. The inbox's oldest shape (a full
`UNIQUE(athena_session_id, request_id)`) imports into the partial-index table without the
in-place `ALTER` the inbox used to carry.

**3. A pid file and a status file instead of the control socket.** `runner.pid` (`pidLock.ts`)
is liveness and the single-instance lock: a second `drisp runner` on the same machine exits
non-zero with `already running (pid N)`; a dead pid is reaped on the next start; the pre-runner
`dashboard-daemon.pid` counts for one release, and its socket file is removed. `runner.status.json`
(`runnerStatusFile.ts`) is how the snapshot gets out without a socket: the runner rewrites it
atomically (temp file, fsync, rename) whenever the snapshot changes — checked on a one-second
interval and forced on start — and removes it on a clean stop. `drisp runner status` and `runs`
read it beside the pid file; the pid file stays the liveness authority, so a status file whose
pid is not the live pid is stale and ignored. `drisp runner stop` sends SIGTERM to the pid and
waits for the pid file to be released. `src/infra/daemon/udsIpc.ts` and `udsFrameCodec.ts` are
deleted.

## Consequences

Positive:

- One owner for the runner's durable state, one open path, one schema version; the outbox and
  the inbox can be inspected and migrated together.
- Crash recovery is a property of the file, not of a process: the live-transport harness kills a
  runner mid-Run and shows the restart draining the outbox and re-delivering the pending decision.
- No second transport: the runner's failure modes are the instance socket's, and "is it running"
  is one `kill(pid, 0)`.
- The process and the glossary term line up: the **Runner process** hosts the **Runner**.

Negative / costs:

- The status file is a snapshot, not a query: `status` is at most one interval stale, and a
  reader sees the last written state of a runner that was killed until the next runner overwrites
  it (the pid check keeps that from being reported as live).
- Two bundled entries and two bins for one release, so an old service unit keeps working.
- The migration reads the legacy files with `ATTACH`, so they must be readable SQLite files; a
  corrupt one is reported rather than repaired.

## Rejected alternatives

- **Keep the control socket for `status` / `runs`.** Rejected: it is a second transport with
  its own protocol for two read-mostly queries; a file the runner already knows how to write
  covers them, and a signal covers `stop`.
- **A `runner_runs` table in `runner.db` for the run records.** Rejected for now: the daemon never
  persisted them (an in-memory ring of 100), and the status file already carries the ring; a table
  would turn a snapshot into a second store to keep consistent. Revisit if the hub needs run
  history to survive a restart.
- **Keep the two files and only rename the command.** Rejected: two owners of two versionless
  files is the ADR 0006 §2 exception this ADR closes, and one file is what makes "drains and
  re-delivers on restart" one invariant.

## References

- `src/app/runner/runnerProcess.ts`, `runnerDb.ts`, `runnerStatusFile.ts`
- `src/app/entry/runnerCommand.ts`, `runnerDaemon.ts`; `dashboardCommand.ts` (the alias)
- `src/infra/daemon/pidLock.ts`, `stateDir.ts`
- `src/app/dashboard/liveTransportHarness.ts` (`runRunnerRecoveryHarness`)
- `UBIQUITOUS_LANGUAGE.md` — Runner process, Runner pid file, Runner status file, `runner.db`,
  Deprecated names
