# ADR 0006 - KB storage & provenance: markdown is the source of truth

Status: Active
Date: 2026-07-19
Relates to: KB PRD (lespaceman/athena-flow-cli#132)

## Context

The KB PRD says a separate `kb.db` "holds the provenance index and page
metadata" — implying the **database is authoritative** — while user story #18
wants the KB to be "a plain git repo of markdown" so the team gets version
history, branching, PR review, and Obsidian browsing for free. These conflict:

- A **committed** binary SQLite file produces merge conflicts and a markdown
  tree that is not self-contained (provenance truth lives outside the file).
- A **gitignored** authoritative DB lets the shared artifact (markdown) drift
  from the unshared truth (a teammate who clones gets pages with no index and no
  provenance).

## Decision

**The markdown under `kb/` is the single source of truth.**

- **Provenance lives in the markdown.** A **Provenance link** is recorded in
  page front-matter keyed by the source tuple `(source_kind, source_id,
session_id)`. Provenance is **strict immutable-source**: every **Wiki Page**
  claim cites an immutable **KB Source** — a **Workflow Run**'s final **Tracker**
  or an ingested file — and **never another Wiki Page**.
- **`kb.db` is a derived, gitignored index** (`kb/.index/kb.db`), rebuilt from
  the markdown for fast lookup and to feed the deterministic **Lint** classifier.
  It is disposable; the markdown can always regenerate it.
- **`kb/` is project-scoped**, rooted in the repo and resolved through the
  existing global → project → flags config precedence. A run's KB is the repo it
  ran in; cross-repo / channel routing is deferred with the subscribers (ADR
  0005).
- A valuable **Query** answer becomes a Wiki Page only when a human re-ingests it
  as a **file** KB Source — there is no automatic page-from-synthesis (#8).

## Consequences

Positive:

- #18 holds fully: plain git repo, PR-reviewable, Obsidian-browsable; provenance
  is human-verifiable in the file itself; no binary-in-git, no DB merge conflicts.
- The moat — "every claim carries an immutable receipt" — is structurally
  enforced rather than convention.
- The index is rebuildable, so corruption or schema change is recoverable from
  the markdown.

Negative / costs:

- Rebuilding the index means parsing the markdown tree (cheap at MVP scale;
  revisit if/when FTS or vector search is added — out of scope today).
- Automatic file-back of query answers (#8) is dropped from the MVP in favor of
  a human-gated re-ingest.

## Rejected Alternatives

- **`kb.db` authoritative + committed.** Binary SQLite in git → merge conflicts;
  markdown tree not self-contained.
- **`kb.db` authoritative + gitignored.** Shared markdown drifts from the
  unshared truth; a fresh clone has no provenance.
- **First-class synthetic sources / page→page citations.** Preserves auto-
  compounding but makes receipts derived rather than primary — weakens the moat.

## References

- `src/infra/sessions/store.ts`, `schema.ts` - the typed-sqlite + additive-
  migration pattern the derived `kb.db` mirrors
- `KNOWLEDGE_BASE.md` - KB Source, Provenance link, Provenance index
- ADR 0003 - `feed_events.run_id` as a projection key, not an FK (precedent for
  text-tuple source references)
