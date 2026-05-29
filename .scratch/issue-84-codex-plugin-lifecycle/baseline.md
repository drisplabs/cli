# Baseline: Issue #84

## Command

`npm test -- src/harnesses/codex/runtime/__tests__/agentConfig.test.ts src/harnesses/codex/runtime/__tests__/server.test.ts src/harnesses/codex/session/promptOptions.test.ts src/harnesses/codex/session/sessionAssets.test.ts`

## Result

Passed before implementation: 4 files, 72 tests.

## Regression Probe

Added a test for session-end agent cleanup in `src/harnesses/codex/runtime/__tests__/server.test.ts`.

Initial result: failed as expected. `runtime.stop()` did not write removal edits for previously loaded agent roles, so `.codex/config.toml` could retain stale `agents.*` entries after the runtime stopped.
