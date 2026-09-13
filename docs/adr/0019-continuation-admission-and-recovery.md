# ADR 0019 — Restart from a bounded Journal checkpoint

Status: Active
Date: 2026-09-13
Supersedes: ADR 0018. Amends ADR 0014 §5–§7, ADR 0015 §6/§8 and ADR 0016 §8/§9.

## Problem

A fresh Agent Session can exhaust its context simply rereading a large Journal.
Forking the exhausted conversation to summarize it adds another expensive call,
retry path, file lifecycle and failure mode. Similarity is not proof of progress.

## Decision

The agent maintains one `## Restart` section in the existing Journal during normal
work. It contains `Run: <runId>` and six nonempty fields: Objective, Next action,
Constraints, Changes, Open questions and References. The default bound is 2,000
estimated tokens, configurable with `loop.maxRestartTokens`. The agent updates it
after orientation and concrete milestones, before large reads or risky operations,
and writes atomically. The Runner validates rather than truncates its prose.

At a context boundary, the Runner interrupts the Turn and reads this section. A
valid checkpoint for this Run seeds a fresh Agent Session directly. A missing,
invalid, oversized, wrong-run or already-consumed checkpoint parks the Run. The
last valid checkpoint stays in persisted memory if a later write is partial.
Checkpoint equality detects reuse, not whether work was productive.

There is no fork, summarization call, Handoff file chain, handoff skill plugin,
fork retry, recovery budget or similarity calculation. Supporting Journal and
Unit Record sections remain available for selective reads.

The existing reducer owns the transition and a small pure admission function
checks every Turn start, including Retry and wake. It enforces the iteration
ceiling and optional `loop.maxRunTokens`. A fresh restart must leave an estimated
8,000 tokens for work after opening context and its checkpoint. Historical last
API occupancy is conservative evidence, not a measured compaction threshold.
Observations expire between Runner executions. The first actual request also
checks opening feasibility against the configured ceiling when needed.

The interpreter reconciles streamed invocation usage with final usage without
adding either twice. Reported usage is persisted during execution; live budget
exhaustion requests cancellation and parks without waiting for completion. Claude
termination escalates to SIGKILL if necessary. Codex uses its runtime interrupt.
Limits remain observational: unreported usage, in-flight requests, crashes and
cancellation latency can cause overshoot. Adapters without live usage enforce
budgets at the next continuation boundary.

Resource suspension uses the existing `cap_exhausted` Interruption with an
optional structured `resource`: cause, limit, usage, detail, checkpoint path and
whether a fresh session is required. Causes are tokens, iterations, context and
restart. Resource diagnostics do not grow the Journal. A human wake can use a
repaired Journal checkpoint or the retained checkpoint and reply. It never
replenishes the lifetime token budget or resets the iteration counter.

Claude exec currently supplies the `compact.pre` boundary. Other harnesses need
an equivalent boundary signal to use automatic checkpoint restarts; shared
admission and usage accounting apply independently. The retired `handoverCap`
setting remains accepted for compatibility, without an effect on continuation.

## Validation

Deterministic tests cover direct restart with two harness calls, selective context,
wrong-run/missing/repeated checkpoints, partial-write retention, iteration bounds,
live usage cancellation, duplicate usage, and budget-preserving wakes. Harness
accounting tests cover vendor cumulative usage. These checks do not establish an
empirical compaction threshold or a percentage of money saved.
