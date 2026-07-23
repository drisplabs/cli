# ADR 0014 - A Workflow Run is one continuous, resumable session; continuation by Nudge, Retry, and Handover

Status: Active
Date: 2026-07-24

Replaces the withdrawn 2026-07-23 draft of this ADR ("Stop is notify-only"), whose central rule — _any
normal stop without `WORKFLOW_COMPLETE` suspends_ — was rejected in review. See Context.

## Context

Since the ADR 0003 era a Workflow Run **continues by default**: after any Turn that leaves no Terminal
Marker on the Tracker, the Runner spawns a fresh Turn (`terminalOutcome.ts:86`, `workflowRunner.ts:285`).
Two failure modes follow:

1. **It barrels past human input.** `runtime/server.ts:296` documents the exact shape: a human-in-the-loop
   event that fired a passthrough on a timer "caused Claude to exit and the workflow loop to tick a fresh
   iteration that lost the question." A normal stop where the agent paused to ask is read as "no marker →
   continue," and the next Turn — a fresh Agent Session — never sees the question.
2. **Context bounding is vendor compaction.** Long Turns rely on in-place auto-compaction
   (`CLAUDE_CODE_AUTO_COMPACT_WINDOW` at `spawn.ts:266`; `model_auto_compact_token_limit` at
   `promptOptions.ts:89`), steered toward a handoff-style summary. The summary is lossy and generic, and
   the loop cannot tell "compacted and continuing" from "stopped."

The withdrawn draft fixed (1) by suspending on **any** markerless normal stop. Review found that unsound.
The Stateless Turn Protocol's **Turn bounding** section (`stateMachine.md:90-98`) explicitly instructs the
agent to _stop early_ at checkpoints — "Ending early and letting the next Turn pick up from a clean tracker
is almost always better than pushing through with a heavy context." A markerless normal stop is therefore
the **designed, common** Turn boundary, not an anomaly. Suspending on it would have halted every multi-Turn
workflow at its first checkpoint, and Handover would not have rescued it, because a bounded checkpoint Turn
never reaches the compaction trigger.

So the two goals — "continue until the work is actually done" and "never auto-continue past a question" —
are compatible only if the agent stops **for a declared reason**. That is the shape of this decision.

## Decision

**1. A Workflow Run is one continuous, resumable Agent Session.** Voluntary Turn-bounding is removed from
the protocol: the agent runs until the work is done or until it must stop for a declared reason, writing the
Tracker as it goes for durability. Context refresh is no longer a voluntary checkpoint — it is **Handover**
(§5), triggered by a token bound. `stateMachine.md`'s "Turn bounding" section is replaced by run-until-done
guidance.

**2. Attention is declared, never inferred.** `WORKFLOW_BLOCKED[: reason]` becomes the agent's explicit "I
need a human" — a question or an external blocker — and now resolves to the **non-terminal**
`awaiting_attention` instead of terminal `blocked`. An `AskUserQuestion` elicitation inside a Workflow Run
converts to the same state rather than waiting forever on a null timeout (`interactionRules.ts:200`). This
closes the "lost the question" pathology by construction: a question is declared, not guessed at from a bare
process exit.

**3. An undeclared markerless stop is a Nudge, not an alert.** A Turn that exits cleanly with no marker and
no error is a _premature_ stop ("done with X — want me to continue?"). The Runner **resumes** the same Agent
Session with a corrective prompt — finish the work, or declare a marker — bounded by a Nudge cap. Exceeding
the cap escalates to `awaiting_attention`.

**4. Transient failures Retry by resuming; hard failures escalate.** A transient failure (`rate_limit` /
`overloaded` / `server_error` / network) → backoff, then **resume** the same Agent Session (`--continue`),
up to a retry cap; the Run stays `running`. A hard failure (`auth` / `billing` / `invalid_request` /
`model_not_found`) or an exhausted cap → `awaiting_attention`. This reverses the withdrawn draft's "no live
session survives a failure": the vendor session persists on disk, so resuming preserves in-flight work the
Tracker never checkpointed.

**5. Handover replaces in-place compaction — and the early trigger is what makes it work.** On crossing a
harness-neutral **`maxTurnTokenCount`**, `PreCompact` is blocked, the live conversation is **forked**
(`--fork-session`), the **`handoff` skill** distills it into a **Handoff file**, the fork is discarded, and a
**fresh** Turn (new Agent Session) is seeded with the Handoff file + Tracker.

