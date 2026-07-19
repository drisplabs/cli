# ADR 0012 - Lint determinism boundary: hygiene gates CI, Drift is advisory

Status: Active
Date: 2026-07-19
Relates to: KB PRD (lespaceman/athena-flow-cli#132)

## Context

The KB PRD calls the finding classifier "a deterministic module … testable
without the LLM," lumps contradiction, plan↔build drift, stale, orphan, and
uncited all under "Drift finding," and wants `drisp kb lint --json` to exit
non-zero to gate CI (#25).

But the flagship finding — "a plan page says X, a **Workflow Run** shipped Y,
and X _contradicts_ Y" — is a **semantic judgment only the LLM can make** for
arbitrary prose. A "deterministic" test for it must feed the classifier
pre-structured "shipped Y" fixtures, i.e. assume the unreliable extraction step
already succeeded. So the determinism claim holds only for the structural
(hygiene) findings, and gating CI on an LLM judgment would be flaky (same input,
different findings across runs).

## Decision

**Split the taxonomy and the determinism boundary.**

- **Vocabulary.** `Lint finding` is the umbrella; `Drift finding` is the
  specific **semantic plan↔build contradiction** subclass. Orphan / uncited /
  stale / missing-page are **hygiene findings**, not drift.
- **Deterministic classifier owns** (a) all hygiene findings, and (b) _staging_
  Drift candidates — pairing opposing-**tier** pages (`plan` × `build`) about the
  same entity. A page's tier derives from its **KB Source** (a Workflow Run
  source → `build`; a file ingested as intent → `plan`), never from the agent's
  judgment, so staging is deterministic.
- **The LLM adjudicates** whether a staged candidate is a genuine contradiction
  and writes the natural-language rationale.
- **CI gating.** `lint --json` exits non-zero only on deterministic (hygiene)
  findings. **Drift findings are reported as an advisory count and never
  hard-gate CI.**

## Consequences

Positive:

- The CI gate (#25) is reproducible, because only deterministic findings gate it.
- Tests protect exactly what is guaranteed — the hygiene classifier and the
  candidate-staging logic — which is the honest version of "testable without the
  LLM." The Drift LLM step is tested at the staging seam plus a stubbed
  adjudication.
- Page tier being source-derived keeps the differentiating pre-filter
  deterministic without asking the LLM to self-classify.

Negative / costs:

- The flagship Drift finding is explicitly **non-deterministic and advisory**; a
  team that wants to gate a release on it must accept LLM variability or wrap it
  in its own tolerance. The "catch drift a human missed" demo is real but not a
  hard CI guarantee.

## Rejected Alternatives

- **Drift as a deterministic module fed structured assertions (PRD framing).**
  Tests look green but the guarantee is illusory — it rests on LLM extraction;
  CI gating on it is flaky.
- **All-LLM lint.** Nothing deterministic to unit-test, no trustworthy `--json`
  exit code, #25 impossible.

## References

- `KNOWLEDGE_BASE.md` - Lint finding, Drift finding, Page kind
- ADR 0011 - provenance/tier live in page front-matter (the classifier's input)
- Project rule: tests assert store/finding state, never the agent's generated
  prose; the agent is stubbed at the Runner seam.
