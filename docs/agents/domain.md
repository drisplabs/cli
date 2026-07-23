# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **multi-context**: a `CONTEXT-MAP.md` at the root points to three bounded contexts, each owning its own glossary. The bare words _session_, _run_, and _turn_ collide across them and must always be qualified — the cross-walk lives in `CONTEXT-MAP.md`.

## Before exploring, read these

- **`CONTEXT-MAP.md`** (root) first — it names the three contexts and the cross-walk for the colliding words.
- The glossary for the context you're touching:
  - **Feed-pipeline** (observation / projection — FeedMapper, FeedEvent, Feed Run): **`CONTEXT.md`**
  - **Workflow-execution** (execution / control — Runner, Workflow Run, Turn, Tracker): **`UBIQUITOUS_LANGUAGE.md`**
  - **Knowledge-base** (the LLM-maintained wiki — KB, Wiki Page, Drift finding): **`KNOWLEDGE_BASE.md`**
- **`docs/adr/`** (root) — read the ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The producer skill (`/grill-with-docs`) creates and extends them lazily as terms and decisions actually get resolved.

## File structure

```
/
├── CONTEXT-MAP.md          ← names the contexts + colliding-word cross-walk
├── CONTEXT.md              ← feed-pipeline glossary
├── UBIQUITOUS_LANGUAGE.md  ← workflow-execution glossary
├── KNOWLEDGE_BASE.md       ← knowledge-base glossary
├── docs/adr/               ← system-wide architectural decisions
│   ├── 0001-some-decision.md
│   └── 0002-another-decision.md
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the **relevant context's** glossary — and qualify the colliding words (**Feed Run** vs **Workflow Run**, **Athena Session** vs **Agent Session**, **Dispatch turn** vs **Turn**) per `CONTEXT-MAP.md`. Don't drift to synonyms a glossary explicitly lists under "avoid."

If the concept you need isn't in any glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider), or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR 0004 (terminal-outcome owner) — but worth reopening because…_