- **Headroom comes from the trigger, not from the fork.** A fork inherits the full conversation, and
  summarizing N tokens requires ingesting ~N — forking creates no room. So `maxTurnTokenCount` must sit
  **well under** the model window (~60-65%) to leave space to hold the conversation _and_ emit the handoff.
  Today's defaults — `185000` (`spawn.ts:266`) and `175000` (`promptOptions.ts:89`) — sit at the window and
  defeat this; both must drop. No 1M-context dependency.
- **The fork runs with autocompact disabled**, so writing the handoff cannot re-trigger `PreCompact`.
- **Blocking `PreCompact` is three coupled changes**, because `compact.pre` is observation-only today:
  - `interactionRules.ts:80`: `compact.pre` → `canBlock: true` **and** `expectsDecision: true` (to sit on
    the decision-waiting path). `canBlock` alone is necessary-but-insufficient.
  - `generateHookSettings.ts:73`: add `'PreCompact'` to `SYNC_HOOK_EVENTS`. Otherwise it dispatches `async`,
    and **Claude ignores an async hook's stdout**, so the block reply is dropped.
  - a decision handler that emits the block and orchestrates the Handover.
- **The safety fallback is free.** If no Handover decision arrives (non-workflow session, orchestration
  failure), the `compact.pre` timeout fires a passthrough → normal vendor compaction. Handover degrades to
  auto-compact; it never hangs Claude.

**6. Resume when intact; go fresh only to shed context.** The recovery invariant: Nudge, Retry, and
human-reply all **resume** the intact Agent Session; **Handover is the only transition that starts a fresh
one**. A human reply routes back through the existing **Relay** path as a `RuntimeDecision` and resumes the
session that asked, preserving the context in which the question arose.

**7. `awaiting_attention` is the one give-up state.** `blocked` and `exhausted` are no longer emitted: a
declared `WORKFLOW_BLOCKED` and the `maxIterations` ceiling both resolve to `awaiting_attention`, and the
exec runner's `exhausted` failure-latch (`runner.ts:586`) follows. Both remain valid values on historical
`workflow_runs` rows. A cumulative token/cost budget can slot into the same suspend outcome later; the
message names which bound tripped.

**8. `resolveTurnOutcome` is extended, and the split is stated.** `TurnOutcome` gains a `suspend` kind
alongside `continue` / `stop`, and the resolver additionally takes the Turn's **end-reason** (Handover /
failure-class / declared marker / undeclared stop), which its current signature
(`{trackerPath, loop, iteration}`) lacks. Stated honestly: this is **not** a single owner. The Runner already
handles process failure _before_ calling the resolver (`workflowRunner.ts:229-258`), so failure-class →
Retry/escalate lives there, while marker/ceiling → suspend lives in the resolver. ADR 0004's one-owner
property is preserved for the Tracker-end-state → Run Status map only; the split is now explicit rather than
accidental.

## Prerequisites (net-new, non-obvious)

None of these exist today, and each gates part of the above:

- **Capture and persist the vendor session id.** It is observed on hook envelopes (`server.ts:288`) but is
  not carried on `WorkflowRunSnapshot`. Every resume and the fork depend on it.
- **Wire resume into the loop.** `--resume` / `--continue` exist at spawn (`spawn.ts:244-246`), but the
  workflow loop hardcodes `{mode: 'fresh'}` on every Turn (`workflowRunner.ts:285`).
- **Build the fork path.** `--fork-session` is registered (`flagRegistry.ts:86`) but has **no caller**.
- **A failure taxonomy.** `TurnExecutionResult.error` is a bare `Error` (`process.ts:10`) and
  `HarnessProcessFailureCode` (`process.ts:23`) covers only spawn/startup faults — nothing classifies
  `rate_limit` vs `auth`. Retry-vs-escalate cannot be decided without it.
- **A first-party `handoff` skill.** `handoffInstructions.ts` only _injects text to steer vendor
  compaction_ and is adapted from an external skill; this model needs an invocable skill that writes a
  Handoff file inside the fork.
- **The protocol rewrite** (`stateMachine.md`): remove Turn bounding; add run-until-done and
  declare-when-blocked.

## Consequences

Positive:

- A question is never barreled past — it is declared, and the declaration is the trigger.
- "Continue until done" actually holds: premature stops are nudged, transient failures resume, context
  limits hand over. Only a declared need or an exhausted bound involves a human.
