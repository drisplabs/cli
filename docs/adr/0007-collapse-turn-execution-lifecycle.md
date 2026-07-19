# ADR 0007 - Collapse the turn-execution lifecycle behind the SessionController seam

Status: Active
Date: 2026-07-19

## Context

The harness seam exposes each adapter's per-Turn execution through **two factory shapes**
(`src/harnesses/contracts/session.ts`):

- `CreateSessionController` → `SessionController` — object-arg `startTurn`, no React state. Used by the
  non-interactive **exec** path (`src/app/exec/runner.ts`).
- `UseSessionController` → `UseSessionControllerResult` — positional-arg `startTurn`, plus `isRunning` +
  `usage`. Used by the interactive **Ink** path.

The only real difference between the two is a React-ergonomics one: the `use` shape re-orders `startTurn`
into positional args and adds the two pieces of reactive state (`isRunning`, `usage`) the shell renders.

That thin distinction had leaked into full lifecycle duplication inside each adapter:

- **Claude** implemented spawn→accumulate→finalize twice (`session/controller.ts` and
  `process/useProcess.ts`), and `mergeIsolation` + `resolveClaudeSessionId` were duplicated **verbatim**
  across the two files (the two `resolveClaudeSessionId` copies differed only in an error-message string).
- **Codex** implemented the event-subscription accumulator (`message.delta` / `usage.update` /
  `turn.complete` / `error`), `sendPrompt`, and result construction **near-verbatim** across
  `session/controller.ts` and `session/useSessionController.ts`.

Additionally, the non-interactive Claude controller (`session/controller.ts`) — the whole exec turn path —
had **no test coverage**.

The `SessionController` seam itself is genuinely deep: it hides Claude's per-Turn child-process spawn behind
the _same_ `startTurn → TurnExecutionResult` interface as Codex's persistent JSON-RPC thread. That seam is
load-bearing and is **not** the friction. The friction is the duplication _around_ it.

## Decision

**1. Keep the `SessionController` seam and both `create` / `use` shapes.** They encode a real distinction
(exec vs Ink; React state vs none). We do not flatten the seam or merge the two shapes.

**2. Codex: one Turn Runner, both shapes thin over it.** Extract the event-accumulation and prompt
execution into `src/harnesses/codex/session/turnRunner.ts`:

- `createCodexTurnEventCollector()` — the single interpreter of the Codex event stream into a
  `TurnExecutionResult` (`result()` / `errorResult()`).
- `runCodexTurn(runtime, prompt, optionsInput, hooks?)` — subscribe → `sendPrompt` → finalize, with an
  optional `onError` hook so the interactive path can still emit its lifecycle event.

`createCodexSessionController` and `useCodexSessionController` now both call `runCodexTurn`. Each caller
keeps only what genuinely differs: its runtime-availability guard, its active-promise tracking, and (for
the hook) its `isRunning` state, its lifecycle `onError`, and the separate global `usage.update`
subscription that drives the header token bar.

**3. Claude: share the Turn config, keep the two accumulate-loops separate.** `mergeIsolation` and
`resolveClaudeSessionId` move to `src/harnesses/claude/session/turnConfig.ts`, imported by both Claude
paths; the two `resolveClaudeSessionId` error strings are unified to
`"Claude harness does not support reuse-current continuation"`.

We deliberately do **not** force Claude's two spawn/accumulate/finalize bodies through one runner. They are
not near-verbatim: the Ink hook (`useProcess.ts`, ~500 LOC) interleaves React state into every stdout /
stderr / exit callback — debounced `publishTokenUsage`, cross-process `mergeTokenBase` carry-forward,
`MAX_OUTPUT` trimming, streaming-text and `[jq]` output, lifecycle events, kill-before-spawn, and unmount
abort — none of which exist in the lean exec factory. A shared runner would need ~10 ordered callbacks to
reproduce that, trading verbatim duplication (already removed via `turnConfig.ts`) for a fragile
callback-soup that is harder to keep behavior-identical. Codex qualifies for one runner because its two
bodies _were_ near-verbatim; Claude's are not.

**4. Cover the exec Claude path.** Add `src/harnesses/claude/session/controller.test.ts` exercising
`createClaudeSessionController` through the seam (fresh/resume/reuse-current continuation, isolation merge
precedence, token + assistant-message accumulation, stderr root-cause capture, verbose `onStderrLine`,
error/exit finalize, interrupt/kill, and transport diagnostics). This also locks in that the shared
`turnConfig.ts` helpers behave identically to the removed copies.

## Consequences

Positive:

- One home for Codex Turn interpretation and one home for Claude Turn config; the verbatim/near-verbatim
  duplication the seam was accreting is gone.
- The previously-untested exec Claude turn path is now covered (15 new tests) through the public seam.
- The `create` / `use` split is now honestly thin: shape + reactive state only.

Negative / costs:

- Claude still has two turn bodies (Ink vs exec) by design; the shared surface is the config helpers, not
  the loop. Anyone expecting _symmetry_ between the adapters (one runner each) must read this ADR to see
  why Claude is intentionally asymmetric with Codex.
- One untested Codex edge changed: when `sendPrompt` throws a non-`Error`, the fabricated message is now
  `String(error)` (matching the exec path) instead of the interactive path's former `"Unknown Codex
error"`. No behavior a test or the shell observes changed.

## References

- `src/harnesses/contracts/session.ts` - `SessionController` / `UseSessionControllerResult` (the seam)
- `src/harnesses/codex/session/turnRunner.ts` - the Codex Turn Runner (new)
- `src/harnesses/claude/session/turnConfig.ts` - shared `mergeIsolation` / `resolveClaudeSessionId` (new)
- `src/harnesses/claude/session/controller.test.ts` - exec Claude turn coverage (new)
- ADR 0003 - execution-unit terminology (Turn, Agent Session, SessionController)
- `UBIQUITOUS_LANGUAGE.md` - "Turn Runner"
