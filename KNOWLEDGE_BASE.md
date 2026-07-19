# Knowledge Base

Domain language for the **Knowledge Base** — the durable, LLM-maintained wiki
that reconciles plans (intent) with builds (reality) and keeps every claim
traceable to the source that produced it. Maintained entirely by **KB
Workflows**. This is the knowledge-management bounded context; see
[CONTEXT-MAP.md](./CONTEXT-MAP.md).

## Language

### The store

**Knowledge Base (KB)**:
The durable, LLM-maintained wiki — a set of **Wiki Pages** plus a **Provenance
index** — spanning many **Athena Sessions**. Team-scoped, git-versioned. Reads
from **KB Sources**; never edits them.
_Avoid_: wiki (bare), knowledge store.

**Wiki Page**:
One markdown file in the KB, owned entirely by the KB maintainer agent. No Wiki
Page is authored by hand.
_Avoid_: doc, note, article.

**Page kind**:
A **Wiki Page**'s declared type — `plan`, `build`, `concept`, or `entity`. The
`plan` and `build` kinds are the two **tiers** the **Drift finding** classifier
stages contradiction candidates across. A page's tier derives from the **KB
Source** it was ingested from (a **Workflow Run** source → `build`; a file
ingested as intent → `plan`), never from the agent's judgment.
_Avoid_: page type, category, tag.

**KB Source**:
The immutable input a **Provenance link** points back to; the KB is a projection
of it. Two kinds in the MVP: a manually supplied file (PRD, transcript, spec),
or a completed **Workflow Run** taken as its final **Tracker** plus run outcome.
_Avoid_: input, document. _(Future kind: an inbound channel message.)_

**Provenance link**:
A citation from a single **Wiki Page** claim to the **KB Source** that produced
it. Every claim carries one, and a claim may cite only an immutable **KB
Source** — never another **Wiki Page**.
_Avoid_: reference, citation (bare).

**Provenance index**:
The queryable record of all **Provenance links**, letting the KB and **Lint**
traverse claim → source and source → pages.
_Avoid_: citation store.

### Operations

**KB operation**:
One of **Ingest**, **Query**, **Lint**. Each executes as a **KB Workflow**.

**Ingest**:
Fold a **KB Source** into the KB — update the relevant **Wiki Pages** and record
**Provenance links**. Idempotent per source: re-ingesting a known source updates,
never duplicates.
_Avoid_: import, load.

**Query**:
Answer a question from the KB, with **Provenance links** to the sources behind
the answer. The answer is returned to the asker, not automatically filed; a
valuable answer becomes a **Wiki Page** only when a human re-ingests it as a
file **KB Source**.
_Avoid_: search, ask.

**Lint**:
Inspect the KB and report **Lint findings**.
_Avoid_: check, validate.

**KB Workflow**:
A **Workflow** (workflow-execution sense) whose **Composed System Prompt** makes
the agent a disciplined KB maintainer. Each **KB operation** runs as one, driven
by the existing **Runner**. Distributed and upgraded via the **Marketplace**.
_Avoid_: KB agent, maintainer bot.

### Findings

**Lint finding**:
Any issue **Lint** reports about KB health. The umbrella term. Subtypes: the
**Drift finding**, plus hygiene findings — orphan page (no inbound links),
uncited claim, stale claim (superseded by a later source), and missing page (a
known concept with no page). Hygiene findings are classified deterministically.
_Avoid_: warning, error, drift (bare — that names the subclass).

**Drift finding**:
The flagship **Lint finding**: a semantic contradiction where a **Workflow
Run**'s outcome (the build — what shipped) contradicts a plan page's cited
intent. Map-versus-territory divergence. Adjudicated by the agent, not by the
deterministic classifier.
_Avoid_: conflict, staleness (a stale claim is a hygiene finding, not drift).

### Configuration

**KB schema**:
The installed **KB Workflow** definition — conventions plus maintainer
instructions — that configures a KB for a domain. The MVP ships
`team-product-kb`. Distributed and upgraded through the **Marketplace** like any
**Workflow**.
_Avoid_: template, config, profile.
