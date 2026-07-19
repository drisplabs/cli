# ADR 0010 - The Knowledge Base MVP is pull-based (manual/CI-triggered)

Status: Active
Date: 2026-07-19
Relates to: KB PRD (lespaceman/athena-flow-cli#132)

## Context

The KB PRD frames the Knowledge Base as **self-maintaining**: a completed
**Workflow Run** and an inbound channel message are ingested automatically via
two subscribers, so "building the product _is_ updating the wiki." Grounding
that against the code refutes the "reuse existing ledgers + subscribers"
framing:

- **No run-completion event exists.** At a terminal **Run Status**,
  `src/core/workflows/workflowRunner.ts` mutates a local `status` and calls
  `persist()` (a plain DB write); the one callback (`onIterationComplete`) fires
  only on the non-terminal continue path. There is no emitter/observer/subscriber
  at completion. A "run-completion subscriber" is entirely net-new.
- **The `channel_messages` ledger is unimplemented.** The table exists
  (`src/infra/sessions/schema.ts`) but no production code writes to it
  (`channelManager.ts` comments defer it to "M5+"); inbound is consumed inline in
  memory with no row observer.

Independently, the differentiating value — quality of unattended synthesis and
of **Drift finding** detection — is unproven. Spending the first budget on
eventing whose payoff depends on synthesis quality we have not validated is the
wrong order.

## Decision

**The MVP KB is pull-based.** The surface is `drisp kb init | ingest [path] |
ingest --run <id> | query | lint | status`, driven by a human or CI. No
run-completion subscriber and no channel subscriber ship in the MVP. Automatic
ingestion becomes a fast-follow once (a) synthesis + drift quality is validated
on manual ingests, and (b) the eventing / channel-ledger infrastructure is
built.

Each **KB operation** auto-commits its `kb/` changes as one atomic commit per
operation (by the tooling, after the **Terminal Marker**, not the agent
ad-hoc). Trust in unattended synthesis rests on cited provenance, **Lint**, and
`git revert` — an after-the-fact net, not per-change human review. This is the
only governance stance consistent with the zero-bookkeeping pitch; it names the
trade: the MVP accepts occasional wrong synthesis, made verifiable by receipts
and reversible by git, rather than gating every ingest.

## Consequences

Positive:

- The first slice proves the risky question (is the synthesis/drift any good?)
  before any plumbing whose value depends on it.
- Zero net-new eventing in the MVP.
- The de-risking demo is still reproducible manually: `kb ingest ./decision.md`
  → run the agent → `kb ingest --run <id>` → `kb lint` surfaces the drift.

Negative / costs:

- The headline "byproduct" automation is deferred; the "self-maintaining" story
  is aspirational until the fast-follow lands.
- When subscribers do land, a **worth-filing gate** must exclude the KB's own
  `workflow_runs` (tagged `workflow_name = 'kb-*'`) or ingesting a KB run
  triggers another ingest — infinite regress.

## Rejected Alternatives

- **Run-subscriber-first (the PRD spine).** Build the net-new run-completion
  eventing now so completed runs auto-ingest. Rejected: spends the first budget
  on plumbing whose payoff hinges on unvalidated synthesis quality.
- **Full PRD (both subscribers + manual).** Additionally blocked on the unbuilt
  `channel_messages` ledger (M5+), which must be written and made subscribable
  before anything can observe it.

## References

- `src/core/workflows/workflowRunner.ts` - terminal Run Status path (no pub/sub)
- `src/infra/sessions/schema.ts` - `channel_messages` (table present, unwritten)
- `KNOWLEDGE_BASE.md` - KB / KB operation / Drift finding glossary
- ADR 0011 (storage & provenance), ADR 0012 (Lint determinism)
