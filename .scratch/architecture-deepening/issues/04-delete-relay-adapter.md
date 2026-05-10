# Delete one-call-site relay adapter shim

Status: ready-for-human

## Files

- `src/app/channels/relayAdapter.ts` (~188 LOC) — the shim
- `src/app/dashboard/runtimeDaemon.ts` — sole caller

## Problem

The adapter wraps `gateway/relay/coordinator` for the app layer. One call site. Interface re-exposes the coordinator with adapted types but no logic — types pass through. **One adapter = hypothetical seam.** Fails the deletion test cleanly: deleting it pushes 188 LOC into one place, where most of it is type bookkeeping that shrinks once duplication goes away.

## Sketch of deepening

Negative-deepening: delete the file. `runtimeDaemon.ts` imports from `gateway/relay` directly. If a second consumer ever materializes, _then_ extract — informed by two real call sites instead of one speculative one.

## Why this is the right move

- Fewer files between `runtimeDaemon` and the coordinator → improved locality with zero loss of leverage (no leverage existed).
- Removes an interface someone has to learn that doesn't earn its keep.
- Reverses "two adapters = real seam" — we have one, so the seam isn't real.

## Open design questions

- Verify call-site count. The explorer found one (`runtimeDaemon.ts`); confirm with grep before deleting.
- Are any of the adapted types reusable elsewhere, or do they only exist to bridge `coordinator` ↔ `runtimeDaemon`?

## Effort

Low. Mostly mechanical: inline, run typecheck, fix imports.

## Risk

Very low if the one-caller claim holds.
