# ADR 0001 - Dashboard runtime daemon owns paired execution

Status: Active
Date: 2026-05-10
Updated: 2026-05-17

## Context

Drisp pairs one local CLI instance with a dashboard. The dashboard owns the
Attachment list and the CLI mirrors that list locally at
`~/.config/athena/attachments.json`.

The paired instance has four local responsibilities:

- keep the dashboard instance socket connected and refreshed;
- mirror dashboard-owned Attachments from `attachments.changed` frames;
- publish canonical `FeedEvent` envelopes to the dashboard through the durable
  feed outbox;
- launch dashboard-requested assignments through the same `runExec` path used
  by local exec.

The codebase previously contained a competing process-per-Attachment supervisor
proposal. That model embedded the gateway, opened the instance socket, registered
runner adapters, and spawned one child process per Attachment. It made
Attachment routing a gateway concern while the shipped dashboard daemon kept
socket health, feed sync, decision inbox, and assignment execution in
`runtimeDaemon`.

## Decision

The dashboard runtime daemon is the canonical module for dashboard-paired
execution.

`src/app/dashboard/runtimeDaemon.ts` owns the instance socket lifecycle, token
refresh, attachment mirror updates, feed outbox draining, dashboard decision
inbox integration, and dashboard assignment dispatch. Assignment execution stays
inside `src/app/dashboard/dashboardPairedExecution.ts`, which launches work via
`executeRemoteAssignment` and therefore the same `runExec` path as local exec.

The process-per-Attachment supervisor and gateway runner-adapter path is not an
active architecture. It is removed from the build and source tree rather than
left as a second executable story.

Gateway `attachmentId` routing remains in place for channel sidecars and future
multi-runtime work, but it is not the owner of dashboard assignment execution in
this decision.

## Consequences

Positive:

- Pairing, socket health, feed mirror updates, dashboard decisions, assignment
  scheduling, and run status live behind one runtime-daemon interface.
- Tests assert one dashboard lifecycle instead of covering two partially
  overlapping paths.
- The Attachment mirror stays dashboard-owned and CLI-read-only, matching the
  domain model in `CONTEXT.md`.
- `runExec` remains the single execution module for local and dashboard-launched
  work.

Negative / costs:

- The CLI still has one local dashboard assignment execution owner. True
  process-per-Attachment parallelism would require reopening this ADR.
- Gateway multi-runtime support is retained only as routing substrate for
  channel sidecars and future work, not as a dashboard assignment scheduler.

## Rejected Alternative - Attachment supervisor

The previous ADR text selected a process-per-Attachment supervisor:

- one embedded gateway;
- one runner adapter per Attachment;
- one child harness process per Attachment;
- dashboard instance-socket frames translated into gateway dispatch turns.

That shape is rejected for the current codebase because it duplicates the
runtime daemon's socket lifecycle, assignment scheduling, and dashboard run
status responsibilities. Keeping both modules active makes the seam shallow:
callers and tests must know which dashboard lifecycle is in force before they
can reason about an Attachment.

Reopen this ADR if the product requirement changes from "one paired CLI executes
dashboard assignments through local exec" to "one paired CLI hosts multiple
isolated dashboard runtimes concurrently."

## References

- `CONTEXT.md` - Attachment, Run, Session, FeedEvent, DispatchPipeline
- `src/app/dashboard/runtimeDaemon.ts`
- `src/app/dashboard/dashboardPairedExecution.ts`
- `src/app/dashboard/remoteRunExecutor.ts`
- `src/app/entry/dashboardDaemon.ts`
