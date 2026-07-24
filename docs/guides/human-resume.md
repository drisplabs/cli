# Waking a suspended Workflow Run (human resume)

Since ADR 0014 a Workflow Run that cannot proceed alone suspends in the
non-terminal **`awaiting_attention`** status instead of dying. Every route in
funnels here: a declared `WORKFLOW_BLOCKED[: reason]`, an `AskUserQuestion`
no attached human could answer, a hard failure (`auth` / `billing` /
`invalid_request` / `model_not_found` / unclassifiable), or an exhausted
bound (Nudge cap, Retry cap, `maxIterations`) — the suspension message always
names which. A suspended Run is waiting on you; this guide is how you find it
and wake it.

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
`awaiting_attention`, across all projects: the workflow name, the session id,
why it suspended, and the exact wake command.

## Wake: `athena-flow exec --continue`

```sh
athena-flow exec --continue=<athenaSessionId> "your reply"
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
  falls back to a fresh Turn seeded from the Tracker, with your reply still
  the prompt. The Run is never stranded on a dead session.

A live session's questions still route through the existing Relay path
(`--channel telegram` etc.) as runtime decisions; suspension is what happens
when no such channel answered and the process has since ended.

## Notes

- `blocked` and `exhausted` still appear on historical rows; they are no
  longer emitted.
- A suspended run's `ended_at` stays NULL — it has not ended.
- Iteration numbering restarts on the resumed run's row (the runner counts
  its own Turns); the Tracker remains the durable ledger of progress.
