# ADR 0015 - The Tracker holds state and sheds cold context into an append-only Dossier

Status: Active
Date: 2026-09-02
Relates to: ADR 0003 (execution-unit terminology), ADR 0004 (terminal-outcome owner),
ADR 0011 (KB storage and provenance), ADR 0014 (handover, retry, attention, continuation)

> **Terminology note (2026-09-03, #185):** the **Tracker** this ADR splits is now the **Journal** (`journal.md`; an existing `tracker.md` keeps being read for one release). §1's phrase "the Dossier holds the journal" uses _journal_ in the diary sense — those files are the **Unit Records**; the index file is the **Journal**. The Dossier split itself, its triggers, and `cut → paste → pointer` are unchanged. The text below is preserved as decided. See the Deprecated names table in `UBIQUITOUS_LANGUAGE.md`.

## Context

The **Tracker** is the only durable carrier of an **Athena Session**'s context. ADR 0014 added the
**Handoff file** beside it, but everything else — plan, decisions, discovered knowledge, gate
evidence, cross-Run state — lands in one markdown file that grows without bound.

Measured across 403 real Trackers on a developer machine (tokens, o200k proxy at ~4.0 chars/token):

| percentile | tokens |
| ---------- | ------ |
| p50        | 764    |
| p90        | 7,901  |
| p95        | 13,259 |
| p99        | 33,854 |
| max        | 42,141 |

**This is a tail problem.** Only 21 of 403 Trackers exceed 13k tokens. The median Run is a
764-token file that works fine and must not be taxed by any of this.

The tail, however, is where the expensive unattended multi-Run work lives. The p99 Tracker (a
10-issue epic, 33,854 tokens) is **26% of `DEFAULT_MAX_TURN_TOKEN_COUNT`** (`types.ts:18`, 130,000)
— spent on the first action of every fresh Turn, before any work. Its composition:

| content                                   | tokens | share |
| ----------------------------------------- | ------ | ----- |
| unit detail (intake/problem/design/build) | 14,978 | 44%   |
| gate evidence (review/verification)       | 6,304  | 19%   |
| orientation (discovered knowledge)        | 6,244  | 18%   |
| index-ish (goal, graph, next-session)     | 4,357  | 13%   |
| delivery (PR/commit state)                | 1,971  | 6%    |

Only the last two rows and the _open_ unit are live. Roughly 28k tokens of that file is closed work
that no agent will act on again.

**The growth is a symptom, not the disease.** Every long Tracker in the corpus is append-structured
— `#123 (DONE)`, `#124 (DONE)`, `session 3`, `session 4`. The agent appends because appending is the
only write mode that cannot lose information, and it has nowhere safe to put what it would displace.
One Tracker even carries `## ⚠️ TOPOLOGY CORRECTION (supersedes prior notes)` in capitals, because in
an append-only file there is no way to un-write a mistake. So the question is not "how do we split
files"; it is **how do we make it safe for the agent to stop appending**.

Two further defects surfaced while measuring, both independent of size:

1. **A Workflow Run's intent could exist nowhere on disk.** `defaultCreateTracker` writes
   write-if-absent, so the skeleton — and with it the `**Goal**: {input}` substitution — was written
   once per file, not once per Run. One observed Athena Session ran four Workflow Runs against a
   single Tracker; Runs 2-4 never recorded what they had been asked to do, and inherited their
   predecessor's Terminal Marker. The fourth opened 33,854 tokens of nine finished issues, ran one
   Turn, and wrote `WORKFLOW_COMPLETE`. _Fixed by #171, which implements §5 below._
2. **Serial Handovers shredded their own history.** The Handover orchestrator deleted the single
   `handoff.md` before each fork, so Handoff N was destroyed before N+1 was written and past the
   second Handover only the Tracker survived — precisely the "the Tracker is the sole carrier"
   condition ADR 0014 §5 intended to relieve. _Fixed by #170, which implements the chain in §8._

Both were found while measuring for this ADR and landed ahead of it, because neither depends on
anything decided here. They are recorded because they are the evidence that cross-Run and
cross-Handover continuity had already failed by construction, not merely by file size.

The corpus also shows what agents comply with. Unprompted, they invent side files
(`orientation-core-165.md`, `design-note.md`, `issues/84.md`, `scratch/`) — positive structural moves
they were never asked for. Yet the `handoff` skill's explicit **prohibition** on writing secrets was
violated: a live staging admin password sits in plaintext in a Handoff file on disk. **Agents follow
structure and ignore prohibitions**, and this decision is built accordingly.

## Decision

**1. The Tracker holds state; the Dossier holds the journal.** The Tracker carries current truth and
next intent only, and is **revised in place**. Cold detail moves into an **append-only** sink. The
Tracker becomes bounded by construction rather than by discipline, and appending stops being the
agent's only safe write.

**2. The Dossier is emergent — one file until it earns a second.** `.athena/<session_id>/` is the
**Dossier**; a Run that never trips a shed trigger has a Dossier of exactly one file, identical to
today. Nothing in this ADR fires for the median 764-token Run.

```
tracker.md          state: index, open loops, next action, terminal marker
units/<slug>.md     journal: contract, problem, design + rationale, build state, gate evidence
orientation.md      cross-unit knowledge, revised in place
handoff/NNN.md      episodic distillation (ADR 0014 §5)
```

Four files, not five. Gate evidence stays inside the unit record: once a unit closes, nothing in that
record is read again, so separating bulky-cold from cold buys nothing that shedding has not already
bought.

**3. Two shed triggers, both structural.** (a) A unit closes **while another is still open**.
(b) The Tracker exceeds ~8,000 tokens (~6% of `maxTurnTokenCount`) — shed the completed phases of the
open unit. Trigger (a) cannot fire on a single-unit Run at all — it requires a second unit still
open — so (b) is the only trigger such a Run can reach, and only once that one unit has outgrown the
bound. The first is what an agent can execute deterministically; the second is the backstop for the
single long unit.

**4. Shedding is `cut → paste → pointer`.** A whole named `##` section moves verbatim; the Tracker
keeps one index row and a path. Three positive acts, deliberately _not_ phrased as "do not summarise
while shedding" — summarisation during a move is where fidelity would leak, and the corpus says a
prohibition would not hold. **Content is demoted, never deleted.**

**5. A Run boundary is a first-class Dossier entry.** Every Workflow Run start opens a Run section
carrying that Run's id and goal, whether or not the Tracker already exists, and demotes any Terminal
Marker already on the Tracker into an inert historical note — no Run inherits a predecessor's
verdict. A wake continues the same Run and opens no section. This is independent of everything above
and affects every multi-Run Athena Session regardless of size. **Landed in #171.**

**6. Read contract: Tracker + newest Handoff are mandatory; the Tracker names the rest.** The
Tracker's four questions become five, the fifth being an explicit required-reading file list. On the
p99 Tracker this takes a fresh Turn's opening read from **33,854 to ~5,700 tokens** — 4% of the Turn
budget instead of 26% — with nothing lost and everything one link away.

**7. Athena reads the Dossier; it never writes it.** The machine-readable surface is the Tracker's
unit table and each unit record's YAML frontmatter (`status`, `gates`), projected into the harness
task tools. A parse miss degrades to no projection and at most a nudge — never a failed Turn, never a
guessed status. When Athena learns something the agent needs (CI went green), it arrives as a prompt
on the next Turn. ADR 0004's one-owner property is preserved: a second writer on agent-owned prose
would destroy it.

**8. The Handoff is a chain, and its size is a fidelity metric.** `handoff/NNN.md`, keep the last two,
newest is mandatory-read, and the incoming Turn folds anything durable into the Tracker and unit
record **before** domain work. The Handoff measures the delta between what the conversation held and
what the Dossier captured; a persistently large Handoff means the Dossier is under-capturing, and the
Runner already has the bytes to say so. **The chain and its retention landed in #170**; the fold-in
obligation and the metric are protocol and Runner work this ADR still owes.

> Extended by ADR 0018: the Handoff's similarity to its predecessor is a _progress_ metric — two
> near-identical consecutive Handoffs mean the session between them added nothing. The fold-in
> obligation stands; its execution as an appended "Handoff N processed" note is forbidden.

**9. `orientation.md` earns its place on revisability, not deduplication.** Measured cross-unit
overlap is clustered and modest (`#126`-`#129` share `mapper.ts`/`runSessionProjection.ts`; nothing
across clusters), so deduplication is a minor gain. The real justification is that it is the only
**revisable** surface — the fix for the shouted-correction pathology. Two sections with different
maintenance rules: **Established** (decisions; never decay, only explicitly superseded) and
**Observed** (facts carrying `file.ts:267` anchors; revalidated before being relied on).

**10. A KB Source becomes a Tracker plus its transitive closure, gated by redaction.** ADR 0011's
Source goes from one file to a file and the spokes it links. The redaction gate is not optional:
`.athena/` is gitignored but the KB is git-versioned, and a plaintext credential already exists in a
Handoff file despite an explicit rule against it. Honour-system redaction is empirically insufficient
at the boundary where files become durable and shared.

**11. The protocol is renamed the Turn Protocol.** ADR 0014 recorded that "Stateless" had stopped
being true and deferred the rename to avoid a ripple through `stateMachine.md`, `stateMachine.ts`,
the marketplace mirror at `shared/state-machine.md`, and the glossary. This decision touches every
one of those files already.

## Consequences

Positive:

- The p99 fresh-Turn opening read drops ~6x with no information loss, because bounding happens by
  **moving**, never by dropping.
- Per-unit records can be richer than today's Tracker sections. The agent currently self-censors
  detail precisely because it must re-read everything it writes; shedding removes that pressure, so
  the economics fix buys fidelity rather than trading against it.
- A Run's intent is on disk for every Run (§5), and a Handover chain no longer destroys itself (§8).
  Both shipped ahead of this ADR and hold independently of the split.
- `orientation.md` gives corrections somewhere to land as edits instead of as capitalised warnings
  layered over stale text.
- The KB gains better build-tier sources: a unit record with its gate evidence is a cleaner
  provenance target than an undifferentiated 34k-token file.

Negative / costs:

- **This fires for ~5% of Runs.** The median Run gains nothing and must be verified to lose nothing.
  If the protocol text reads as "four mandatory files" rather than "one file that sheds," the change
  is a net loss and should be reverted.
- **Shedding is an LLM-executed refactor of its own memory.** A mis-shed — a still-hot fact moved
  into a cold record — degrades the next Turn silently, with only the index as evidence. §4 confines
  the operation to verbatim whole-section moves to make it mechanical, but it is not verifiable.
- The Runner's read of the Tracker widens from one line to a tolerantly-parsed table (§7), which is
  a genuine loosening of ADR 0004's minimal contract even though the writer stays singular.
- Three artifacts must move together: `stateMachine.md`, the marketplace mirror, and the glossary.
  A workflow shipping the old protocol text will instruct agents into the old shape.
- A KB Source becoming a closure (§10) complicates ADR 0011's text-tuple provenance, which assumed
  one file per source.

## Relationship to prior ADRs

- **Amends ADR 0003 / ADR 0014.** ADR 0014 already narrowed the Tracker's role to "durability,
  Handover seed, and human-facing ledger." This adds a fourth role — a machine-read index — and
  splits the ledger from the state. That is why this is a new ADR rather than an amendment to 0014.
- **Amends ADR 0004.** The Tracker-end-state → Run Status map is untouched; the Runner's _read_ of
  the Tracker widens beyond the terminal marker. The one-owner property is preserved by §7.
- **Amends ADR 0011.** KB Source: one file → a file and its transitive closure, plus a redaction gate.

## References

- `src/core/workflows/workflowRunner.ts` — write-if-absent skeleton (:343) and `openRunSection`
  (:163, called :410) from #171; the Handoff chain `nextHandoffPath`/`purgeHandoffs` (:322, :329)
  from #170
- `src/core/workflows/types.ts` — `DEFAULT_MAX_TURN_TOKEN_COUNT` (:18)
- `src/core/workflows/trackerReader.ts` — `DEFAULT_TRACKER_PATH` (:21), Tracker parsing,
  `demoteTerminalMarkers` (:159)
- `src/core/workflows/stateMachine.md` — the protocol; Tracker contract and write triggers
- `src/core/workflows/builtins/handoffSkill.ts` — the `handoff` skill, including its redaction rule
- `KNOWLEDGE_BASE.md`, ADR 0011 — KB Source and provenance
- `UBIQUITOUS_LANGUAGE.md` — Tracker, Turn, Agent Session, Handover, Handoff file
