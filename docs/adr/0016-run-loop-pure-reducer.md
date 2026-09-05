# ADR 0016 - The Workflow Run loop is a pure reducer over an explicit transition table

Status: Active
Date: 2026-09-02
Relates to: ADR 0004 (terminal-outcome owner), ADR 0014 (handover, retry, attention, continuation),
ADR 0015 (Tracker sheds into a Dossier)

> **Terminology note (2026-09-03, #185):** the **Tracker** below is now the **Journal**: `RunMemory.lastTrackerHash` is `lastJournalHash` (a persisted snapshot spelled the old way still rehydrates), `trackerContent` / `tracker_missing` are `journalContent` / the missing-journal outcome, and the declared marker is `NEEDS_HUMAN`. The reducer gained one action, `warn`, so a deprecated marker spelling reaches the same phase and the interpreter logs the notice — the purity rule in §1 and §5 is untouched. The text below is preserved as decided. See the Deprecated names table in `UBIQUITOUS_LANGUAGE.md`.

## Context

ADR 0014 gave the Workflow Run five continuation mechanisms — Nudge, Retry, Handover, wake-from-
attention, and the declared markers — and admitted in §8 that their ownership is split: the Runner
handles process failure before `resolveTurnOutcome` is ever called (`workflowRunner.ts:578-600`),
while marker and ceiling handling live in the resolver. The ADR called the split "explicit rather
than accidental," which was honest but left the control flow spread across an `async while` loop,
mutable counters, and a pure-ish resolver that sees only part of the picture.

Two defects of that shape were fixed directly ahead of this ADR (#170, #171; see ADR 0015 Context).
Both were single-branch mistakes in code whose control flow is spread across an `async while` loop,
mutable counters, and a resolver that sees only part of the picture — which is the argument for this
decision rather than an aside.

The cost is not aesthetic. Three concrete consequences:

- **State that must survive a process restart lives in local `let`s.** `let iterations = 0`
  (`workflowRunner.ts:355`), plus nudge and retry streaks, are loop-locals. `WorkflowRunSnapshot`
  persists `iteration` (`infra/sessions/types.ts:63`) but the Runner never reads it back when
  `resumeRunId` is set — it re-declares zero and increments to one (`workflowRunner.ts:456`).
  With `awaiting_attention` non-terminal under ADR 0014 §7, **`maxIterations` (default 20,
  `builtins/index.ts:117`) is a per-wake budget, not a Run budget**: a Run woken ten times gets ten
  fresh ceilings. That is an unbounded loop wearing a bound.
- **Tests must drive the loop through mocked `startTurn` sequences** to reach a branch, so the
  branches nobody sequences are the branches nobody tests.
- **The prompt in flight is not part of the loop's state**, so a failure that re-enters the loop can
  resume with the generic Continue Prompt instead of the instruction that was actually being carried.

## Decision

**1. Extract the loop into a pure reducer `step(phase, memory, event, cfg) → {phase, memory, actions}`**
in `runMachine.ts`, with no filesystem, timers, harness, or randomness. `RunPhase` is a discriminated
union (`turn_in_flight`, `backing_off`, `handing_over`, `awaiting_attention`, `completed`, `failed`,
`cancelled`); `RunMemory` is a plain persistable object (`iteration`, `nudgeStreak`, `retryStreak`,
`lastTrackerHash`, `adapterSessionId`, plus the in-flight prompt and continuation). The Runner becomes
an interpreter: persist the snapshot, `perform(actions)` to obtain exactly one `RunEvent`, `step`
again. `perform` is the sole point of contact with the harness, the filesystem, and the clock.

**2. `RunMemory` is the persisted Run state.** The snapshot carries the whole object, and a resumed or
woken Run rehydrates from it rather than re-declaring zeros. This makes `maxIterations` an actual Run
budget across wakes, and makes nudge and retry streaks survive a process restart.

**3. Replay the in-flight prompt if and only if the continuation mode is `fresh`.** Evidence: Claude
Code persists the user message to the session transcript **before** the API call, and records the
failure as an assistant message — 34 API errors across local transcripts are preceded by a persisted
user message. A `--resume`d session therefore already contains both the instruction and the record of
its failure, so replaying it duplicates the message; a discarded session contains neither, so replay
is required. Expressed as an invariant over whether the session survives, this needs no per-harness
branch:

> **replay ⟺ `continuation.mode === 'fresh'`**

Concretely: Retry (resume) sends a bare continue; the fresh-replay path after a hard failure on a
resumed session replays. `backing_off` carries the prompt so that either resolution is available;
carrying it is necessary, replaying it unconditionally is not.

**4. `step` is total and non-falling-through.** Each phase is handled by its own function returning a
complete result, rather than by fallthrough-prone `case` labels. This is a decision, not a style note:
`turn_in_flight` and `backing_off` both carry `prompt` and `continuation`, so a fallthrough between
them **typechecks** and silently restarts a Turn, while the `handing_over` fallthrough is caught by
narrowing. Partial compiler coverage is more dangerous than none, because it invites trust.

**5. Backoff duration is a pure function of `retryStreak`; any jitter is injected.** `step` must never
read a clock or a random source. Jitter arrives as a `deps` argument or is applied by `perform`.

**6. `turn_in_flight` is not a persistable phase.** On rehydration it becomes
`backing_off{ms: 0, prompt, continuation}`, so the interpreter re-issues the action. Persisting
`turn_in_flight` across a process exit asserts something false — no Turn is in flight — and the claim
that a restart resumes cleanly would be true of the streaks and false of the phase.

**7. Every ADR 0014 behaviour is a named row, including the ones easy to drop.** Two in particular:

- **The nudge cap resets only when the Tracker advances**, which requires comparing
  `lastTrackerHash`, not merely carrying it. This is the difference between escalating after three
  unproductive stops and never escalating.
- **`skeletonNotReplaced` selects a different corrective prompt** (`trackerReader.ts:205`) — the
  Turn-1 case where the agent asked its question in chat instead of declaring it. It is the failure
  ADR 0014 §2 exists to close and must not be collapsed into the generic nudge.

**8. A fork failure is retried once when transient, then degrades.** `fork_finished` carries
`{ok, transient}`. A Handover fires at `maxTurnTokenCount` — the state where a rate limit is most
likely — so mapping every fork failure straight to vendor compaction discards a Handoff for a
retryable reason, and ADR 0014 names Handoff fidelity loss as compounding along a chain.

**9. The reducer's only contact with the Dossier is `trackerHash` and `tracker_missing`, and the hash
covers `tracker.md` alone.** Under ADR 0015 a shed rewrites the Tracker _and_ a unit record; if the
hash spanned the Dossier, a shed would read as "the Tracker advanced" and silently reset the nudge
streak, converting a stuck agent into an unbounded one.

> Amended by ADR 0018 §5: the reducer's contact stays the Journal hash and the missing-Journal
> outcome, but the _interpreter's_ contact widens from the Journal alone to the Handoff chain, for
> one number — the similarity of the newest Handoff to its predecessor.

**10. This refactor changes no behaviour except the defects it names.** §2 (budget across wakes),
§3 (replay rule), §4-§6 (fallthrough, purity, rehydration), §7 (preserved rows), and §8 (fork retry).
Every other row of the transition table must be defensible against the current Runner's observed
behaviour; a row that is not is either a fix named here or a regression that was missed.

> Amended by ADR 0018: two more named defects — the iteration ceiling was unreachable on the
> Handover row (the successful-fork row seeded the next Turn without consulting `maxIterations`),
> and the Handover itself was unbounded.

## Consequences

Positive:

- Every arrow is a table row and every row is a `step` call in a test — asserting the next phase and
  the emitted actions, with no mocked `startTurn` sequences and no timing.
- ADR 0014 §8's admitted split closes: failure classification, markers, ceilings, and continuation
  all resolve in one function, without moving I/O into it.
- Run-scoped budgets become real, because the counters are persisted state rather than loop-locals.
- The interpreter is small enough to read in one screen, which is where the remaining risk lives.

Negative / costs:

- A second state model beside the Feed's, with its own vocabulary; `RunPhase` and `RunStatus` are
  related but not identical, and the mapping between them must be written down or they will drift.
- `perform` concentrates every unpleasant thing — harness spawn, fork, sleep, abort — in one place
  that remains as hard to test as the loop is today. The reducer is testable; `perform` is not, and
  claiming otherwise would be the failure mode of this decision.
- Persisting `RunMemory` widens the snapshot schema and creates a migration for in-flight Runs.
- §3 rests on observed Claude Code transcript behaviour. It is stated as an invariant over session
  survival so that it does not depend on that observation, but a harness that discards the user
  message on failure would make Retry lossy, and only a per-harness probe would reveal it.

## Relationship to prior ADRs

- **Supersedes the mechanism of ADR 0014 §8**, not its conclusions. `resolveTurnOutcome`'s branches
  survive as rows in the table; what changes is that the Runner no longer handles a class of them
  before the resolver is consulted.
- **Preserves ADR 0004.** The Tracker-end-state → Run Status mapping keeps a single owner; that owner
  is now a row set rather than a function called from part-way through a loop.
- **Constrains ADR 0015.** §9 fixes the hash scope before the Dossier exists, because the failure it
  prevents is silent.

## References

- `src/core/workflows/workflowRunner.ts` — the loop; pre-resolver failure branch (:578-600);
  `let iterations = 0` (:355); wake path and `iterations++` (:450-456); Handover orchestration
  (:481-544); `resolveTurnOutcome` call site (:675)
- `src/core/workflows/terminalOutcome.ts` — `resolveTurnOutcome`, the branches that become rows
- `src/core/workflows/trackerReader.ts` — `parseTrackerState`, `buildNudgePrompt`,
  `skeletonNotReplaced` (:205)
- `src/core/workflows/types.ts` — `LoopConfig`, `DEFAULT_MAX_TURN_TOKEN_COUNT` (:18),
  `DEFAULT_NUDGE_CAP`, `DEFAULT_RETRY_CAP`
- `src/core/workflows/builtins/index.ts` — `maxIterations: 20` (:117)
- `src/infra/sessions/types.ts` — `WorkflowRunSnapshot.iteration` (:63), `adapterSessionId`
- ADR 0014 §3 (Nudge), §4 (Retry), §5 (Handover), §6 (resume-when-intact), §7
  (`awaiting_attention`), §8 (resolver extension and the admitted split)
