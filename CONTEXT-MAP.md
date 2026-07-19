# Context Map

drisp/cli spans three bounded contexts. Each owns its own glossary. The bare
words _session_, _run_, and _turn_ collide across them and are always qualified
(see the cross-walk embedded in `CONTEXT.md` and `UBIQUITOUS_LANGUAGE.md`).

## Contexts

- [Feed-pipeline](./CONTEXT.md) — observation / projection: normalizes harness
  events into a timeline (**FeedMapper**, **FeedEvent**, **Feed Run**).
- [Workflow-execution](./UBIQUITOUS_LANGUAGE.md) — execution / control: drives
  the Stateless Turn Protocol loop (**Runner**, **Workflow Run**, **Turn**,
  **Tracker**).
- [Knowledge-base](./KNOWLEDGE_BASE.md) — knowledge management: the durable,
  LLM-maintained wiki that reconciles intent with reality (**KB**, **Wiki
  Page**, **KB Source**, **Drift finding**).

## Relationships

- **Feed-pipeline ↔ Workflow-execution**: genuinely different contexts that
  collide only on the bare words _session_ / _run_ / _turn_; kept separate and
  qualified via an explicit cross-walk in both docs (ADR 0003).
  `feed_events.run_id` (**Feed Run**) is unrelated to `workflow_runs.id`
  (**Workflow Run**).
- **Knowledge-base → Workflow-execution**: the KB _reads_ a completed **Workflow
  Run** — taken as its final **Tracker** plus run outcome — as a **KB Source**,
  and each **KB operation** _executes as_ a **KB Workflow** (a Workflow Run
  through the **Runner**). The KB never edits a source. **Provenance links**
  reference sources by text tuple, not foreign key — sources live in per-session
  `session.db` files while the KB is a separate store.
- **Knowledge-base → Feed-pipeline** _(future)_: an inbound channel message
  becomes a **KB Source** once the channel ledger is a durable, subscribable
  stream. Deferred from the KB MVP, which is manually/CI-triggered.
