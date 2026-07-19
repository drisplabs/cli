# ADR 0009 - `prompt_id` as the authoritative Feed Run boundary trigger

Status: Active
Date: 2026-07-19
Amends: ADR 0003 (execution-unit terminology)

## Context

Claude Code v2.1.196+ stamps a stable `prompt_id` (UUID) on every hook event
once a user prompt is being processed — "the user prompt currently being
processed," absent until the first user input. This gives the harness a
native, per-prompt identity that earlier builds did not expose.

Today the **FeedMapper**'s `RunLifecycle` bounds a **Feed Run** heuristically:
`beginRun` rolls over when it _observes_ a `user.prompt` (or `session.start`)
trigger, and stamps `run_id` as the positional `{session_id}:R{n}`
(`src/core/feed/internals/runLifecycle.ts`; `restoreFrom` parses the `:R(\d+)`
suffix). The boundary is therefore inferred from seeing a specific event, which
is fragile if that event is missing, reordered, or arrives over a transport
that doesn't emit it.

`prompt_id` lets any event — not just the `user.prompt` event — reveal which
prompt it belongs to, so the boundary can be _driven_ rather than _inferred_.
The open question was whether to adopt it as a lightweight boundary trigger or
to make it the Feed Run's identity outright.

## Decision

**1. `prompt_id` (the domain **Prompt**) is the authoritative boundary
trigger when present.** `RunLifecycle` rolls over a Feed Run when the **Prompt**
_changes_, instead of when a `user.prompt` event is observed.

**2. `run_id` format is unchanged.** It stays the positional
`{session_id}:R{n}`. No `restoreFrom` regex change, no `feed_events` schema
migration. `prompt_id` is persisted as an additional **correlation column** on
`feed_events`, not as the run identity.

**3. Heuristic fallback is retained.** Before the first user input (session
bootstrap) and on harnesses/versions that don't emit `prompt_id`, the existing
`session.start`/`user.prompt` heuristic bounds runs. This keeps the codebase's
"detect + display, never gate" version policy intact — support degrades to the
current behavior instead of failing.

**4. Terminology.** **Prompt** is added to the feed-pipeline glossary
(`CONTEXT.md`) as the harness-native identity that bounds a **Run** when
present. This extends ADR 0003's cross-walk: the bare word _run_ still maps to
**Feed Run** / `feed_events.run_id`; **Prompt** is a boundary _trigger_, not a
new execution unit, so the ADR-0003 hierarchy is unaffected.

## Consequences

Positive:

- Feed Run boundaries become robust to a missing/reordered `user.prompt` event —
  any event in the prompt can establish the boundary.
- A stable, harness-native correlation key (`prompt_id`) is persisted for
  downstream (dashboard) correlation, without touching run identity.
- Zero migration and zero change to ADR-0003's execution-unit hierarchy.

Negative / costs:

- Two boundary mechanisms coexist (Prompt-driven vs heuristic); their
  equivalence on modern Claude must be covered by tests to prevent drift.
- `feed_events` gains a nullable `prompt_id` column that is unset for
  pre-prompt and older-harness events.

## Rejected Alternative - `run_id` becomes `prompt_id`

Make the Feed Run's identity literally the prompt UUID. Rejected: it changes
the `feed_events.run_id` format, forces a rewrite of the `:R(\d+)` `restoreFrom`
parsing and the ADR-0003 **Feed Run** definition, requires a migration over
persisted sessions, and needs synthetic ids for the pre-prompt bootstrap run
and for older Claude (no `prompt_id`). Large blast radius for identity purity
that the correlation column already delivers. Reopen if run identity ever needs
to be harness-portable across persistence boundaries.

## References

- `src/core/feed/internals/runLifecycle.ts` - the Run boundary + `run_id` format
- `CONTEXT.md` - feed-pipeline glossary (**Prompt**, **Run**, **RunLifecycle**)
- ADR 0003 - execution-unit terminology (Feed Run vs Workflow Run)
- Claude Code hooks reference - `prompt_id` common input field (v2.1.196+)
