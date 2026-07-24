# maxTurnTokenCount: default choice and measurements (ADR 0014 / issue #141)

`maxTurnTokenCount` bounds one Turn's conversation and maps onto each
harness's autocompact knob so `PreCompact` fires — and Handover can intercept
it — at a configured point instead of at the vendor default. This records the
measurements behind the shipped default of **130 000 tokens**.

Measured: 2026-07-24, Claude Code `2.1.217` (macOS arm64). Companion doc:
`qa/precompact-block-verification.md` (same instrumented runs).

## Why the old defaults were wrong

Both harnesses' previous values sat at the model window — Claude
`CLAUDE_CODE_AUTO_COMPACT_WINDOW=185000`, Codex
`model_auto_compact_token_limit=175000`, against a 200k window. A Handover
fork inherits the full conversation, and summarizing N tokens requires
ingesting ~N, so **forking creates no headroom**: by the time `PreCompact`
fired at ~95% of 185k (~176k), a fork had ≈24k tokens of window left to hold
the conversation _and_ emit a Handoff file — after subtracting the ~15k+
system-prompt/tool baseline, effectively nothing. The trigger point is the
only source of headroom.

## Measurements

1. **Claude clamps its knob to a 100k floor.** In 2.1.217 the env value is
   resolved as `window = min(modelMax, max(100000, configured))` (constants
   `vso=1e5`, `Rrs=1e6` in the binary; a 12k setting was confirmed ignored in
   a live run — no compaction until context passed the ~95k mark of the
   clamped 100k window). Consequence: **the Claude harness cannot trigger
   below ~95k tokens**, and `maxTurnTokenCount` values under 100k behave as
   100k there. Codex takes the configured value directly.

2. **PreCompact fires at the configured point.** With the knob at 100000, a
   live run crossed the threshold while reading large files and `PreCompact`
   (trigger `auto`) fired at ≈95k context — and re-fired at (roughly) every
   subsequent loop step while context stayed above the threshold (13 events
   in the blocked-compaction run). See Case A in
   `qa/precompact-block-verification.md`.

3. **Headroom above the trigger is real and sufficient.** In the same
   blocked-compaction run the session continued working ~50k tokens past the
   blocked trigger (reading two further ~30k-token files) without hitting the
   model window. A Handoff file is a 1–3k-token artifact (the live #138 skill
   run produced ~2.8 KB), so a fork triggered at 130k has ≈70k tokens of
   window left — dozens of times the space the handoff needs.

## The shipped default

**130 000 tokens** (`DEFAULT_MAX_TURN_TOKEN_COUNT`, ~65% of a 200k window):

- comfortably above Claude's 100k floor, so the configured point is honored;
- ≈70k tokens of window above the ~123k (95%) trigger — measured as more than
  enough to hold the conversation and emit a Handoff file in the fork;
- high enough to keep Handover (and its per-boundary fidelity loss) rare on
  ordinary Turns.

Per-workflow override: `loop.maxTurnTokenCount` in `workflow.json`. On the
Claude harness an explicit value is delivered via the spawn env and wins over
a user's `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; the bare default remains
env-overridable. Values below 100k are honored by Codex but silently raised
to 100k by Claude (finding 1).

## Re-measuring

Re-run the method in `qa/precompact-block-verification.md` with
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` set to the candidate value; confirm (a) the
first `PreCompact` arrives at ≈95% of the candidate, and (b) after a block
the session can still ingest ≥ handoff-sized output before the model window.
For the clamp floor, set the env var below 100k and confirm compaction does
not trigger until ~95k.
