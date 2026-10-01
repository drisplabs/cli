# ADR 0020 — Harnesses compact at their own default; no per-Turn context cap

Status: Active
Date: 2026-10-01
Amends: ADR 0014 §5 and ADR 0019. Retires `loop.maxTurnTokenCount`.

## Problem

ADR 0014 §5 put a harness-neutral `maxTurnTokenCount` (default 130,000) well under the
model window. The bound had to sit there so that a forked conversation could still hold
itself and write a Handoff file. ADR 0019 removed the fork: a Handover now blocks
`PreCompact`, aborts the Turn, and starts a fresh Agent Session seeded from the Journal's
bounded `## Restart` checkpoint. That checkpoint is kept current by the agent throughout the
Turn, so nothing has to be written at the bound. The early trigger no longer buys headroom.
It only shortens every Turn and multiplies Handovers.

## Decision

1. drisp sets no autocompact bound. It no longer injects Claude's
   `CLAUDE_CODE_AUTO_COMPACT_WINDOW` or Codex's `model_auto_compact_token_limit`. Each harness
   compacts at its own native point, and on Claude that is where `PreCompact` fires the
   Handover. A user-exported `CLAUDE_CODE_AUTO_COMPACT_WINDOW` still reaches Claude through
   the environment.
2. `loop.maxTurnTokenCount` is retired. It is accepted for compatibility and ignored.
3. On a first Turn, fresh-Turn admission estimates its ceiling from the model's reported
   context window. With neither that nor a prior bounded Turn, the opening check is skipped.
   After a Handover the ceiling remains the measured last occupancy (ADR 0019).

## Consequences

- Turns run longer before a Handover: fewer restarts, more context per call.
- The window is an optimistic first-Turn ceiling, since native compaction fires below it.
  The bounded-Turn measurement corrects it after the first Handover.
- A stale `## Restart` section costs more work on restart than it did with short Turns.
