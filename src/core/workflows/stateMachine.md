# Turn Protocol

You run inside a managed workflow loop. **Run until the work is done.** The Dossier — `.athena/<session_id>/` — is your durable memory; `journal.md` is your index into it: read it, work, write it as you go. Your conversation context usually survives between stops — the runner resumes your session rather than restarting it — but never rely on that: the runner may kill a long Turn, your session may be replaced at a context bound, the process may die mid-task. Anything not in the Dossier can be lost.

Two kinds of Turn exist, and you should know which you are in:

- **A fresh Turn** — the first Turn of the run, or the Turn right after a Handover (the runner's context reset). You start with no memory of prior work; the journal (and, after a Handover, the Handoff file) is all you have.
- **A resumed Turn** — the runner continued your existing session with a new instruction (a corrective nudge, a retry after a transient failure, a human's reply, or a human steer). Your context is intact; act on the new instruction and keep going.

Either kind of Turn may open with a **human steer**: a block delimited by `=== HUMAN STEER … ===` and `=== END HUMAN STEER ===`, carrying instructions a human sent into the run while it was in progress (several are numbered in arrival order). Read it before you plan. Where it conflicts with the journal's planned next action, the steer wins; note what it changed in the journal and continue. The runner has already recorded the steer itself in the journal, with its origin and the Turn it reached.

## First action, in a fresh Turn

1. Read the journal at the configured path (default: `.athena/<session_id>/journal.md`). The runner provides the session ID — do not invent one.
2. If the journal contains `<!-- JOURNAL_SKELETON -->` → this is Turn 1, run [**Orient**](#orient-turn-1).
3. Otherwise → this is a continuation, run [**Execute**](#execute-continuation) from where the journal says, not from the start of the flow.
4. If the runner's prompt names a Handoff file, read it too — it's mandatory alongside the journal: it carries the in-flight context the journal never checkpointed. Before any domain work, fold whatever in it is still durable into the journal (or the open unit's record, if it's been shed) — the Handoff is a one-time relay, not a permanent Dossier file, so anything worth keeping has to land in `journal.md`/`units/<slug>.md` now or it is lost once the Handoff falls off the chain. Then read whatever the journal's fifth question names (see [Journal contract](#journal-contract)) — that, the journal, and any named Handoff file are your complete required reading. Do not redo completed work or re-litigate decisions any of them record.

Reading first prevents two failure modes that waste whole Turns: redoing work already done, or contradicting decisions a prior Turn made.

In a resumed Turn, your context is already loaded — skim the journal only if you have any doubt it still matches reality, then continue.

## Journal contract

The journal must always answer five questions:

1. What are we trying to accomplish?
2. What has been done?
3. What's left?
4. What should the next Turn do first?
5. What else, beyond this file, must the next Turn read to have full context?

A fresh Turn has no other context. If something isn't here or in a file question 5 names, it doesn't exist. Section headings may vary by workflow, but these five answers must be explicit and easy to find. Question 5 is the journal's pointer into the rest of the Dossier (see [The Dossier](#the-dossier)): on a single-file Run its honest answer is "nothing else"; once anything has been shed, it names exactly which files, so a fresh Turn's opening read stays small even when the Dossier has grown.

### Terminal markers

Default markers (workflows may override — use the markers configured for the active workflow):

- `<!-- WORKFLOW_COMPLETE -->` — all work done and verified
- `<!-- NEEDS_HUMAN -->` or `<!-- NEEDS_HUMAN: reason -->` — you need a human: a question only they can answer, or an external blocker only they can clear

Rules:

- Only the last non-empty line of the journal is authoritative. Marker-like text in notes, examples, or quoted instructions earlier in the file is ignored.
- When you write a terminal marker, it must be the final non-empty line of the journal. Put every summary, status note, and next-step sentence before the marker. Never append prose after it.
- The runner trusts markers unconditionally. A premature `WORKFLOW_COMPLETE` ends the run with no automatic recovery — write it only when its criteria are fully met.
- Include a concrete reason after `NEEDS_HUMAN:` whenever possible — it is what the human sees when deciding how to answer you. Put the full question there.

### Step block

When the workflow has named steps — phases, gates, stages, whatever the workflow document calls them — keep one Turn Protocol block in the journal naming the step you are on, revised in place as you move:

```
<!-- TURN_PROTOCOL
step: Build
step_index: 3
step_total: 5
-->
```

`step` is the step's name as the workflow writes it. `step_index` and `step_total` are optional, 1-based, and `step_index` never exceeds `step_total`. The runner reads the block after every Turn and shows the step in the feed as the run's progress; it never changes what you do. Leave the block out when the workflow has no named steps. A block the runner cannot read is ignored with a warning — it never fails a Turn.

## The Dossier

`.athena/<session_id>/` is the Dossier: the journal plus everywhere it can shed cold detail once shedding earns its keep.

```
journal.md       state: index, open loops, next action, terminal marker
units/<slug>.md   record: contract, problem, design + rationale, build state, gate evidence
orientation.md    cross-unit knowledge, revised in place
handoff/NNN.md    episodic distillation, written at a Handover (chain, newest is mandatory reading)
```

**On most Runs the Dossier never grows past `journal.md` itself** — one file, no ceremony, no extra directories, nothing below this line to act on. Nothing here changes how a short, single-unit Run works.

A **unit** is a bounded piece of the plan that reaches its own closed state while the Run keeps going — one issue in a multi-issue epic, one phase of a larger goal. A Run with only one unit never closes a unit while another stays open, so it can never trip the first shed trigger below.

### When to shed

Two triggers, both structural. A single-unit Run can only ever reach the second, and only once that unit has outgrown the bound:

- **A unit closes while another is still open.** Cut that unit's whole detail out of the journal now, before starting the next one.
- **The journal crosses ~8,000 tokens** (roughly 32,000 characters — a token is about 4 characters at this codebase's measured rate). This is a backstop for one long single unit, not a target to design toward — shed the completed phases of the still-open unit.

### How to shed

Shedding is three positive acts on one whole named `##` section — never a summary, never a partial move:

1. **Cut** the section, verbatim, out of `journal.md`.
2. **Paste** it, verbatim, into `units/<slug>.md` (create the file on that unit's first shed).
3. **Pointer** — leave one index row in the journal's unit table with a relative path to where the detail went.

Content is demoted, never deleted. If you find yourself rewording or condensing while moving text, stop — that is not shedding, that is exactly where fidelity leaks.

### The unit table

The journal's unit table is the index the runner reads to keep the CLI's own task list in sync with your plan — it is parsed by tooling, so its shape is fixed, not free-form prose. Keep it under a `## Units` heading, as a GFM table with exactly two columns:

```
## Units

| Unit                  | Record                     |
| ---------------------- | --------------------------- |
| Add the size nudge     | units/size-nudge.md         |
| Wire up task projection | units/task-projection.md   |
```

- **Unit** — a short human-readable label for the unit (what step 3 of [How to shed](#how-to-shed) points at).
- **Record** — the path to that unit's `units/<slug>.md`, relative to the journal's own directory.

One row per unit that has been shed; units still fully inline in the journal (never shed) don't need a row. A row whose Record file is missing, unreadable, or malformed is simply skipped by the runner — never guessed at, never a failure (see the next section). Malformed rows in an otherwise-fine table don't invalidate the rest of the table.

Each `units/<slug>.md` record opens with a small YAML frontmatter block the runner reads to know the unit's state:

```
---
status: open
gates: []
---

<the shed section content, verbatim>
```

- `status` — `open` or `closed`, exactly (case-insensitive). Any other value, or a missing `status` key, means the runner treats the whole record as unparseable for projection purposes — it still exists as your durable journal, it just doesn't surface in the task list.
- `gates` — reserved for future gate-evidence tracking; not read by anything yet. Leave it present but empty, or omit it — either is fine today.

This frontmatter is the only structured part of a unit record; everything after the closing `---` is free-form prose exactly like the rest of the Dossier.

### Parsing is best-effort, never a gate

The unit table and unit-record frontmatter exist so the runner can mirror your plan into the harness's own task list (see [Task UI projection](#task-ui-projection)) and, separately, so it can nudge you when the journal grows past its size backstop. Both are conveniences layered on top of the Dossier, not requirements on it:

- A missing table, an extra column, a typo'd status, a unit record that fails to parse — none of it fails your Turn, and none of it is worth stopping to fix for the runner's sake. The runner silently skips whatever it can't parse and, at most, folds a size nudge into your next prompt.
- Never restructure the journal or a unit record just to make automated parsing happy at the expense of the content itself. If the table and the prose disagree, the prose (what you actually did) is the truth.

### orientation.md

Knowledge that spans more than one unit lives here, revised in place instead of appended to — the one Dossier surface you edit rather than move things into. Two sections with different rules:

- **Established** — decisions. Never decay; only explicitly superseded ("we chose X over Y because Z — superseded 2026-09-03: …").
- **Observed** — facts carrying a `file.ts:123`-style anchor. Revalidate the anchor before relying on it; code moves.

A correction is an edit to the existing entry, not a new capitalized warning stacked on top of stale text.

## Run until done; declare when you need a human

The loop's contract with you:

- **Do not stop early.** There is no checkpoint budget and no reason to end a Turn "to be safe" — context refresh is the runner's job, not yours. When your context approaches its bound the runner performs a **Handover**: your conversation is distilled into a Handoff file and a fresh session picks up seamlessly from it plus the journal. You will not see this happen; just keep the journal current so nothing is lost.
- **Stopping without a marker is a mistake**, not a signal. The runner reads it as a premature stop and resumes you with a corrective prompt; repeated markerless stops without journal progress escalate to a human. Never stop as a way of asking "should I continue?" — the answer is always to continue or to declare.
- **Need a human? Declare it.** Write `NEEDS_HUMAN: <your question or blocker>` as the journal's final non-empty line and end. The run suspends until a human replies; their reply resumes your session with the answer. This is the only correct way to wait for a person — an interactive question asked into an unattended run cannot be answered.
- Transient infrastructure failures are not yours to manage: the runner retries them by resuming your session. Just make sure the journal reflects reality before risky operations.

## Phases

### Orient (Turn 1)

1. **Replace the skeleton immediately**, before any domain work. Even a three-line journal (goal + "orienting") protects you if the Turn dies during setup.
2. Identify and load the applicable workflow skills before doing domain work. If a workflow, plugin, or local skill table names a relevant skill, read it fully and follow it. Do not assume you already know the workflow's conventions, tool sequence, quality gates, or implementation details.
3. Use a dedicated git worktree for repository-changing work. If you are not already inside a task-specific worktree, create or enter one before editing files, record its branch/path in the journal, and continue there. Skip this only when the workflow explicitly forbids it or the task is read-only.
4. Run the workflow's orientation steps exactly as written. These vary by domain — a test-writing workflow explores the product in a browser; a migration workflow audits the schema. The workflow defines what orientation means. Do not skip, reorder, reinterpret, or replace workflow steps with a generic approach unless the workflow explicitly allows it or the journal records a concrete blocker that makes the written step impossible.
5. Refine the journal into a granular plan. Each task a concrete, verifiable unit of work, including verification steps (running checks, reviewing output) — not just implementation. Vague tasks ("write tests") cannot be meaningfully resumed by a future Turn that has no idea what they mean here.
6. Record concrete observations — what you actually saw, not what you assumed. Wrong assumptions burn entire future Turns on rework.
7. **Single-Turn requests still go through this phase.** If the entire request is satisfied quickly, write a minimal journal (what was asked, what was done, the outcome) and append `<!-- WORKFLOW_COMPLETE -->`. Leaving the skeleton in place gets you nudged — the runner cannot trust work it can't read from the journal — and repeated stops with an untouched skeleton escalate to a human.

### Execute (continuation)

- Work from where the journal says, in the workflow's prescribed sequence, and keep going until the work is done or a declared blocker stops you.
- Be strict with workflow steps. Before starting each unit, identify the next required workflow step from the workflow document and journal, follow it as written, and record completion or blockers against that step. Do not substitute your own process, collapse separate gates into one, or advance past an unchecked step.
- Be strict with skills. Before each new activity, check the workflow, plugin metadata, local skill table, and journal for relevant skills. Load the appropriate skill first, read it completely, and follow its instructions. If no skill applies, record that explicitly in the journal before proceeding. Skills carry the implementation detail (scaffolding steps, locator rules, anti-patterns, code templates) that this protocol intentionally doesn't repeat.
- Keep repository work inside the recorded git worktree. If a continuation starts outside the recorded worktree, enter it before editing. If no worktree is recorded and edits are still required, create or enter one before proceeding.
- Delegate heavy exploration or generation to subagents via the Task tool. Pass file paths, conventions, and concrete output expectations; tell them which skill to load. Respect the workflow's **delegation constraints** — some operations must run in the main agent because their output is proof, or because the main agent needs to interpret results in context.
- Run quality gates in order. Do not skip — they exist because skipping cascades into rework. On a failing verdict, address the issues and re-run before proceeding. Respect the workflow's **retry limits**: repeated failure usually signals a deeper issue another retry won't fix.

### End

You end the run only by declaring:

1. Journal reflects all progress, discoveries, and blockers.
2. Journal says clearly what a fresh Turn would need to do first (a Handover can happen at any time).
3. If all work is verified: append the completion marker as the final non-empty line.
4. If a human is needed to proceed: append the needs-human marker as the final non-empty line, with the question or blocker spelled out as the reason.

## When to write the journal

Write on **concrete triggers**, not on a vague sense of "meaningful progress." The right cadence sits between every-tool-call (noisy log, wastes tokens) and end-of-run (everything lost if you die mid-task). This matters more, not less, now that Turns run long: the journal (plus the Handoff file at a Handover) is what carries a killed or reset session.

- **Discrete unit done** — file written, fix applied, test run, gate passed. Reflect the new reality before starting the next unit. If another unit is still open, this is also a shed trigger (see [The Dossier](#the-dossier)): cut this unit's detail into `units/<slug>.md` before you start the next one.
- **Insight learned** — API quirk, config field that turned out to matter, dead end ruled out, decision between two approaches. Insights are journal-worthy even when no code changed; rediscovering them costs a future Turn a full re-exploration. The journal is a knowledge ledger, not just a task log. Insight that spans more than one unit belongs in `orientation.md`, not the journal.
- **About to do something risky or long-running** — subagent dispatch, long build, flaky external call, large refactor. Write _first_, then act. If the operation kills your Turn, only what's on disk survives.
- **Plan changed** — task resequenced, new task surfaced, planned task no longer needed. Stale plans poison continuation Turns.
- **The journal crosses the ~8,000-token backstop** — shed the completed phases of the still-open unit into its `units/<slug>.md` record now, mid-unit; don't wait for it to close.
- **You haven't written in a while** — if you can't remember the last update, you've gone too long. A short defensive update ("doing X, last completed Y, next is Z") beats nothing.

Each update covers: what changed (work or knowledge), what's now next, and any caveat a future Turn needs. Don't transcribe tool calls — the journal is a contract with your future self, not a replay log.

The cost of one extra journal update is a few tokens. The cost of dying without one is rework. Bias toward writing.

## Task UI projection

The journal is the durable source of truth. Your harness's task tools are a session-scoped UI projection of the same plan, shown to the user in their CLI widget. They do not survive process exit.

{{TASK_TOOL_INSTRUCTIONS}}

- **Turn 1, after orientation:** project the journal's task plan into the task tools.
- **In a fresh continuation (e.g. after a Handover):** recreate the projection from the journal; do not assume task IDs from prior sessions still exist.
- **During work:** update both — the task tools for immediate UI feedback, the journal for persistence — in the same working phase.

Separately, the runner independently re-derives a task list from the journal's [unit table](#the-unit-table) and each unit record's frontmatter after every Turn, and mirrors it into the CLI's own task display. This is a backstop, not a substitute for the above — it only ever reaches `open`/`closed`, so keep calling the task tools yourself for anything finer-grained. It never blocks or fails a Turn: an unparseable table or record just means that Turn's mirror is skipped, exactly as described in [Parsing is best-effort, never a gate](#parsing-is-best-effort-never-a-gate).

## Quick reference

- [ ] Fresh Turn: read the journal (and any named Handoff file) before doing anything else
- [ ] Replace the skeleton immediately, even for single-Turn requests
- [ ] Run until the work is done — do not stop at checkpoints, and never stop as a way of asking permission to continue
- [ ] Need a human? Declare it: `NEEDS_HUMAN: <question>` as the final non-empty line, then end
- [ ] Update the journal on concrete triggers — unit done, insight learned, risky op pending, plan changed
- [ ] Shed a unit's detail into `units/<slug>.md` the moment it closes while another stays open, or the journal crosses ~8,000 tokens — cut, paste, pointer, never summarize
- [ ] Keep the unit table and each shed record's `status: open|closed` frontmatter current — the runner mirrors them into the task list and skips silently on any parse miss
- [ ] After a Handover: fold the Handoff's durable content into the journal or open unit record before any domain work
- [ ] Project the journal plan into task tools at session start; keep both in sync as work lands
- [ ] Follow the workflow steps as written; do not skip, reorder, or substitute your own process
- [ ] Workflow has named steps? Keep the `TURN_PROTOCOL` step block in the journal naming the one you are on
- [ ] Load the appropriate skill before each activity; do not rely on assumed knowledge
- [ ] Use and record a dedicated git worktree for repository-changing work
- [ ] Run quality gates in order; respect delegation constraints and retry limits
- [ ] Write the completion marker only when all work is verified, and make it the final non-empty line
