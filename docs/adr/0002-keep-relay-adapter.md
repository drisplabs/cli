# ADR 0002 - Keep the relay adapter as a shared seam

Status: Active
Date: 2026-06-03

## Context

Issue #11 (`refactor(channels): delete one-call-site relay adapter shim`) argued
that `src/app/channels/relayAdapter.ts` was a logicless pass-through over
`gateway/relay/coordinator` with a single caller (`runtimeDaemon.ts`), and
should be deleted by inlining its ~188 LOC into that one caller. The framing was
the deletion test: _"one adapter = hypothetical seam; two adapters = real
seam."_

By the issue's own test the seam is real, and two of its premises had gone stale
by the time it was re-triaged.

The module is the home of the **Relay** concept (see `CONTEXT.md` → Gateway →
Relay): the round-trip that resolves a `RuntimeEvent` needing user input by
sending it to the paired dashboard channel via the session bridge and feeding
the answer back as a `RuntimeDecision`.

1. **It is not logicless.** The file holds genuine relay→decision translation:
   `permissionRelayDecision`, `questionRelayDecision`, `extractRelayQuestions`,
   tool-input preview/truncation, and gateway tracing. It maps to and from
   `shared/gateway-protocol`, not a coordinator.

2. **It has two real consumers, not one:**
   - `src/app/providers/RuntimeProvider.tsx` - interactive (Ink) mode
   - `src/app/exec/runner.ts` - headless exec mode

   Both build their relay wiring from the same two factories
   (`createRelayPermissionCallback`, `createRelayQuestionCallback`) so the two
   modes behave identically.

The original caller named in the issue (`runtimeDaemon.ts`) is no longer the
consumer; the relay wiring moved to `RuntimeProvider` + `runner.ts`. The "one
call site" premise that made the deletion low-risk is no longer true.

## Decision

`src/app/channels/relayAdapter.ts` stays as a shared module.

It is the single home of relay→decision translation, shared by interactive (Ink)
and headless (exec) modes. Deleting it would duplicate ~140 LOC of relay logic
across an interactive React provider and a headless runner - the exact
divergence risk the shared module exists to prevent.

## Consequences

Positive:

- Interactive and headless modes resolve relays through one translation surface,
  so a `permission.request` or question behaves identically in both.
- The **Relay** concept has a single code home that matches the domain model in
  `CONTEXT.md`.

Negative / costs:

- One more module in the channels layer than a strict single-consumer count
  would justify; retained deliberately because the second consumer is real.

## Rejected Alternative - Inline into the caller

Delete the module and inline its translation into its caller, per issue #11.

Rejected because the "one call site" premise is stale: there are two consumers
sharing real logic, so inlining would fork the relay translation across the Ink
provider and the exec runner.

Reopen this ADR if the exec runner stops relaying (one consumer again) or the
relay logic collapses to a true type-only pass-through.

## References

- `CONTEXT.md` - Gateway → Relay, RuntimeEvent, RuntimeDecision, Dispatch turn
- `src/app/channels/relayAdapter.ts`
- `src/app/providers/RuntimeProvider.tsx`
- `src/app/exec/runner.ts`
- Issue #11 (drisplabs/cli) - "refactor(channels): delete one-call-site relay adapter shim" (closed)
