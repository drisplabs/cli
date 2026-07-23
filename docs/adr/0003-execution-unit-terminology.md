# ADR 0003 - Execution-unit terminology: one vocabulary, two bounded contexts

Status: Active — amended by [ADR 0014](0014-handover-retry-attention-continuation.md) (§1's Agent Session is no longer "the FRESH vendor session/thread per Turn (no `--resume`)": it spans the Turns that resume it and resets at a Handover, so the Tracker is no longer the sole continuity mechanism. §5's "Stateless" name is left in place but is now a partial misnomer.)
Date: 2026-06-06

## Context

The words **session**, **run**, and **turn** are overloaded across the codebase, and **iteration** is
used as if it were a vendor term. The ambiguity was surfaced while analyzing the workflow state machine
(`src/core/workflows/`). A proposed glossary (`UBIQUITOUS_LANGUAGE.md`) was drafted and cross-walked to the
official Anthropic (Claude Code) and OpenAI (Codex) definitions.

Grounding that glossary against the actual code produced two findings that frame this decision:

1. **The proposed glossary contradicted the persistence schema.** The cross-walk claimed Athena's
   `session` / `session.db` _is_ the "Workflow Run." But `src/infra/sessions/schema.ts` defines **two
   distinct tables**: `session` (the durable work-unit, one per `~/.config/athena/sessions/<id>/session.db`)
   and `workflow_runs` (foreign key `session_id → session(id)`, **many rows per session**). So a `session`
   is not a workflow run; it _contains_ many of them.

2. **The execution code already matches the glossary.** `Turn` (`startTurn` / `TurnExecutionResult`),
   `iteration` / `maxIterations` (used only as an integer index), `runId`, `RunStatus`, `LoopStopReason`,
   `LoopManager`, Tracker, Skeleton, Terminal Marker, and the Composed System Prompt all already align with
   the intended meanings. The remaining inconsistency is concentrated in **prose/docs**, not in code.

There are also two genuinely different bounded contexts that collide only on the bare English words:

- **Feed-pipeline** (`CONTEXT.md`, `src/core/feed/`): `Session` = a drisp instance lifecycle; `Run` = one
  agent invocation within a session (the FeedMapper concept), bounded by a trigger (prompt / resume / clear /
  compact). These are _observation / projection_ concepts owned by the FeedMapper.
- **Workflow-execution** (`UBIQUITOUS_LANGUAGE.md`, `src/core/workflows/`): `Workflow Run`, `Turn`,
  `Agent Session`. These are _execution / control_ concepts owned by the Runner.

