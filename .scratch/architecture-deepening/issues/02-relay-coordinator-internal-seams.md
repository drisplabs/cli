# Add internal seams to gateway relay coordinator

Status: ready-for-human

## Files

- `src/gateway/relay/coordinator.ts` (~369 LOC)
- `src/gateway/relay/coordinator.test.ts` (~490 LOC, larger than implementation, uses timing/polling)

## Problem

The coordinator's _public_ interface is already deep and well-shaped (`addSession`, `removeSession`, `handleInbound`). Friction is _internal_: queue drain, backpressure state, and outbound dispatch are tangled in one body. Existing tests reach state via timing/polling because there are no internal seams to assert against directly.

## Sketch of deepening

This is _not_ a public-interface change. Extract internal modules used only by the coordinator:

- `BackpressurePolicy` — pure decision logic for when to pause/resume.
- `DrainScheduler` — timing/queue-drain policy.
- (Possibly) `OutboundDispatcher` — formats and emits to transport.

Each gets its own focused unit tests. Coordinator composes them. External callers see no change.

Quoting LANGUAGE.md: _"A deep module can be internally composed of small, mockable, swappable parts — they just aren't part of the interface."_

## Why this deepens

The public interface stays deep. The implementation gains testable internal seams, replacing flaky polling-based tests with deterministic ones. Locality of "what is the backpressure rule?" concentrates in one tiny module instead of being spread inside the 369-LOC coordinator body.

## Open design questions

- Do the internal modules need to be in their own files, or can they be private classes inside `coordinator.ts`?
- Which polling-based tests in `coordinator.test.ts` would migrate to focused unit tests vs. stay as integration tests?

## Effort

Low-medium. No public API changes; pure internal restructuring + test migration.

## Risk

Lowest of the five — public interface unchanged means no caller churn.
