# Dashboard-Paired Single Execution Path — CLI Implementation Plan

**Repo:** `~/athena/cli`
**Companion plan:** `~/athena/dashboard/docs/plans/2026-05-12-dashboard-paired-single-execution-path-dashboard.md`
**Status:** ready for implementation

## Summary

The paired dashboard path should have one execution shape:

```text
job_assignment -> DashboardPairedExecution -> runExec -> DashboardFeedPublisher/outbox -> feed_event -> dashboard
dashboard_decision -> DashboardDecisionInbox -> runExec -> runtime.sendDecision
```

This plan keeps ADR 0001's superseding decision intact: one paired CLI instance
publishes canonical `FeedEvent` envelopes for local, resumed, and
dashboard-requested Sessions. Runner scheduling remains dashboard metadata, not a
CLI routing key for execution or feed publishing.

The goal is simplification. Add one deep Module only if it concentrates behavior
that is currently spread across the daemon and executor. Do not revive the old
gateway/supervisor model during this sweep.

## Key Changes

- Add a `DashboardPairedExecution` Module for assignment acceptance, duplicate
  and capacity rejection, cancellation, active-run tracking, decision inbox
  handoff, env overlay handoff, and invoking `executeRemoteAssignment`.
- Narrow `runtimeDaemon` to socket lifecycle, token refresh, feed outbox
  draining, attachment mirror updates, and forwarding frames into
  `DashboardPairedExecution`.
- Add `dashboardDecisionInbox` support to `ExecRunOptions`; `runExec` polls it
  for the active `athenaSessionId` and calls `runtime.sendDecision(requestId,
decision)`.
- Change `DashboardDecisionInbox.enqueue` to upsert unconsumed decisions by
  `(athenaSessionId, requestId)` so dashboard replacement decisions are not lost.
- Remove `withEnv` and pass runSpec env through the existing harness env path.
  Prefer merging it into the resolved workflow env before calling `runExec`,
  because both Claude and Codex adapters already read `workflow.env`.
- Add a CLI-local `InstanceFrame` parser/builder only if it replaces inline
  casts/builders in `InstanceSocketClient`; do not add a pass-through protocol
  wrapper.

## TDD Tasks

1. Add failing `runExec` tests proving a pending dashboard decision is sent to
   the runtime and marked consumed only after `runtime.sendDecision`.
2. Implement `dashboardDecisionInbox` polling inside `runExec`, scoped to the
   active `athenaSessionId`.
3. Add failing inbox tests proving a queued replacement decision overwrites the
   previous unconsumed decision.
4. Implement inbox upsert semantics without resurrecting consumed decisions.
5. Add failing remote assignment tests proving runSpec env does not mutate
   `process.env` and concurrent assignments keep separate env overlays.
6. Remove `withEnv`; merge per-run env into the `workflow.env` passed to
   `runExec`.
7. Add failing `DashboardPairedExecution` tests for accept, duplicate rejection,
   capacity rejection, cancel by `runId`, decision inbox forwarding, and env
   forwarding.
8. Extract assignment control from `runtimeDaemon` into
   `DashboardPairedExecution` and keep existing daemon behavior green.
9. Add frame parser tests only if they replace real inline frame knowledge in
   `InstanceSocketClient`.

## Test Plan

Run targeted tests after each red/green/refactor batch:

```bash
npm test -- src/app/exec/runner.test.ts src/app/dashboard src/app/providers --run
```

Run final CLI verification:

```bash
npm run typecheck
npm run lint
npm run build
```

## Assumptions

- The dashboard companion plan lands the `/internal/instances/:id/decisions`
  routing fix before this CLI work is declared end-to-end complete.
- `RunStreamClient` remains a compatibility Adapter for legacy run stream UI
  paths; canonical paired-instance feed delivery is `feed_event`.
- Historical gateway runner Modules are not deleted in this sweep unless a
  dependency search proves they are unused and removal has its own tests.
