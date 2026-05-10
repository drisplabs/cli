# Collapse claude harness 8 subdirs into 3 deep internal modules

Status: ready-for-human

## Files

- `src/harnesses/claude/{auth,config,hooks,process,protocol,runtime,session,system}/` — 8 sibling subdirs
- `src/harnesses/claude/adapter.ts` (~99 LOC) — orchestrator
- `src/harnesses/contracts/` — shared `HarnessAdapter` interface (Claude/Codex/Mock)

## Problem

Eight peer subdirectories imply eight architectural seams; in practice, only `adapter.ts` consumes them, in a fixed wiring, with no swappable adapters at any of those seams. Most subdirs export 1–2 things and have a single call site. The flat shape advertises modularity that doesn't exist (**one adapter = hypothetical seam**).

## Sketch of deepening

Three deep internal modules behind the existing `HarnessAdapter` external interface:

1. **Protocol Translator** — Claude hook payloads ↔ `RuntimeEvent`/`RuntimeDecision`. Absorbs `protocol/`, `hooks/`.
2. **Process Manager** — subprocess lifecycle, signals, stdio, system probes. Absorbs `process/`, `system/`.
3. **Session Controller** — auth, config, permissions, session state, runtime state. Absorbs `auth/`, `config/`, `session/`, `runtime/`.

`HarnessAdapter` interface (shared across Claude/Codex/Mock) is unchanged.

## Why this deepens

- Locality: "where does Claude hook translation live?" → one module instead of two subdirs.
- Real seams emerge: a test could swap `Protocol Translator` while keeping the real `Process Manager`, instead of rebuilding the whole `MockAdapter`. **Two adapters becomes a real seam.**

## Open design questions

- Is the proposed 3-way split actually the right cut? Maybe 2 (lifecycle + translation) or 4 (separating auth from session).
- Does anything in `system/` (e.g. environment probing) belong in `Process Manager` or `Session Controller`?
- How does this affect the Codex harness? Codex has fewer subdirs but mirrors the structure — should it follow the same 3-module shape for symmetry?

## Effort

High — structural reorganization across ~8 subdirs. Affects imports across the harness layer.

## Risk

Highest of the five. Worth doing only if locality friction is real (not aesthetic). Grill before committing.
