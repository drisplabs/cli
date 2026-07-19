# ADR 0005 - One owner for the runtime-event loop and resume policy

Status: Active
Date: 2026-07-19

## Context

Drisp runs the same runtime plumbing in two modes:

- interactive (Ink) — the `useFeed` React hook (`src/app/providers/useFeed.ts`);
- headless exec — the `runExec` runner (`src/app/exec/runner.ts`).

Both subscribe to a `Runtime`'s `RuntimeEvent` / `RuntimeDecision` streams and run
the identical assembly: ingest each event through the `FeedMapper`, feed any
controller-derived `RuntimeDecision` back to the runtime via `sendDecision`
_before_ handing the resulting `FeedEvent`s to a sink, and ingest each decision
into one more `FeedEvent`. Alongside that, both drained the paired dashboard's
decision inbox on an interval (`limit: 25`, `1000ms`), and both entry points
(`execCommand.ts`, `interactiveSession.ts`) hand-rolled resume-target
resolution.

The shared _leaves_ were already deep and single-homed — the relay adapter
(ADR 0002), the `ingest` core (`src/core/feed/ingest.ts`), and the paired feed
publisher. The _assembly_ around them was not: it was copy-pasted twice and had
begun to drift.

Two concrete symptoms:

1. **The decision-inbox drain was literal copy-paste** — the `limit: 25` batch
   size and `1000ms` cadence were duplicated as magic numbers in both modes,
   with subtly different error handling (exec caught per-row and warned;
   interactive let throws propagate).

2. **Resume resolution diverged by accident.** When a "resume most recent"
   request found no prior Athena session, headless exec **errored** (non-zero
   exit) while interactive silently **started fresh**. Each was correct for its
   mode, but the choice lived implicitly in two separate functions rather than
   as one deliberate parameter — so neither reader nor test could see that a
   choice was even being made.

## Decision

**The non-React runtime-event loop has one owner:
`src/app/runtime/runtimeEventLoop.ts`.**

- `attachRuntimeEventLoop` owns the subscription lifecycle and the
  `ingest → sendDecision → sink` ordering for both events and decisions. Each
  mode injects only its own side effects through hooks: interactive supplies
  perf tracing (`wrapEvent`/`wrapDecision`), React store pushes, and queue
  dequeues; headless supplies JSONL emission, adapter-session linking, and
  final-message tracking. The ingest context is resolved per event so a
  mid-session reset (new mapper) or store swap is picked up on the next event.
- `startDashboardDecisionDrain` owns the dashboard **decision drain**. The
  `DASHBOARD_DECISION_POLL_LIMIT` (25) and `DASHBOARD_DECISION_POLL_INTERVAL_MS`
  (1000) constants live here once. Each caller still decides _when_ to start the
  drain (interactive: a React effect gated on dashboard config; headless: after
  `runtime.start()`), so the drain is a standalone helper rather than folded
  into the subscription loop.

`useFeed` and `runExec` become thin adapters over this module: `useFeed` keeps
only React state projection, `runExec` keeps only JSONL/exit-code concerns.

**Resume resolution has one owner with an explicit policy:
`src/app/entry/resumeResolution.ts`.**

- `resolveResumeTarget` resolves a normalized `ResumeRequest`
  (`fresh` | `most-recent` | `explicit`) into an Athena session id plus the
  adapter session to resume. The fresh / explicit / most-recent branches and the
  `adapterSessionIds.at(-1)` handoff live in one place.
- The one knob where the modes deliberately differ is the
  `MissingRecentPolicy` parameter (`'error' | 'fresh'`). Headless exec passes
  `'error'`; interactive passes `'fresh'`. The behaviour of each mode is
  unchanged — but the divergence is now a single, tested, self-documenting
  parameter instead of an accident of two hand-rolled resolvers.

This deepens the WIRING above the shared leaves; it does not touch them. The
relay adapter (ADR 0002) and `runExec` as the single execution module
(ADR 0001) are unchanged — both remain the leaves this loop assembles.

## Consequences

Positive:

- The subscribe → ingest → decide → publish ordering, the drain cadence/limit,
  and the resume policy each have exactly one home, so interactive and headless
  can no longer drift on them.
- The loop and the drain have their own non-React test surface
  (`runtimeEventLoop.test.ts`), independent of the sqlite-backed runner tests.
- The resume-policy choice is explicit and unit-tested for both values, so a
  future reader sees a decision rather than two lookalike functions.

Negative / costs:

- `attachRuntimeEventLoop` exposes a fairly wide hook surface
  (`wrapEvent`, `skipEvent`, `onEventReceived`, `emitEventFeed`, and the decision
  equivalents). This is deliberate: the two modes genuinely differ in their
  per-event side effects, and the hooks are the seam that lets the assembly stay
  shared while the side effects stay mode-owned.
- `resolveResumeTarget` takes per-mode message strings as parameters, because
  the two modes' user-facing wording differs even though their control flow does
  not.

## Rejected alternatives

- **Fold the decision drain into `attachRuntimeEventLoop`.** Rejected: the two
  modes start the drain at different lifecycle points (a React effect vs. after
  `runtime.start()`), so a single "attach" call would have to re-expose that
  timing anyway. A standalone helper is clearer.
- **Unify resume behaviour (one policy for both modes).** Rejected: exec
  erroring on a missing `--continue` target and interactive falling back to a
  fresh session are each the right UX for their mode. The goal is to make the
  divergence explicit, not to erase it.

## References

- `CONTEXT.md` - Runtime event loop, Dashboard decision drain, RuntimeEvent,
  RuntimeDecision, FeedEvent, FeedMapper, Relay
- `src/app/runtime/runtimeEventLoop.ts`
- `src/app/entry/resumeResolution.ts`
- `src/app/providers/useFeed.ts`, `src/app/exec/runner.ts`
- `src/app/entry/execCommand.ts`, `src/app/entry/interactiveSession.ts`
- ADR 0001 (runExec is the single execution module), ADR 0002 (keep the relay
  adapter) - the leaves this loop assembles
