# Alignment: Issue #84 Codex Plugin Lifecycle

## Scale

Standard. The change is harness/runtime behavior with config files and tests, but the relevant surface is bounded to Codex plugin lifecycle modules.

## Goal

Finish issue #84 by ensuring Codex harness workflows load plugin-provided agents, configure Codex multi-agent roles, unload stale roles on workflow changes, and keep skills/MCP behavior intact.

## Scope

Expected files:

- `src/harnesses/codex/runtime/agentConfig.ts`
- `src/harnesses/codex/runtime/server.ts`
- `src/harnesses/codex/session/sessionAssets.ts`
- `src/harnesses/codex/session/promptOptions.ts`
- Tests under `src/harnesses/codex/**/__tests__` and related session tests

Current implementation already includes an agent config bridge, prompt forwarding, and server tests. Work should focus on failing/missing acceptance criteria, not reimplementing the whole issue body.

## Non-Goals

- No generated protocol schema edits by hand.
- No broad rewrite of workflow installation or Claude harness behavior.
- No UI changes.
- No changes to domain terms in `CONTEXT.md` unless a new durable concept emerges.

## Verification

- Targeted baseline: Codex runtime/session tests covering `agentConfig`, `server`, `promptOptions`, and `sessionAssets`.
- After edits: rerun targeted tests.
- If touched shared workflow/bootstrap behavior, also run relevant bootstrap/workflow tests.
- Browser QA skipped: this is CLI/runtime behavior, not browser-visible UI.

## QA Mode

Skip. This is internal Codex harness runtime behavior with unit/integration tests as the useful evidence.

## Domain Updates

`CONTEXT.md` unchanged. Existing terms already cover harnesses, Sessions, Runs, Subagents, and workflow runtime.
