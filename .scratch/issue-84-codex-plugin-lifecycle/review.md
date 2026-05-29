## Review

- Scope: Codex runtime shutdown cleanup for plugin-provided agent roles, plus regression coverage.
- Tests: Targeted Codex lifecycle suite passed, 73 tests. `npm run typecheck` passed.
- Domain language: Existing **Subagent** and harness/runtime language remained unchanged.
- Browser/QA evidence: Skipped per alignment; no browser-visible UI surface.
- Risks: `Runtime.stop()` remains synchronous, so cleanup is scheduled internally. The implementation awaits config removal before stopping the app-server inside that scheduled shutdown path.
- Findings: none.