The same word means different things in each context (e.g. `feed_events.run_id` is unrelated to
`workflow_runs.id`; the gateway's `Dispatch turn` is unrelated to an execution `Turn`).

## Decision

**1. Canonical hierarchy.** The execution units nest as:

```
Athena Session        durable work-unit; one ~/.config/athena/sessions/<id>/session.db   (`session` table)
  └── Workflow Run     one loop execution; runId UUID                                     (`workflow_runs`)
        └── Turn       one `claude -p` / Codex `thread.run`                               (startTurn/TurnExecutionResult)
              └── Agent Session   the FRESH vendor session/thread per Turn (no --resume)  (SessionController)
```

**Feed Run** is a _parallel projection_, not a level in this tree: the UI/timeline unit bounded by a
trigger. The glossary's earlier "Athena session = Workflow Run" claim is corrected to "Athena Session
contains many Workflow Runs."

**2. Keep the two bounded contexts separate, joined by an explicit cross-walk.** Do not merge the
glossaries and do not let one subsume the other. The fix for the colliding words is **qualification, not
unification** — every use carries its context-qualifier. The shared artifact is one cross-walk table
embedded in both `CONTEXT.md` and `UBIQUITOUS_LANGUAGE.md`:

| Bare word | Feed-pipeline meaning                     | Workflow-execution meaning                                          | Persistence reality                             |
| --------- | ----------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------- |
| session   | FeedMapper `Session` (drisp instance)     | **Athena Session** (durable) or **Agent Session** (per-Turn vendor) | `session` table                                 |
| run       | **Feed Run** (trigger-bounded projection) | **Workflow Run** (loop execution)                                   | `feed_events.run_id` ≠ `workflow_runs.id`       |
| turn      | Gateway **Dispatch turn** (`dispatchId`)  | **Turn** (`startTurn`)                                              | `gateway_function_invocations` vs no Turn table |

**3. Keep `AthenaSession`; add `Agent Session` for the vendor concept.** The durable type is already named
`AthenaSession` (`src/infra/sessions/types.ts`), so the collision with the vendor session is already avoided
in code. Introduce `AgentSession` as a thin documented alias on the vendor seam
(`src/harnesses/contracts/session.ts`, over `SessionController`).

**4. Keep `iteration` as an integer index.** It is already used as the Turn's index, not as a standalone
concept. Prose says "Turn N (iteration N)"; no code change.

**5. Rename the protocol to `Stateless Turn Protocol`.** Its previous title named the per-invocation unit
"session"; in that document "session" means a Turn, and the body prose is being rewritten to "Turn", so the
title follows for internal consistency.

**6. Do NOT rename persistence identifiers.** The `session` / `workflow_runs` / `adapter_sessions` table and
column names (`session_id`, `run_id`, …) stay as legacy names, explained by the cross-walk mapping above.

## Consequences

Positive:

- A single, vendor-aligned hierarchy that the protocol prose, the domain docs, and the code all agree on.
- The two bounded contexts stay legible and decoupled; ambiguous words are always qualified.
- The clarity wins land where they are cheap and zero-risk (docs + a couple of non-persisted type aliases).
- Future contributors don't re-litigate the deliberate non-actions (no DB rename, keep `AthenaSession`).

Negative / costs:

- The persistence layer keeps names (`session_id`, `workflow_runs`) that don't perfectly match the spoken
  vocabulary; understanding them requires the cross-walk mapping rather than being self-evident.
- One extra type alias (`AgentSession`) alongside the structural `SessionController`.

## Rejected Alternative - Rename persistence identifiers (v7 migration)

Rename `session` / `session_id` / related columns to match the spoken vocabulary via a new schema-version
migration. Rejected for this pass: `src/infra/sessions/schema.ts` uses hand-rolled, version-gated migrations
applied on database open, so a rename would be a v7 migration over every live
`~/.config/athena/sessions/*/session.db`, with foreign-key cascades across `adapter_sessions`,
`channel_messages`, `gateway_function_invocations`, and `workflow_runs` (~67 reference points). High risk to
live user data for near-zero semantic payoff — the cross-walk mapping removes the human ambiguity without
touching persisted data.

Reopen this ADR if a schema migration is required for another reason and can absorb the renames cheaply, or
if the legacy names prove to cause recurring confusion despite the documented mapping.

## Rejected Alternative - Merge the two glossaries into one vocabulary

Collapse the feed-pipeline `Session`/`Run` and the workflow-execution `Workflow Run`/`Turn` into a single
set of words. Rejected because they are genuinely different bounded contexts (projection vs control) with
different lifecycles and different data; forcing one vocabulary would mislabel one side. Qualification (Feed
Run vs Workflow Run, Athena Session vs Agent Session, Dispatch turn vs Turn) preserves both meanings.

## References

- `UBIQUITOUS_LANGUAGE.md` - workflow-execution glossary + cross-walk to vendor docs
- `CONTEXT.md` - feed-pipeline domain language (Session, Run, Dispatch turn)
- `src/infra/sessions/schema.ts` - `session`, `workflow_runs`, `adapter_sessions` tables (legacy names)
- `src/core/workflows/stateMachine.md` - the Stateless Turn Protocol
- `src/core/workflows/types.ts` - `RunStatus`, `LoopStopReason`
- `src/core/feed/entities.ts` - feed `Run` / `RunStatus` (the projection)
- `src/harnesses/contracts/session.ts` - `SessionController` (the per-Turn Agent Session seam)
- Plan: `~/.claude/plans/plan-the-fix-for-majestic-bee.md`
