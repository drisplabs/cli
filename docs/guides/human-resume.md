# Waking a suspended Workflow Run (human resume)

Since ADR 0014 a Workflow Run that cannot proceed alone suspends in the
non-terminal **`awaiting_attention`** status instead of dying — `drisp runs`
calls it **Parked**. Every route in funnels here: a declared
`NEEDS_HUMAN[: reason]`, an `AskUserQuestion` no attached human could answer,
an **ask rule** that fired on a permission prompt (#189), a permission left
unclaimed under `guarded` / `standard`, a hard failure (`auth` / `billing` /
`invalid_request` / `model_not_found` / unclassifiable), or an exhausted
bound (Nudge cap, Retry cap, `maxIterations`) — the reason always names
which. Under `--isolation autonomous` only the first two park a Run: the
preset's policy answers every permission an ask rule does not claim, so the
workflow completes with nobody watching. A parked Run is waiting on you; this
guide is how you find it and wake it.

## The chosen entrypoint: the CLI

Issue #144 left the entrypoint open (CLI, dashboard inbox, or both). The
decision: **CLI first** — it matches the tool's shape, works everywhere the
runtime works, and the dashboard inbox can layer on the same registry read
(`listAwaitingAttentionRuns`) later without changing the model.

## Discover: `athena-flow runs`

```sh
athena-flow runs        # human-readable inbox
athena-flow runs --json # machine-readable
```

Lists every Workflow Run whose session's most recent run is
`awaiting_attention`, across all projects, as **Parked**: the workflow name,
the session id, why it parked (which ask rule fired, or the `NEEDS_HUMAN`
reason), and the exact wake command. A Run parked on a **deferred
permission** (#190) also shows the pending question — the tool and its input
summary — and the request id an answer addresses, and its wake command
carries `--answer=allow`.

## Wake: `athena-flow run --continue`

```sh
athena-flow run --continue=<athenaSessionId> "your reply"
```

What happens, in ADR 0014 terms:

- The resume target resolver sees the session's latest Run is suspended and
  targets **that Run's persisted Agent Session id** (captured on the run row,
  surviving restarts) — the session that asked — rather than merely the last
  adapter session observed.
- Your reply is the resumed Turn's prompt, delivered **into the intact
  conversation** (`claude -p --resume <id>`), preserving the context in which
  the question arose.
- The Runner **reuses the suspended Run's id**, so the same `workflow_runs`
  row returns to `running` and can proceed to completion — no forever-
  suspended row left beside a new one.
- **Degrade:** if the vendor session is gone or invalid, the failed resume
  falls back to a fresh Turn seeded from the Journal, with your reply still
  the prompt. The Run is never stranded on a dead session.
- **After a Handover:** a Run that parked right after a Handover — the
  iteration ceiling reached on the Handover row (ADR 0018 §4) — captured an
  Agent Session at its context bound: the killed session, or the fork.
  Resuming either would re-trip compaction before your reply is read, so the
  wake starts a **fresh** Agent Session instead (ADR 0018 §9), and the wake
  prompt names the newest `handoff/NNN.md` as mandatory reading beside the
  Journal. The resolver honours the same marking, so `--continue` never hands
  the runner that session; the Run id is still reused.

A live interactive session answers its own questions in the terminal, and a
paired dashboard can deliver decisions into a running session; suspension is
what happens when no hub was attached to answer (the request held, per the
README's "Permissions with no hub attached") and the process has since ended.

## Answer: `--answer` and the hub's `answer` frame

A permission request that no rule answers is not parked on at once (#190). In
a Workflow Run it is **held** for the grace window — `permissionGraceMs` in
config (project over global), `--permission-grace-ms` per run, 60 s by
default — so a hub attached through the runner (`drisp runner`) can answer it inside
the Turn. With no hub attached nothing can answer, so the request is deferred
immediately. When the window elapses unanswered, the call is refused with a
_deferred_ result, the Turn ends, and the Run parks with the request recorded:
its id, the tool, and a one-line input summary, in the Journal (a runner note
under `## Needs human`) and on the run record (`drisp runs`, `needs_human` to
the hub as a `question` Interruption addressed by `requestId`).

Two ways to answer it:

- **Locally**, on the wake:

  ```sh
  athena-flow run --continue=<athenaSessionId> --answer=allow "go ahead"
  athena-flow run --continue=<athenaSessionId> --answer=deny "not that branch"
  ```

- **From the hub**, as an `answer` frame for the request id while the Run is
  parked. The daemon stores it in the decision inbox, records it against the
  Run's Interruption, and wakes the Run.

On continue the wake prompt names the deferred call and asks the agent to
re-issue it. The runner recognises the re-issued call (same tool, same input
summary) and **replays** the stored answer into it without a prompt — in
`--json` mode as `permission.replayed`, after `permission.hold` /
`permission.deferred` on the way in. A stored answer is never applied to a
different call: if the agent asks for something else, that request is held
again. Without a stored answer the re-issued call is held again and, unanswered,
parks the Run on the new request.

## Steer: `--steer` and the hub's `steer` frame

A **Steer** is a human turn text sent _into_ a Run (#191). It is never
injected into a Turn in flight: the Runner queues it and delivers every queued
Steer, in arrival order, as one labelled block at the **head of the next
Turn's prompt**, ahead of the Turn Protocol's own instruction, so the agent
reads it before it plans:

```
=== HUMAN STEER (1 of 2, via hub, received 2026-09-03T10:00:00.000Z) ===
use the other branch
=== HUMAN STEER (2 of 2, via local, received 2026-09-03T10:05:00.000Z) ===
and skip the docs
=== END HUMAN STEER ===

A human steered this run. Read the steers above before you plan: …

---

<the Turn's own prompt: Orient / Continue / Nudge / wake framing>
```

Two ways to send one:

- **Locally**, on any run and on a wake — repeatable, delivered in order:

  ```sh
  athena-flow run --continue=<athenaSessionId> "your reply" --steer "use the other branch"
  ```

- **From the hub**, as a `steer` frame to the runner (`drisp runner`). A Steer for a
  running Run is handed to it at once and waits for the Turn boundary; a Steer
  for a parked Run is held (`pending` on `drisp runner runs`) and delivered
  when the hub continues that Run.

Each delivery is recorded in the Journal — origin (`hub` or `local`), when it
arrived, and the Turn it was delivered into — above any terminal marker the
Journal ends with, so an answered `NEEDS_HUMAN` line stays where the agent
left it. In `--json` mode the run emits `run.steer.queued` on receipt and
`run.steer` on delivery.

## Notes

- `blocked` and `exhausted` still appear on historical rows; they are no
  longer emitted.
- A suspended run's `ended_at` stays NULL — it has not ended.
- Iteration numbering restarts on the resumed run's row (the runner counts
  its own Turns); the Journal remains the durable ledger of progress.
