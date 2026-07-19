# Ubiquitous Language

Domain glossary for Athena's workflow execution — the Stateless Turn Protocol and its runner. Extracted from analysis of `src/core/workflows/` and `src/harnesses/claude/`.

## Execution units

Definitions below are reconciled against the official vendor docs (see [Cross-walk](#cross-walk-to-official-terminology)). Where Athena's current code naming clashes with the vendor meaning, the recommended term is given and the clash is noted in [Flagged ambiguities](#flagged-ambiguities).

The four execution units nest. **Feed Run** is a parallel UI projection, not a level in this tree:

```
Athena Session        durable work-unit; one ~/.config/athena/sessions/<id>/session.db   (`session` table)
  └── Workflow Run     one loop execution; runId UUID                                     (`workflow_runs`)
        └── Turn       one `claude -p` / Codex `thread.run`                               (startTurn/TurnExecutionResult)
              └── Agent Session   the FRESH vendor session/thread per Turn (no --resume)  (SessionController)
```

| Term               | Definition                                                                                                                                                                                                                                                                   | Aliases to avoid                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Athena Session** | The durable work-unit: one `~/.config/athena/sessions/<id>/session.db` (the `session` table). **Contains many Workflow Runs.** This is what the `athena-<id>` / `.athena/<id>/` identity and `session.db` identify — _not_ a vendor session and _not_ a single Workflow Run. | Session, vendor session, Workflow Run |
| **Workflow Run**   | One execution of a whole workflow — the loop spanning every Turn from start to a terminal status. Identified by a `runId` UUID (`workflow_runs` row, FK `session_id → session`); **many per Athena Session.**                                                                | Run, job, task, **session**           |
| **Turn**           | One agent execution — a single `claude -p` invocation / one Codex `thread.run` — that runs one prompt to completion. The canonical unit.                                                                                                                                     | Iteration, session, call, run         |
| **Agent Session**  | The vendor-native conversation context a Turn runs in: a Claude Code _session_ or a Codex _thread_. In Athena each Turn gets a **fresh** one (no resume); the tracker, not the Agent Session, carries continuity.                                                            | Conversation, thread (use per-vendor) |
| **Iteration**      | The integer index of a Turn within a Workflow Run (Turn 1, 2, …). Not a unit of its own — _one iteration == one Turn_. Not a vendor term.                                                                                                                                    | Cycle, round, pass                    |
| **Feed Run**       | The UI/timeline projection of activity bounded by a trigger (prompt submit, resume, clear, compact); distinct from a Workflow Run. `feed_events.run_id` is unrelated to `workflow_runs.id`.                                                                                  | Run                                   |

## State & continuity

| Term                       | Definition                                                                                                           | Aliases to avoid                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **Tracker**                | The on-disk markdown file that is the sole durable state carried between Turns                                       | Log, state file, journal, progress file |
| **Skeleton**               | The placeholder Tracker the runner writes before Turn 1, marked `<!-- TRACKER_SKELETON -->`                          | Template, stub                          |
| **Terminal Marker**        | The last-line sentinel in the Tracker that signals a terminal state (`WORKFLOW_COMPLETE` / `WORKFLOW_BLOCKED`)       | Flag, tag, signal                       |
| **Composed System Prompt** | The per-run generated file (`.composed-system-prompt.md`) = Protocol + Workflow Instructions, delivered to the agent | Workflow.md, system prompt, prompt file |

## The protocol

| Term                        | Definition                                                                                        | Aliases to avoid                           |
| --------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Stateless Turn Protocol** | The agent-facing rules governing how each memoryless Turn reads, advances, and writes the Tracker | State machine, the loop, workflow protocol |
| **Orient**                  | The protocol phase for Turn 1: replace the Skeleton, explore, and build the plan                  | Setup, init, bootstrap                     |
| **Execute**                 | The protocol phase for Turn 2+: resume work from where the Tracker says                           | Run, continue, work                        |
| **End**                     | The protocol phase that reconciles the Tracker and writes a Terminal Marker if finished           | Finish, complete                           |
| **Continue Prompt**         | The lightweight user prompt sent on Turn 2+ telling the agent to read the Tracker                 | Resume prompt                              |

## The runner

| Term                 | Definition                                                                                                                                                                                                                                                                                            | Aliases to avoid                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **Runner**           | The component that drives the loop: owns the single Iteration counter, spawns Turns, and assigns the terminal Run Status the Terminal Outcome hands it                                                                                                                                                | Driver, orchestrator, executor     |
| **Turn Runner**      | The single per-adapter lifecycle that executes one Turn (spawn/subscribe → accumulate → finalize into a `TurnExecutionResult`). Both session-controller shapes — the interactive Ink hook and the non-interactive exec factory — run Turns through it. For Codex this is `runCodexTurn`; see ADR 0007 | Turn loop, turn executor, spawner  |
| **Tracker Reader**   | The read-only, stateless inspector of the Tracker: pure functions (`parseTrackerState` / `readTracker`, in `trackerReader.ts`) that turn Tracker text into a Tracker State. Holds no loop state of its own                                                                                            | Loop Manager, state manager        |
| **Tracker State**    | What the Tracker's text says about progress — a pure function of the Tracker file: completed, blocked (+ reason), misplaced-terminal-marker, skeleton-not-replaced. The Iteration limit is applied by the Runner, not derived here                                                                    | Loop State                         |
| **Terminal Outcome** | The single owner (`resolveTurnOutcome`, `terminalOutcome.ts`) that maps a Tracker end-state to the Runner's decision after a Turn: continue, or stop with a Run Status + human message. Replaces the former `LoopStopReason` enum                                                                     | Stop Reason, exit reason           |
| **Run Status**       | The terminal outcome of a Workflow Run: `completed`, `blocked`, `exhausted`, `failed`, `cancelled`                                                                                                                                                                                                    | State, result                      |
| **Workflow**         | The reusable, installed definition (instructions + plugins + loop config) that a Workflow Run executes                                                                                                                                                                                                | Recipe, template, pipeline         |
| **Workflow Upgrade** | Replacing an installed Workflow's on-disk files in place with a new version                                                                                                                                                                                                                           | Update, sync, install              |
| **Compaction**       | Summarizing a Turn's conversation history when context fills; the Composed System Prompt survives it because it rides the system-prompt channel                                                                                                                                                       | Summarization, truncation, handoff |

## Cross-walk to official terminology

How Athena's units map to what Anthropic and OpenAI actually define in their docs. The headline: **Athena's `session` (the `athena-<id>` / `session.db` / `.athena/<id>/` identity) is NOT a vendor session** — it is the durable **Athena Session**, the work-unit container that holds _many_ **Workflow Runs**. A vendor "session"/"thread" is per-Turn and ephemeral here (an **Agent Session**).

| Athena concept                                   | Claude Code (Anthropic)                                                          | Codex (OpenAI)                                                                                                         | Vendor status                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Turn** (`startTurn`, `TurnExecutionResult`)    | _turn_ — used informally for one prompt→response cycle; **not** formally defined | _turn_ — **formally defined**: `turn.started` / `turn.completed` / `turn.failed`; one `thread.run(prompt)` == one turn | Formal in Codex, informal in Claude                                               |
| **Agent Session** (one fresh per Turn)           | _session_ — saved conversation tied to a dir, resumable by ID, spans processes   | _thread_ — resumable conversation, `startThread` / `resumeThread`, forkable                                            | Formally defined by both                                                          |
| **Athena Session** (`athena-<id>`, `session.db`) | — _(no native equivalent)_                                                       | — _(no native equivalent)_                                                                                             | Athena-only durable container; **do not call it a "session"** in the vendor sense |
| **Workflow Run** (`runId`, `workflow_runs`)      | — _(no native equivalent)_                                                       | — _(no native equivalent)_                                                                                             | Athena-only loop execution; many per Athena Session                               |
| **Iteration** (loop index)                       | "the agentic loop" (phases: gather context → act → verify)                       | the agent loop                                                                                                         | "iteration" is **not** a vendor term                                              |
| **Message** (sub-Turn)                           | `message` — user/assistant/`tool_use`/`tool_result`; + `model request`           | _item_ — agent message, reasoning, command exec, tool call, …                                                          | Formally defined by both                                                          |
| **Compaction**                                   | _compaction_ — summarizes history **within the same session**; no new session    | _compact_ — same idea                                                                                                  | Formally defined; same-session                                                    |

Key consequences:

- **One prompt→completion cycle = a Turn** in all three vocabularies. Athena's `Turn` is correct and the unit to standardize on.
- A vendor **session/thread can hold many turns**, but Athena deliberately bypasses that: each Turn spawns a **fresh** Agent Session (`mode: 'fresh'`, no `--resume`) and relies on the **Tracker** for continuity. So in Athena one Turn ≈ one whole (one-shot) Agent Session.
- **Iteration** is just the Turn's index; it is not a separate thing to model. Prefer "Turn N".
- A **Compaction** stays inside one Agent Session (one Turn); the protocol's "a fresh Turn is self-compaction" is an analogy, not vendor compaction.

## Relationships

- An **Athena Session** is the durable container (`session` table, one `session.db`) that holds one or more **Workflow Runs** (`workflow_runs`, FK `session_id → session`).
- A **Workflow Run** executes exactly one **Workflow** and consists of one or more **Turns** (numbered by **Iteration**).
- Each **Turn** runs in its own fresh **Agent Session** (a Claude session / Codex thread) and reads and writes the single shared **Tracker**.
- The **Runner** writes the **Skeleton** before the first **Turn**; the agent must replace it during **Orient**.
- The agent ends a **Workflow Run** by writing a **Terminal Marker**; the **Runner** trusts it unconditionally and maps it to a **Run Status**.
- The **Composed System Prompt** = **Stateless Turn Protocol** + the **Workflow**'s instructions, regenerated on every **Workflow Run**.
- A **Compaction** occurs within a single **Turn** and does not start a new **Turn**; it does start a new **Feed Run**.
- Only the last non-empty line of the **Tracker** is an authoritative **Terminal Marker**.

## Example dialogue

> **Dev:** "When a **Workflow Run** starts, is the **Tracker** already there for the first **Turn**?"

> **Domain expert:** "The **Runner** writes a **Skeleton** first. **Turn** 1 reads it, sees `TRACKER_SKELETON`, and goes into **Orient** — its job is to replace that **Skeleton** with a real plan before doing anything else."

> **Dev:** "And **Turn** 2 — does it re-read the whole **Workflow**? Does it resume **Turn** 1's **Agent Session**?"

> **Domain expert:** "No to both. **Turn** 2 spawns a brand-new **Agent Session** with no memory — we don't `--resume`. It gets a **Continue Prompt** that just says 'read the **Tracker**', enters **Execute**, and resumes from where the **Tracker** left off. The **Composed System Prompt** carries the **Protocol** into every **Turn**, so each one knows the rules. Note the `athena-<id>` stays the same across both Turns — that ID is the **Athena Session** (the durable container), not a vendor session. Within it, this loop is one **Workflow Run**."

> **Dev:** "What if context fills up mid-**Turn** and a **Compaction** happens — does the **Protocol** get lost?"

> **Domain expert:** "It survives. The **Composed System Prompt** rides the system-prompt channel, not the conversation history that **Compaction** rewrites. The **Compaction** shows up as a new **Feed Run** in the UI, but it's still the same **Turn**."

> **Dev:** "So when does the **Workflow Run** actually stop?"

> **Domain expert:** "When the agent writes a **Terminal Marker** on the **Tracker**'s last line, or the run reaches a terminal condition like `max_iterations`. Either way one owner — the **Terminal Outcome** resolver — maps the **Tracker**'s end state to a **Run Status** (`completed`, `blocked`, `exhausted`, `failed`, or `cancelled`), which the **Runner** assigns."

## Flagged ambiguities

- **"Session" collides head-on with the vendor meaning — this is the worst one.** Anthropic and OpenAI both formally define _session_/_thread_ as a **resumable conversation context** (one agent, spanning processes). Athena uses `session` (`athena-<id>`, the `sessions/` dir, `session.db`, `.athena/<sessionId>/`) for the **durable work-unit** — what this glossary calls an **Athena Session**, which _contains many_ **Workflow Runs** and spawns _many_ vendor sessions. To make it worse, the protocol prose ("each **session** is a fresh process with no memory of prior **sessions**") uses _session_ for a single **Turn**. So one word means three things: **Athena Session** (infra durable container), Turn (protocol), and the vendor's actual session/thread. **Recommendation:** reserve **Session** for the vendor concept (**Agent Session**); qualify the durable identity as the **Athena Session** (which contains **Workflow Runs**); in the protocol replace "session" with **Turn**.
- **"Iteration" is not a vendor term and is redundant with Turn.** Neither vendor defines it; Anthropic documents "the agentic loop," not iterations. In Athena, one iteration _is_ one Turn. **Recommendation:** keep **Turn** as the unit and use "iteration" only as its integer index ("Turn 3 / iteration 3"), never as a separate concept.
- **"Turn"** is the one unit that already aligns: Codex defines it formally (`turn.*` events; one `thread.run` == one turn) and Athena's `startTurn`/`TurnExecutionResult` match it. Standardize everything onto **Turn**.
- **"Run"** is overloaded across **Workflow Run** (the loop, `workflow_runs` row), **Feed Run** (UI-timeline unit bounded by a trigger), and casual "run" for a single **Turn**. The two formal Runs even have different status enums (`exhausted/cancelled` vs `aborted`). Always qualify _Workflow Run_ vs _Feed Run_; never let "run" mean a Turn.
- **"State machine"** names two things: the agent-facing **Stateless Turn Protocol** and the **Runner**'s loop. Say which.
- **"Compaction"** — vendor-defined as summarizing history _within the same Agent Session_. Athena's "a fresh Turn is self-compaction" is an analogy. Reserve **Compaction** for the in-Session mechanism; call the loop's reset the _fresh-Turn reset_.
- **Workflow Instructions vs Composed System Prompt** — `workflow.md` (authored) is not what reaches the agent; the **Composed System Prompt** (Protocol + instructions, regenerated per Workflow Run) is. Don't conflate source file with delivered artifact.
