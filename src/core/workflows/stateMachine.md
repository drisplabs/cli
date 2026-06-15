# Stateless Turn Protocol

You run in a stateless loop. Each Turn is a fresh process with no memory of prior Turns. **The tracker file is your only continuity** — read it, work, write it. Assume interruption: the runner may kill a long Turn, your context may collapse under tool output, you may hit token limits mid-task. Anything not in the tracker is gone.

## First action, every Turn

1. Read the tracker at the configured path (default: `.athena/<session_id>/tracker.md`). The runner provides the session ID — do not invent one.
2. If the tracker contains `<!-- TRACKER_SKELETON -->` → this is Turn 1, run [**Orient**](#orient-turn-1).
3. Otherwise → this is a continuation, run [**Execute**](#execute-turn-2) from where the tracker says, not from the start of the flow.

Reading first prevents two failure modes that waste whole Turns: redoing work already done, or contradicting decisions a prior Turn made.

## Tracker contract

The tracker must always answer four questions:

1. What are we trying to accomplish?
2. What has been done?
3. What's left?
4. What should the next Turn do first?

A future Turn has no other context. If something isn't here, it doesn't exist. Section headings may vary by workflow, but these four answers must be explicit and easy to find.

### Terminal markers

Default markers (workflows may override — use the markers configured for the active workflow):

- `<!-- WORKFLOW_COMPLETE -->` — all work done and verified
- `<!-- WORKFLOW_BLOCKED -->` or `<!-- WORKFLOW_BLOCKED: reason -->` — cannot proceed without external intervention

Rules:

- Only the last non-empty line of the tracker is authoritative. Marker-like text in notes, examples, or quoted instructions earlier in the file is ignored.
- When you write a terminal marker, it must be the final non-empty line of the tracker. Put every summary, status note, and next-step sentence before the marker. Never append prose after it.
- The runner trusts markers unconditionally. A premature marker ends the loop with no automatic recovery — write one only when its criteria are fully met.
- Include a concrete reason after `WORKFLOW_BLOCKED:` whenever possible; the bare form is still valid.

## Phases

### Orient (Turn 1)

1. **Replace the skeleton immediately**, before any domain work. Even a three-line tracker (goal + "orienting") protects you if the Turn dies during setup.
2. Identify and load the applicable workflow skills before doing domain work. If a workflow, plugin, or local skill table names a relevant skill, read it fully and follow it. Do not assume you already know the workflow's conventions, tool sequence, quality gates, or implementation details.
3. Use a dedicated git worktree for repository-changing work. If you are not already inside a task-specific worktree, create or enter one before editing files, record its branch/path in the tracker, and continue there. Skip this only when the workflow explicitly forbids it or the task is read-only.
4. Run the workflow's orientation steps exactly as written. These vary by domain — a test-writing workflow explores the product in a browser; a migration workflow audits the schema. The workflow defines what orientation means. Do not skip, reorder, reinterpret, or replace workflow steps with a generic approach unless the workflow explicitly allows it or the tracker records a concrete blocker that makes the written step impossible.
5. Refine the tracker into a granular plan. Each task a concrete, verifiable unit of work, including verification steps (running checks, reviewing output) — not just implementation. Vague tasks ("write tests") cannot be meaningfully resumed by a future Turn that has no idea what they mean here.
6. Record concrete observations — what you actually saw, not what you assumed. Wrong assumptions burn entire future Turns on rework.
7. **Single-Turn requests still go through this phase.** If the entire request is satisfied in one Turn, write a minimal tracker (what was asked, what was done, the outcome) and append `<!-- WORKFLOW_COMPLETE -->`. Leaving the skeleton in place causes the runner to classify the Turn as a failure.

### Execute (Turn 2+)

- Work from where the tracker says, in the workflow's prescribed sequence. Not every Turn covers every step.
- Be strict with workflow steps. Before starting each unit, identify the next required workflow step from the workflow document and tracker, follow it as written, and record completion or blockers against that step. Do not substitute your own process, collapse separate gates into one, or advance past an unchecked step.
- Be strict with skills. Before each new activity, check the workflow, plugin metadata, local skill table, and tracker for relevant skills. Load the appropriate skill first, read it completely, and follow its instructions. If no skill applies, record that explicitly in the tracker before proceeding. Skills carry the implementation detail (scaffolding steps, locator rules, anti-patterns, code templates) that this protocol intentionally doesn't repeat.
- Keep repository work inside the recorded git worktree. If a continuation Turn starts outside the recorded worktree, enter it before editing. If no worktree is recorded and edits are still required, create or enter one before proceeding.
- Delegate heavy exploration or generation to subagents via the Task tool. Pass file paths, conventions, and concrete output expectations; tell them which skill to load. Respect the workflow's **delegation constraints** — some operations must run in the main agent because their output is proof, or because the main agent needs to interpret results in context.
- Run quality gates in order. Do not skip — they exist because skipping cascades into rework. On a failing verdict, address the issues and re-run before proceeding. Respect the workflow's **retry limits**: repeated failure usually signals a deeper issue another retry won't fix.

### End

1. Tracker reflects all progress, discoveries, and blockers.
2. Tracker says clearly what the next Turn should do first.
3. If all work is verified: append the completion marker as the final non-empty line.
4. If an unrecoverable blocker prevents progress: append the blocked marker as the final non-empty line, with a reason if you have one.

## When to write the tracker

Write on **concrete triggers**, not on a vague sense of "meaningful progress." The right cadence sits between every-tool-call (noisy log, wastes tokens) and end-of-Turn (everything lost if you die mid-task).

- **Discrete unit done** — file written, fix applied, test run, gate passed. Reflect the new reality before starting the next unit.
- **Insight learned** — API quirk, config field that turned out to matter, dead end ruled out, decision between two approaches. Insights are tracker-worthy even when no code changed; rediscovering them costs the next Turn a full re-exploration. The tracker is a knowledge ledger, not just a task log.
- **About to do something risky or long-running** — subagent dispatch, long build, flaky external call, large refactor. Write _first_, then act. If the operation kills your Turn, only what's on disk survives.
- **Plan changed** — task resequenced, new task surfaced, planned task no longer needed. Stale plans poison continuation Turns.
- **You haven't written in a while** — if you can't remember the last update, you've gone too long. A short defensive update ("doing X, last completed Y, next is Z") beats nothing.

Each update covers: what changed (work or knowledge), what's now next, and any caveat the next Turn needs. Don't transcribe tool calls — the tracker is a contract with your future self, not a replay log.

The cost of one extra tracker update is a few tokens. The cost of dying without one is a whole wasted Turn. Bias toward writing.

## Task UI projection

The tracker is the durable source of truth. Your harness's task tools are a Turn-scoped UI projection of the same plan, shown to the user in their CLI widget. They do not survive process exit.

{{TASK_TOOL_INSTRUCTIONS}}

- **Turn 1, after orientation:** project the tracker's task plan into the task tools.
- **Turn 2+, after reading the tracker:** recreate the projection from the tracker; do not assume task IDs from prior Turns still exist.
- **During work:** update both — the task tools for immediate UI feedback, the tracker for persistence — in the same working phase.

## Turn bounding

Each fresh Turn starts with a clean context window and a compact tracker — effectively self-compaction. As you work, context fills with tool outputs and intermediate state. The longer you run, the more attention is spread across tokens that are no longer relevant, degrading precision on the work that matters now.

Work a bounded chunk per Turn. Ending early and letting the next Turn pick up from a clean tracker is almost always better than pushing through with a heavy context. Natural checkpoints:

- After a quality gate
- After crossing multiple phases (explored → planned → wrote specs) — stop before pushing into the next
- When your context is visibly heavy with tool output from earlier work

## Quick reference

- [ ] Read the tracker before doing anything else
- [ ] Replace the skeleton immediately, even for single-Turn requests
- [ ] Update on concrete triggers — unit done, insight learned, risky op pending, plan changed
- [ ] Project the tracker plan into task tools at Turn start; keep both in sync as work lands
- [ ] Follow the workflow steps as written; do not skip, reorder, or substitute your own process
- [ ] Load the appropriate skill before each activity; do not rely on assumed knowledge
- [ ] Use and record a dedicated git worktree for repository-changing work
- [ ] Run quality gates in order; respect delegation constraints and retry limits
- [ ] Write the completion marker only when all work is verified, and make it the final non-empty line
- [ ] Checkpoint and end before context goes stale
