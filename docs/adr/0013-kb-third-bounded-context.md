# ADR 0013 - The Knowledge Base is a third bounded context

Status: Active
Date: 2026-07-19
Relates to: KB PRD (lespaceman/athena-flow-cli#132)

## Context

The KB PRD proposed adding the KB vocabulary to `CONTEXT.md` "at the highest
point." But `CONTEXT.md` explicitly owns only the **feed-pipeline** bounded
context, kept deliberately separate from **workflow-execution**
(`UBIQUITOUS_LANGUAGE.md`) by ADR 0003. The KB — **KB**, **Wiki Page**, **KB
Source**, **Provenance link**, **Lint finding**, **Drift finding** — is a
distinct knowledge-management context. Folding it into `CONTEXT.md` would undo
exactly the single-context separation ADR 0003 established.

## Decision

Record the KB glossary in its own root doc, `KNOWLEDGE_BASE.md`, and introduce a
root `CONTEXT-MAP.md` that indexes the three bounded contexts and their
relationships:

- feed-pipeline → `CONTEXT.md`
- workflow-execution → `UBIQUITOUS_LANGUAGE.md`
- knowledge-base → `KNOWLEDGE_BASE.md`

The map records the key cross-context relationship: the KB _reads_ a completed
**Workflow Run** (as its final **Tracker** + outcome) as a **KB Source** and
never edits sources; each **KB operation** _executes as_ a **KB Workflow**.

## Consequences

Positive:

- Honors ADR 0003; `CONTEXT.md` stays single-context.
- The previously-implicit multi-context structure becomes explicit and
  discoverable via one index.

Negative / costs:

- One additional root doc plus a map to keep current as the contexts evolve.

## References

- ADR 0003 - two bounded contexts, kept separate and qualified
- `CONTEXT-MAP.md`, `KNOWLEDGE_BASE.md`