- Context bounding becomes an explicit, inspectable **Handover** instead of an opaque in-place summary;
  "done" vs "handing over" vs "waiting" become distinct states.
- Resuming preserves in-flight work the Tracker never checkpointed — strictly more than the
  fresh-from-Tracker recovery it replaces.
- One resumable give-up state, uniformly wakeable; no dependency on a 1M-context beta.

Negative / costs:

- **The quality guard that Turn bounding provided is gone.** It existed because "the longer you run, the
  more attention is spread across tokens that are no longer relevant, degrading precision on the work that
  matters now" (`stateMachine.md:92`). Agents now carry heavier context between Handovers;
  `maxTurnTokenCount` becomes the dial trading context freshness against Handover count.
- Handoff quality gates cross-Handover continuity; a weak Handoff file loses in-flight context the Tracker
  did not checkpoint, and fidelity loss compounds along a chain of Handovers.
- A new suspend/resume lifecycle plus the first non-terminal Run Status (persistence, UI, resume entrypoint).
- `PreCompact` becomes a synchronous, decision-bearing hook on the compaction path (added latency there,
  bounded by its timeout).
- Three separate bounds (Nudge cap, Retry cap, `maxIterations`) all funnel into one state; the message must
  name which one tripped or the state becomes unreadable.

## Relationship to prior ADRs

- **Amends ADR 0003.** Its canonical hierarchy declares the Agent Session to be "the FRESH vendor
  session/thread per Turn (no `--resume`)". That no longer holds: an Agent Session **spans** the Turns that
  resume it and **resets at a Handover**. Consequently the Tracker is no longer the _sole_ continuity
  mechanism — within a resumed span the session's own context carries it, and the Tracker's role is
  durability, Handover seed, and human-facing ledger. **Naming tension left open:** ADR 0003 §5 named the
  protocol the _Stateless_ Turn Protocol, and a resumed Turn is not memoryless. The name is kept for now to
  avoid a rename ripple; revisit if it causes confusion.
- **Amends ADR 0004.** Its core — one resolver with exhaustive branches — survives and is extended (§8).
  What changes: the Run Status space gains the non-terminal `awaiting_attention`; `blocked` and `exhausted`
  stop being emitted; `TurnOutcome` gains a `suspend` kind.
- **No persisted identifier is renamed.** `blocked` and `exhausted` remain valid `RunStatus` values for
  historical `workflow_runs` rows; they are simply no longer written.

## References

- `src/core/workflows/stateMachine.md` — Stateless Turn Protocol; **Turn bounding** (:90-98), removed by §1
- `src/core/workflows/terminalOutcome.ts` — `resolveTurnOutcome`, `maxIterations` branch (:82),
  continue-by-default fallthrough (:86)
- `src/core/workflows/workflowRunner.ts` — the loop; pre-resolver failure branch (:229-258); `{mode:'fresh'}` (:285)
- `src/core/workflows/builtins/index.ts` — `maxIterations: 20` (:117)
- `src/core/runtime/process.ts` — `TurnExecutionResult.error` as bare `Error` (:10); `HarnessProcessFailureCode` (:23)
- `src/harnesses/claude/runtime/interactionRules.ts` — `compact.pre` (:80), `stop.request` precedent (:50),
  elicitation null timeout (:200)
- `src/harnesses/claude/runtime/server.ts` — vendor session id on the envelope (:288); "lost the question" (:296)
- `src/harnesses/claude/hooks/generateHookSettings.ts` — `SYNC_HOOK_EVENTS` (:73); async/stdout coupling (:59)
- `src/harnesses/claude/process/spawn.ts` — `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (:266); `--resume` / `--continue` (:244-246)
- `src/harnesses/claude/config/flagRegistry.ts` — `--fork-session` (:86; registered, no caller)
- `src/harnesses/codex/session/promptOptions.ts` — `model_auto_compact_token_limit` (:89)
- `src/core/compaction/handoffInstructions.ts` — in-place compaction steering, superseded by the skill
- `src/app/exec/runner.ts` — `exhausted` failure-latch (:586)
- `UBIQUITOUS_LANGUAGE.md` — Turn, Agent Session, Handover, Handoff file, Retry, Nudge, Needs-attention, Run Status
- ADR 0003 (execution-unit terminology — amended), ADR 0004 (terminal-outcome owner — amended)
