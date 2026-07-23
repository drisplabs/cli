# ADR 0004 - One owner for a Turn's terminal outcome

Status: Active — amended by [ADR 0014](0014-handover-retry-attention-continuation.md) (the Run Status space gains the non-terminal `awaiting_attention`; `blocked` and `exhausted` are no longer emitted; `TurnOutcome` gains a `suspend` kind; failure-class handling is explicitly the Runner's, not the resolver's, so "one owner" now covers the Tracker-end-state map only)
Date: 2026-07-19

## Context

After each Turn, the Runner must decide one thing: run another Turn, or stop the Workflow Run with a
terminal **Run Status** (`completed` / `blocked` / `exhausted` / `failed` / `cancelled`) and, for the states
worth explaining, a human message.

That single decision used to be expressed **three times, in three vocabularies, across three files**, with a
lossy translation at each seam:

1. `LoopState` — an 11-field boolean bag returned by `createLoopManager().getState()` (`loopManager.ts`).
2. `LoopStopReason` — a 6-variant enum selected by `shouldContinueWorkflowRun` (`sessionPlan.ts`), which
   also **mutated** the loop's iteration counter and tore down the loop manager as a side effect of a query.
3. `RunStatus` + a hand-built string — re-derived a third time by a 6-branch `if/else` in `workflowRunner.ts`.

No module owned "what the Tracker's end state means." The translations had already drifted: the final hop
had **no case for `missing_tracker`**, so it fell through the `else` branch and surfaced the raw enum name
(`"Loop stopped: missing_tracker"`) to the user instead of a sentence.

Two smaller smells rode along (both flagged by the architecture review):

- **Two iteration counters for one Turn index.** The Runner counted started Turns (`iterations`) while the
  Loop Manager separately counted completed Turns (`iteration`, incremented inside the "should continue?"
  query). The max-iteration check used the second counter offset by one (`iteration + 1 >= max`).
- **Deep parsers locked in dead state.** The Tracker-parsing helpers were trapped in a closure reachable
  only through `getState()`, and 4 of `LoopState`'s 11 fields (`active`, `completionMarker`, `blockedMarker`,
  `reachedLimit`) existed only for the unit test.

## Decision

**1. One `terminalOutcome.ts` owns the mapping.** `resolveTurnOutcome({trackerPath, loop, iteration})`
reads the Tracker directly and returns the **final** outcome the Runner assigns:

```ts
type TurnOutcome =
	| {kind: 'continue'}
	| {kind: 'stop'; status: RunStatus; stopReason?: string};
```

Every terminal branch carries both the `RunStatus` and (where useful) the human sentence, so the map from
Tracker end-state → Run Status lives in exactly one place. The branches are exhaustive over the Tracker's
end-state, which is what structurally prevents another `missing_tracker`-style fall-through. The Runner
consumes an already-final outcome; it no longer re-derives status or message.

**2. The `LoopStopReason` intermediate enum is removed.** Its named reasons are now the exhaustive branches
of `resolveTurnOutcome`. The persisted `stopReason` was always the human message, never the enum, so nothing
persisted changes.

**3. The Tracker reader (`trackerReader.ts`, renamed from `loopManager.ts`) becomes pure and stateless.**
It exposes `parseTrackerState(content, markers) → TrackerState` and `readTracker(path)` (plus the Terminal
Marker constants and the Continue Prompt). The parsing helpers are promoted from a closure to module
functions and are unit-testable directly. `createLoopManager`, the `LoopState`/`LoopManager` types,
`deactivate`, and `cleanupWorkflowRun` are deleted; the filename is updated to match its role (the glossary
names the concept "Tracker Reader" and deprecates "Loop Manager").

**4. The Runner owns the single Iteration counter.** `prepareWorkflowTurn(state, {prompt, iteration})` and
`resolveTurnOutcome` both take the Runner's 1-based Turn index; the Loop Manager no longer keeps its own
counter and `shouldContinueWorkflowRun` (a query that mutated) is gone. Behavior is preserved: a loop with
`maxIterations = N` still runs exactly `N` Turns before reporting `exhausted`, and the Continue Prompt still
switches in on Turn 2.

## Consequences

Positive:

- One `{Tracker end-state → Run Status → message}` table; a new terminal state is added in one place.
- The `missing_tracker` fall-through bug is fixed and made structurally unreachable (exhaustive branches).
- The "Terminal Marker must be the final line" rule and the outcome messages stop being authored 3×.
- The Tracker parser is pure and tested at its own seam; the triplicated Loop-State/Stop-Reason tests
  collapse onto `terminalOutcome.test.ts`.
- A "should continue?" call is no longer a query with hidden mutation + teardown.

Negative / costs:

- `terminalOutcome.ts` reads the filesystem (existence + content), so it is exercised with temp dirs rather
  than as a pure function. The pure core (`parseTrackerState`) is separately unit-tested.

## Relationship to ADR 0003

Stays inside ADR 0003. **No persisted identifier is renamed** — no table, column, `session_id`, `run_id`,
or `RunStatus` value changes. This is an in-process consolidation of the read/decision path only. ADR 0003's
References cited `LoopStopReason` and `LoopManager` as glossary-aligned code names; this ADR supersedes those
two specific names (the concepts they named now live in `TurnOutcome` / the pure Tracker reader), while the
`Turn`, `Iteration`, `Run Status`, `Tracker`, and `Terminal Marker` vocabulary is unchanged.

## References

- `src/core/workflows/terminalOutcome.ts` - `resolveTurnOutcome`, `TurnOutcome` (the single owner)
- `src/core/workflows/trackerReader.ts` - `parseTrackerState`, `readTracker`, `TrackerState` (pure reader; renamed from `loopManager.ts`)
- `src/core/workflows/workflowRunner.ts` - the Runner, single Iteration counter
- `src/core/workflows/sessionPlan.ts` - `prepareWorkflowTurn` (now iteration-parameterised)
- `UBIQUITOUS_LANGUAGE.md` - Terminal Outcome / Tracker State / Run Status
- ADR 0003 - execution-unit terminology (persistence names unchanged)
