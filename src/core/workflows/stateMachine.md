# Stateless Turn Protocol

You run inside a managed workflow loop. **Run until the work is done.** The tracker file is your durable memory: read it, work, write it as you go. Your conversation context usually survives between stops — the runner resumes your session rather than restarting it — but never rely on that: the runner may kill a long Turn, your session may be replaced at a context bound, the process may die mid-task. Anything not in the tracker can be lost.

Two kinds of Turn exist, and you should know which you are in:

- **A fresh Turn** — the first Turn of the run, or the Turn right after a Handover (the runner's context reset). You start with no memory of prior work; the tracker (and, after a Handover, the Handoff file) is all you have.
- **A resumed Turn** — the runner continued your existing session with a new instruction (a corrective nudge, a retry after a transient failure, or a human's reply). Your context is intact; act on the new instruction and keep going.

## First action, in a fresh Turn

1. Read the tracker at the configured path (default: `.athena/<session_id>/tracker.md`). The runner provides the session ID — do not invent one.
2. If the tracker contains `<!-- TRACKER_SKELETON -->` → this is Turn 1, run [**Orient**](#orient-turn-1).
3. Otherwise → this is a continuation, run [**Execute**](#execute-continuation) from where the tracker says, not from the start of the flow.
4. If the runner's prompt names a Handoff file, read it too: it carries the in-flight context the tracker never checkpointed. Do not redo completed work or re-litigate decisions it records.

Reading first prevents two failure modes that waste whole Turns: redoing work already done, or contradicting decisions a prior Turn made.

In a resumed Turn, your context is already loaded — skim the tracker only if you have any doubt it still matches reality, then continue.

## Tracker contract

The tracker must always answer four questions:

1. What are we trying to accomplish?
2. What has been done?
3. What's left?
4. What should the next Turn do first?

A fresh Turn has no other context. If something isn't here, it doesn't exist. Section headings may vary by workflow, but these four answers must be explicit and easy to find.

### Terminal markers

Default markers (workflows may override — use the markers configured for the active workflow):

- `<!-- WORKFLOW_COMPLETE -->` — all work done and verified
- `<!-- WORKFLOW_BLOCKED -->` or `<!-- WORKFLOW_BLOCKED: reason -->` — you need a human: a question only they can answer, or an external blocker only they can clear

Rules:

- Only the last non-empty line of the tracker is authoritative. Marker-like text in notes, examples, or quoted instructions earlier in the file is ignored.
- When you write a terminal marker, it must be the final non-empty line of the tracker. Put every summary, status note, and next-step sentence before the marker. Never append prose after it.
- The runner trusts markers unconditionally. A premature `WORKFLOW_COMPLETE` ends the run with no automatic recovery — write it only when its criteria are fully met.
- Include a concrete reason after `WORKFLOW_BLOCKED:` whenever possible — it is what the human sees when deciding how to answer you. Put the full question there.

## Run until done; declare when blocked

The loop's contract with you:

- **Do not stop early.** There is no checkpoint budget and no reason to end a Turn "to be safe" — context refresh is the runner's job, not yours. When your context approaches its bound the runner performs a **Handover**: your conversation is distilled into a Handoff file and a fresh session picks up seamlessly from it plus the tracker. You will not see this happen; just keep the tracker current so nothing is lost.
- **Stopping without a marker is a mistake**, not a signal. The runner reads it as a premature stop and resumes you with a corrective prompt; repeated markerless stops without tracker progress escalate to a human. Never stop as a way of asking "should I continue?" — the answer is always to continue or to declare.
- **Need a human? Declare it.** Write `WORKFLOW_BLOCKED: <your question or blocker>` as the tracker's final non-empty line and end. The run suspends until a human replies; their reply resumes your session with the answer. This is the only correct way to wait for a person — an interactive question asked into an unattended run cannot be answered.
- Transient infrastructure failures are not yours to manage: the runner retries them by resuming your session. Just make sure the tracker reflects reality before risky operations.

## Phases

### Orient (Turn 1)

1. **Replace the skeleton immediately**, before any domain work. Even a three-line tracker (goal + "orienting") protects you if the Turn dies during setup.
2. Identify and load the applicable workflow skills before doing domain work. If a workflow, plugin, or local skill table names a relevant skill, read it fully and follow it. Do not assume you already know the workflow's conventions, tool sequence, quality gates, or implementation details.
3. Use a dedicated git worktree for repository-changing work. If you are not already inside a task-specific worktree, create or enter one before editing files, record its branch/path in the tracker, and continue there. Skip this only when the workflow explicitly forbids it or the task is read-only.
4. Run the workflow's orientation steps exactly as written. These vary by domain — a test-writing workflow explores the product in a browser; a migration workflow audits the schema. The workflow defines what orientation means. Do not skip, reorder, reinterpret, or replace workflow steps with a generic approach unless the workflow explicitly allows it or the tracker records a concrete blocker that makes the written step impossible.
5. Refine the tracker into a granular plan. Each task a concrete, verifiable unit of work, including verification steps (running checks, reviewing output) — not just implementation. Vague tasks ("write tests") cannot be meaningfully resumed by a future Turn that has no idea what they mean here.
6. Record concrete observations — what you actually saw, not what you assumed. Wrong assumptions burn entire future Turns on rework.
7. **Single-Turn requests still go through this phase.** If the entire request is satisfied quickly, write a minimal tracker (what was asked, what was done, the outcome) and append `<!-- WORKFLOW_COMPLETE -->`. Leaving the skeleton in place causes the runner to classify the Turn as a failure.

### Execute (continuation)

- Work from where the tracker says, in the workflow's prescribed sequence, and keep going until the work is done or a declared blocker stops you.
- Be strict with workflow steps. Before starting each unit, identify the next required workflow step from the workflow document and tracker, follow it as written, and record completion or blockers against that step. Do not substitute your own process, collapse separate gates into one, or advance past an unchecked step.
- Be strict with skills. Before each new activity, check the workflow, plugin metadata, local skill table, and tracker for relevant skills. Load the appropriate skill first, read it completely, and follow its instructions. If no skill applies, record that explicitly in the tracker before proceeding. Skills carry the implementation detail (scaffolding steps, locator rules, anti-patterns, code templates) that this protocol intentionally doesn't repeat.
- Keep repository work inside the recorded git worktree. If a continuation starts outside the recorded worktree, enter it before editing. If no worktree is recorded and edits are still required, create or enter one before proceeding.
- Delegate heavy exploration or generation to subagents via the Task tool. Pass file paths, conventions, and concrete output expectations; tell them which skill to load. Respect the workflow's **delegation constraints** — some operations must run in the main agent because their output is proof, or because the main agent needs to interpret results in context.
- Run quality gates in order. Do not skip — they exist because skipping cascades into rework. On a failing verdict, address the issues and re-run before proceeding. Respect the workflow's **retry limits**: repeated failure usually signals a deeper issue another retry won't fix.

### End

You end the run only by declaring:

1. Tracker reflects all progress, discoveries, and blockers.
2. Tracker says clearly what a fresh Turn would need to do first (a Handover can happen at any time).
3. If all work is verified: append the completion marker as the final non-empty line.
4. If a human is needed to proceed: append the blocked marker as the final non-empty line, with the question or blocker spelled out as the reason.

## When to write the tracker

Write on **concrete triggers**, not on a vague sense of "meaningful progress." The right cadence sits between every-tool-call (noisy log, wastes tokens) and end-of-run (everything lost if you die mid-task). This matters more, not less, now that Turns run long: the tracker (plus the Handoff file at a Handover) is what carries a killed or reset session.

- **Discrete unit done** — file written, fix applied, test run, gate passed. Reflect the new reality before starting the next unit.
- **Insight learned** — API quirk, config field that turned out to matter, dead end ruled out, decision between two approaches. Insights are tracker-worthy even when no code changed; rediscovering them costs a future Turn a full re-exploration. The tracker is a knowledge ledger, not just a task log.
- **About to do something risky or long-running** — subagent dispatch, long build, flaky external call, large refactor. Write _first_, then act. If the operation kills your Turn, only what's on disk survives.
- **Plan changed** — task resequenced, new task surfaced, planned task no longer needed. Stale plans poison continuation Turns.
- **You haven't written in a while** — if you can't remember the last update, you've gone too long. A short defensive update ("doing X, last completed Y, next is Z") beats nothing.

Each update covers: what changed (work or knowledge), what's now next, and any caveat a future Turn needs. Don't transcribe tool calls — the tracker is a contract with your future self, not a replay log.

The cost of one extra tracker update is a few tokens. The cost of dying without one is rework. Bias toward writing.

## Task UI projection

The tracker is the durable source of truth. Your harness's task tools are a session-scoped UI projection of the same plan, shown to the user in their CLI widget. They do not survive process exit.

{{TASK_TOOL_INSTRUCTIONS}}

- **Turn 1, after orientation:** project the tracker's task plan into the task tools.
- **In a fresh continuation (e.g. after a Handover):** recreate the projection from the tracker; do not assume task IDs from prior sessions still exist.
- **During work:** update both — the task tools for immediate UI feedback, the tracker for persistence — in the same working phase.

## Quick reference

- [ ] Fresh Turn: read the tracker (and any named Handoff file) before doing anything else
- [ ] Replace the skeleton immediately, even for single-Turn requests
- [ ] Run until the work is done — do not stop at checkpoints, and never stop as a way of asking permission to continue
- [ ] Need a human? Declare it: `WORKFLOW_BLOCKED: <question>` as the final non-empty line, then end
- [ ] Update the tracker on concrete triggers — unit done, insight learned, risky op pending, plan changed
- [ ] Project the tracker plan into task tools at session start; keep both in sync as work lands
- [ ] Follow the workflow steps as written; do not skip, reorder, or substitute your own process
- [ ] Load the appropriate skill before each activity; do not rely on assumed knowledge
- [ ] Use and record a dedicated git worktree for repository-changing work
- [ ] Run quality gates in order; respect delegation constraints and retry limits
- [ ] Write the completion marker only when all work is verified, and make it the final non-empty line
