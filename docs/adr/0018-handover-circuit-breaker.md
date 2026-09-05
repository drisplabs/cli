# ADR 0018 - A Handover is budgeted like every other continuation: an unproductive-Handover cap, the iteration ceiling on the Handover row, and a measured working-room diagnostic

Status: Active
Date: 2026-09-05
Relates to: ADR 0014 (handover, retry, attention, continuation), ADR 0015 (Tracker sheds into a
Dossier), ADR 0016 (run loop as a pure reducer). Resolves drisplabs/cli#164.

## Context

### The incident, and what the transcripts add to the post-mortem

One headless `drisp exec` Run (workflow `fullstack-engineering`, strict isolation, Claude Code
2.1.247) spent ~70 minutes and ~65M tokens across 53 Agent Sessions and wrote no source. The
post-mortem (`HANDOFF-drisp-handoff-loop-postmortem.md`, evidence under
`/private/tmp/drisp-postmortem-CORE-377/`) established the shape: 26 Handovers at a ~2-minute
cadence, each fresh Turn re-reading the Dossier, hitting the context bound, and being distilled
into a Handoff that restated the previous one. Reading the 52 nested Claude transcripts adds the
numbers that explain the cadence:

| measurement (26 fresh post-Handover Turns)                             | value                     |
| ---------------------------------------------------------------------- | ------------------------- |
| opening context of every fresh Turn (system prompt + tools + seed)     | 71,487–71,497 tokens      |
| context at the last API call before `compact.pre` fired                | 92.9k–97.1k tokens        |
| context at which compaction actually fired (last call + last read)     | ≈97k–104k tokens          |
| working room per fresh Turn (compaction point − opening context)       | ≈25k–30k tokens           |
| mandatory read at the end (Handoff 14 KB + Journal 45 KB + unit 30 KB) | ≈89 KB ≈ 22k–24k tokens   |
| Journal size, first fresh Turn → last                                  | 10.1 KB → 45.4 KB         |
| tool calls per fresh Turn, first → last                                | 19–22 → 3–5               |
| fresh-Turn duration, first → last                                      | 165–186 s → 26–37 s       |
| writes outside `.athena/`, all 52 sessions                             | 0                         |
| token spend: 26 fork Turns / 26 fresh Turns                            | 40.8M (63%) / 24.0M (37%) |

Three things follow that the post-mortem could not see:

1. **`maxTurnTokenCount` is not the agent's budget.** The knob was 130,000; compaction fired at
   ≈100k. On this Claude Code build the auto-compact point sits roughly 30k tokens _below_ the
   configured window, not at 95% of it as `qa/max-turn-token-count.md` and the `LoopConfig`
   docstring assume. The agent's real per-Turn budget is `compaction point − opening context`,
   and this workflow's opening context (71.5k) left ≈28k of it. Nothing measures or reports
   either number.
2. **The loop tightens on its own.** The Handover seed prompt (`buildHandoverSeedPrompt`,
   `runMachine.ts:388`) instructs the fresh Turn to fold the Handoff into the Journal and calls
   that fold-in "the journal's next edit". Agents executed it as appended `**Handoff N
processed**` notes; the Journal grew 4.5× and the mandatory read grew with it, until it alone
   exceeded the working room and every fresh Turn was killed after its third `Read`. Handover is
   the only continuation that _adds_ to what the next Turn must read before working.
3. **The Journal hash cannot be the Handover's progress signal.** That same mandated fold-in
   guarantees a Journal edit on almost every post-Handover Turn (15 of 26 here), so the
   `lastJournalHash` comparison the Nudge cap rests on (ADR 0016 §7) would have read most of
   this loop as progress. The Handoff files, by contrast, converged: word-3-gram Jaccard
   similarity between consecutive Handoffs was 0.13–0.47 while the Run was still orienting
   (001→008) and 0.63–0.93 once it was stuck (009→014, 021→026). Handoff 026 describes itself
   as "same substance as handoffs 020-025".

### The hole in the reducer

ADR 0014 named three bounds — Nudge cap, Retry cap, `maxIterations` — and ADR 0016 made every
continuation a row of one transition table. The Handover rows have no bound:

- `handleTurnInFlight` branches on `handoverRequestHandle` first (`runMachine.ts:662`) and the
  interpreter returns that event with `outcome: null` and `journalContent: ''`
  (`workflowRunner.ts:709`), so `resolveTurnOutcome` — the only place `maxIterations` is
  evaluated (`terminalOutcome.ts:115`) — is never called on a Turn that ended in a Handover.
- `handleHandingOver` (`runMachine.ts:1064`) increments `iteration` and starts a fresh Turn,
  consulting nothing. It records `lastHandoffSizeBytes` (ADR 0015 §8's fidelity metric) and
  nothing reads it. It emits no `notify_iteration_complete`, so the exec stream shows
  `iteration.complete` for Nudges but not for Handovers, and `run.handover` carries only the
  vendor session id.

The glossary says every Turn ticks the Iteration and `maxIterations` is "the single runaway
ceiling". On the Handover row that is false today. Issue #164 (2026-08-26, still `needs-triage`)
reproduced the loop with filler files and suggested a Nudge-style streak that degrades to vendor
compaction; it also believed `maxIterations` bounded the loop, which it does not.

## Decision

**1. A Handover is _unproductive_ when the session it distills added nothing.** Concretely, when
either holds at `fork_finished`:

- the new Handoff is **≥ 0.7 similar** (word-3-gram Jaccard) to the previous Handoff in the chain
  (`HANDOFF_NO_PROGRESS_SIMILARITY`, a named constant beside `DEFAULT_NUDGE_CAP`); or
- the Journal hash is **unchanged** since the previous Turn boundary.

The Handoff is the session's own distillation, so two consecutive near-identical distillations
mean the session between them produced nothing worth carrying. This is fold-in-proof: appending a
"processed" note changes the Journal hash but not the substance of the next Handoff. The hash
condition stays because it is the one that fires when a fresh Turn is killed before it writes
anything at all — the seed-too-big case (sessions 34–50 here). The threshold sits above every
progressing pair measured (max 0.47) and below every stuck pair (min 0.63) in the incident; the
first Handover of a Run has no predecessor and is judged on the hash alone.

**2. `handoverStreak` counts consecutive unproductive Handovers; `handoverCap` (default 3) parks
the Run.** `RunMemory` gains `handoverStreak: number` (rehydrated as 0 when absent); `LoopConfig`
gains `handoverCap?: number`. A productive Handover resets the streak; a wake (`woken`) resets it
too, because a human reply is new information. Once `handoverStreak` reaches `handoverCap` the Run enters
`awaiting_attention` with a sentence that names the bound and the measurement:

> handover cap reached: 3 consecutive Handovers (handoverCap) without progress — last Handoff
> 89% similar to the previous; journal unchanged; fresh Turns opened at ~71k tokens and were
> bounded at ~100k (~29k working room; journal ~11k tokens). Raise `loop.maxTurnTokenCount`,
> shrink the workflow's baseline context, or shed the journal.

In the incident, pairs 009→010 (0.70), 010→011 (0.73), 011→012 (0.73) reach a streak of 3, so the
Run parks at Handover 12 instead of 26 — roughly 55–60% of the spend saved, and the operator is
told what to change. Earlier is not available to a progress-based bound: by every signal,
including the agent's own account, the Run was genuinely orienting through Handover 008.

**3. The park is a suspend, not a degrade.** #164 proposed degrading the capped session to vendor
compaction (the existing `degrade_handover` path). Rejected on the measurements: a degraded
session compacts to `opening context + summary` ≈ 80k, has ≈20k of room before the next
compaction, and then compacts again — a slower, lossy grind with no Turn boundary, so nothing in
the reducer can see or bound it. Degrade is right when one atomic ingest overshoots a bound with
ample baseline headroom (#164's fixture: 20k baseline, one 75k file), but that case is exactly the
one where the fork succeeds and the next Turn is productive, so the cap never trips there. On a
trip, the cause is structural and a human must change a knob; `awaiting_attention` is ADR 0014
§7's one give-up state for exactly that, and the Handoff is on disk for the wake.

**4. `maxIterations` applies on the Handover row.** In `handleHandingOver`, after a successful
fork and before seeding the fresh Turn: if `memory.iteration >= loop.maxIterations`, park with the
existing `iteration ceiling reached` sentence (so `interruptionFromSuspension` maps it unchanged).
Fork first, then check: the Handoff is the distillation a wake needs, and one fork at the ceiling
is cheaper than losing the session's in-flight state. This is spec compliance, not the fix — it
would have ended the incident at Handover 19.

**5. The interpreter reads the Journal on the Handover path and measures the fork.** In
`performStartTurn`, the Handover early-return (`workflowRunner.ts:709`) reads `journalContent`
like the success path does, so the reducer can hash it and attach the ADR 0015 §3 size nudge to
the seed prompt (today the seed prompt never carries it, and this Journal was 11k tokens against
an 8k bound). In `performForkTurn`, beside the existing `statSync`, the interpreter computes the
similarity of the new Handoff to the previous one in the chain (the chain retains two, so the
predecessor is on disk) and puts `handoffSimilarity: number | null` on `fork_finished`. The
reducer receives numbers and stays pure (ADR 0016 §1); the interpreter's Dossier read widens from
`journal.md` alone to `handoff/NNN.md` as well, which §9 of ADR 0016 did not anticipate and this
ADR states explicitly. The hash still covers `journal.md` alone.

**6. Every fresh Turn measures its opening context and its bound, and the Run remembers them.**
`tokenAccumulator` already tracks the latest prompt size (`contextSize`); it gains the first one
(`openingContextSize`). `turn_finished` carries `{openingContextTokens, lastContextTokens}` and
`RunMemory` persists the most recent bounded pair. Three consumers:

- the cap sentence in §2 and the `run.handover.completed` event in §8;
- the seed prompt, which now tells the fresh Turn which Handover this is, roughly how much
  working room it has, and how large the Journal is — the agent can read selectively and shed
  first (#164's second suggestion);
- a Turn-1 `exec.warning` when the opening context exceeds half the compaction point ("baseline
  context is 71k of a ~100k compaction point — Handover will have ~29k of working room; raise
  `loop.maxTurnTokenCount` or trim the workflow's MCP servers and skills"). This is the preventive
  half: it names the true cause of this incident at minute one of the next one.

**7. The seed prompt stops mandating growth.** `buildHandoverSeedPrompt` and the matching line of
`stateMachine.md` ("fold whatever in it is still durable into the journal") are rewritten as: fold
in only what the Journal lacks; if it lacks nothing, write nothing; never append a "Handoff N
processed" note; if the Journal is over the shed bound, shedding is the first action, before any
other read. The fold-in obligation of ADR 0015 §8 stands — its execution as an append is what
this removes. Separately, a **shed-integrity nudge** joins the size nudge: a `units/*.md` record
with no `## Units` row, or a `##` heading present in both the Journal and a unit record (this
Journal shared three, plus two `## Hard constraints`), appends a prompt suffix naming the
incomplete shed. Read-only, never an edit — ADR 0015 §7 holds.

**8. The Handover is observable.** `run.handover` (exec) gains `iteration`; a new
`run.handover.completed` event on `fork_finished` carries `handoffPath`, `handoffSizeBytes`,
`handoffSimilarity`, `handoverStreak`, `openingContextTokens`, `lastContextTokens`, and the
Run's cumulative tokens; the Handover row emits `notify_iteration_complete` like the Nudge rows.
The cheapest health signal in the post-mortem — output tokens ≪ cache reads across many short
sessions — becomes readable from the stream.

**9. The wire and the wake.** `ExhaustedCapSchema` in `@drisp/protocol` gains `'handover'`, and
`interruptionFromSuspension` learns `handover cap reached: N`. A wake after a Handover-cap park
must start a **fresh** Agent Session seeded with the newest Handoff, the Journal, and the reply:
the persisted vendor session is the killed one (or the fork), both at the bound, and resuming
either re-trips compaction immediately. The Run's persisted memory carries the marking
(`parkedAfterHandover`, set by every park on the successful-fork row — the cap, the ceiling and the
token budget — because the Interruption kind alone cannot tell a ceiling reached on the Handover row
from one reached on a clean stop); resume resolution and the `woken` row key off it, and
`buildWakePrompt` names the Handoff.

**10. A cumulative Run token budget, opt-in.** ADR 0014 §7 anticipated it. `loop.maxRunTokens`
(no default) parks the Run with `token budget reached: <limit> tokens (maxRunTokens); used <total>` — the limit
first, as every cap sentence is read back — using the `cumulativeTokens` the interpreter already
keeps, passed on each event. A budget park on a fork boundary reuses §9's marking; one on a clean
Turn boundary resumes the intact session. No default because
cache reads dominate a legitimate long Run's total and a default would fight run-until-done; the
total is surfaced on `iteration.complete` and `drisp runs` regardless.

## Considered and rejected

- **A bare count of consecutive Handovers.** Under ADR 0014 §1 a six-hour Run _is_ a chain of
  Handovers; a count without a progress gate breaks run-until-done. The cap is progress-gated,
  like the Nudge cap.
- **Journal hash alone** (the Nudge cap's signal). Defeated by the fold-in mandate, as measured;
  it would have parked this Run at Handover ~19, not 12. Kept as the second condition.
- **Git working-tree hash.** Precise for code, blind to orientation and design phases (which are
  where this Run was legitimately stuck through 008), blind to non-git projects, and the protocol
  sends repository work to a worktree the runner does not know.
- **Counting write-tool calls outside `.athena/`.** Harness-specific tool names, and the same
  blindness to design phases. Useful telemetry, wrong gate.
- **Degrade to vendor compaction on trip** (#164). Rejected in §3 for the tight-baseline case,
  which is the case that trips.
- **Adaptive `maxTurnTokenCount`** (raise the knob for the next Turn when the seed does not fit).
  Plausible on 1M-window models, but it scales cost per call and hides the baseline problem;
  §6's warning makes the operator raise it knowingly instead.
- **Pre-fork trip.** Parking before the fork when the streak is at `cap − 1` and the killed Turn
  was short would save the most expensive half of the last cycle (forks were 63% of spend) at the
  price of one lost distillation. Left as a follow-up optimisation once the streak exists.

## Consequences

Positive:

- Every continuation is bounded, and each bound names itself and what to change. The Handover
  loop of #164 and this incident ends at the third unproductive cycle.
- The two numbers that actually govern a Run's per-Turn budget — opening context and the
  compaction point — are measured, persisted, shown, and warned on, so a workflow whose tooling
  eats its bound is told so on Turn 1.
- The seed prompt stops growing the Journal, and a half-executed shed is named the Turn after it
  happens.

Negative / costs:

- The similarity threshold is a tuned constant on one incident plus #164's fixture. It is
  recorded here with the measured distribution; a legitimate Run whose sessions each do real
  work would have to write three consecutive Handoffs ≥ 0.7 similar _and_ keep doing so to be
  parked, which the "Task and status" and "Files touched" sections make unlikely.
- The interpreter now reads two Dossier files, not one, and `RunMemory` widens again
  (`handoverStreak`, the bounded pair); `deserializeRunMemory` must default both.
- `@drisp/protocol` changes an enum; hub consumers that validate `cap` strictly need the new
  value before the runner ships it.
- The compaction-point finding is one build (2.1.247) and one knob value (130k). It needs the
  re-measurement `qa/max-turn-token-count.md` already describes, after which that document, the
  `LoopConfig` docstring, and the default bound (130k on a 200k window; a fraction of a 1M window)
  should be revisited against the measured formula rather than "95%".

## Relationship to prior ADRs

- **Amends ADR 0014 §7.** The bounds that funnel into `awaiting_attention` gain the Handover cap
  and the optional token budget; the message discipline ("name which bound tripped") is extended
  to carry the measurement.
- **Amends ADR 0016 §9.** The reducer's contact with the Dossier stays `journalHash` and the
  missing-journal outcome; the interpreter's contact widens to the Handoff chain for one number.
  §10's "no behaviour change except the defects it names" acquires two more named defects: the
  unreachable ceiling on the Handover row and the unbounded Handover.
- **Extends ADR 0015 §8.** "The Handoff's size is a fidelity metric" becomes "and its similarity
  to its predecessor is a progress metric"; the fold-in obligation is kept and its append form is
  forbidden.

## Glossary terms to add on acceptance (`UBIQUITOUS_LANGUAGE.md`)

- **Unproductive Handover** — a Handover whose Handoff is ≥ 0.7 similar to its predecessor or
  whose Turn left the Journal hash unchanged. **Handover streak** — consecutive unproductive
  Handovers; **Handover cap** (`handoverCap`, default 3) — the bound on it.
- **Opening context** — the first API call's prompt size of a fresh Turn: system prompt, tools,
  skills, seed. **Working room** — compaction point minus opening context; the agent's real
  per-Turn budget, which `maxTurnTokenCount` only indirectly sets.

## Verification

- Reducer rows as `step` calls (ADR 0016): ceiling on the Handover row; three unproductive forks
  park naming `handoverCap` with the measurement; a productive fork resets the streak; a `woken`
  event resets it; first Handover with no predecessor is judged on the hash; similarity ≥ 0.7
  with a changed Journal still counts as unproductive; `notify_iteration_complete` on the row.
- Interpreter: the similarity function on synthetic near-duplicate and distinct fixtures;
  `journalContent` populated on the Handover path; `openingContextSize` from the accumulator.
- `interruptionFromSuspension`: the new sentence maps to `cap_exhausted`/`handover` with `limit`.
- Live: #164's repro (`loop.maxTurnTokenCount: 105000`, four 75k-token filler files) parks after
  three unproductive Handovers with the diagnostic sentence and exits 0; a legitimate multi-Handover
  Run with real work between Handovers never trips; a wake after the park starts fresh and reads
  the newest Handoff.

## References

Line anchors refer to `main` at e08eaa7, the commit this ADR was written against.

- `src/core/workflows/runMachine.ts` — Handover branch (:662), `handleHandingOver` (:1064),
  `buildHandoverSeedPrompt` (:388), Nudge-cap hash/size-nudge (:871, :885), `notify_iteration_complete` rows (:938, :974)
- `src/core/workflows/workflowRunner.ts` — Handover early return with `outcome: null` (:709),
  `resolveTurnOutcome` call site (:783), `performForkTurn` (:806), `HANDOFF_RETAIN` (:423)
- `src/core/workflows/terminalOutcome.ts` — the only `maxIterations` check (:115)
- `src/core/workflows/types.ts` — `DEFAULT_MAX_TURN_TOKEN_COUNT` (:18) and its "compacts around 95%" docstring
- `src/core/workflows/journalReader.ts` — `DEFAULT_JOURNAL_TOKEN_BOUND` (:64), `buildJournalSizeNudgeSuffix` (:371), `parseUnitTable` (:409)
- `src/core/workflows/stateMachine.md` — fold-in instruction (:17)
- `src/app/exec/runner.ts` — `interceptCompaction` and `run.handover` (:428–:441)
- `src/harnesses/claude/process/tokenAccumulator.ts` — `contextSize` (:62)
- `src/app/dashboard/interruptionFromSuspension.ts` — cap sentence regex (:84)
- `packages/protocol/src/domain.ts` — `ExhaustedCapSchema` (:114)
- `qa/max-turn-token-count.md`, `qa/adr0014-continuation-round2.md` (#164 entry)
- drisplabs/cli#164; post-mortem and evidence at `/private/tmp/drisp-postmortem-CORE-377/`
  (the 52 Claude transcripts under `~/.claude/projects/-Users-nadeem-Projects-eximpe-telex--claude-worktrees-priceless-neumann-e871bf/` are the source of the table above)
