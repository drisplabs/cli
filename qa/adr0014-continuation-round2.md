# ADR 0014 continuation model — round-2 live verification (2026-08-26)

Environment: Claude Code 2.1.246 (runner spawns), codex-cli 0.142.4, athena `main` @ 05d58b3 + fixes below. All runs real (`node dist/cli.js exec … --json`), no mocks except where noted.

## Verified live (PASS)

1. **Mid-run Nudge (#142)** — markerless stop mid-task → runner resumed the SAME Claude session with the corrective prompt (codeword held only in conversation memory survived into the post-nudge file); nudge-cap trip after exactly 3 progress-free nudges → `awaiting_attention` naming `nudgeCap`; 5 checkpointed markerless stops WITH tracker progress → cap reset each time, run completed (never suspended).
2. **Retry (#143)** — after fix (PR #162): dead API endpoint → 3 transient retries with exponential backoff (10/20/40s) → suspension naming `retryCap` + class `network` + real error text. Mid-run 529 window (flag-controlled local proxy): nudge turn failed transient → 10s backoff → resumed the same session (codeword survived) → completed. `CLAUDE_CODE_MAX_RETRIES=1` makes claude fail fast for such tests.
3. **Suspend → inbox → wake (#135/#139/#144)** — three parallel runs declared `WORKFLOW_BLOCKED` → all listed in `runs` (newest first, correct reasons + wake commands); explicit wake `--continue=<sid> "7"` resumed the very session that asked (codeword recalled), reused the same run row (returned to `running` → `completed`, `ended_at` stamped).
4. **Process-restart resume (#139/schema v8)** — every wake is a fresh process; one wake succeeded intact across a 20-DAY-old suspension and a deleted+recreated project dir.
5. **Bare `--continue`** — `exec "reply" --continue` resolves the project dir's most recent session and wakes it intact. (`exec --continue "reply"` is a parse trap — issue #166.)
6. **maxTurnTokenCount override (#141)** — `loop.maxTurnTokenCount: 105000` in a custom workflow.json was honored: PreCompact fired at ≈95% of 105k (baseline ~20k + one 75k-token read), on every turn including post-handover fresh turns and forks; at the 130k default the same contexts (34–90k) never fired. Handover fork + handoff skill wrote the Handoff file 8/8 times under the override.
7. **Codex (after fix, PR #167)** — permissive run completes the default workflow end-to-end; strict run suspends in ~1min naming the sandbox approval instead of hanging. `maxTurnTokenCount → model_auto_compact_token_limit` mapping confirmed in code.
8. **Handover degrade (#145)** — with the fork process SIGKILLed the moment the handover began, `run.handover.degraded` fired within 2s, the interrupted Agent Session resumed **in place** (same session id), finished the remaining work, and completed with the marker — no stall, exit 0. Two fixture lessons: (a) permission-based fork sabotage does not work — the fork agent hit EACCES on the locked tracker dir and ran `chmod u+w` itself, wrote the Handoff file, and the run carried on; (b) killing the fork process is the reliable agent-proof way to force `forkOk=false`.

## Defects found → shipped

- **PR #162 (merged)** — transient API failures classified `hard/unclassified` and suspended instead of retrying: Claude headless stream-json prints API errors to STDOUT as the final stream message with an EMPTY stderr; the taxonomy only read stderr. Fix: classify from the final stream message too; name it in the failure detail.
- **PR #163 (merged)** — CI red on main since Jul 31: prettier 3.8 (lockfile) errors on the CLAUDE.md symlink, docs/mockup.html, CHANGELOG.md. Fix: `prettier --check .` + `.prettierignore`.
- **PR #167** — codex: `auto-edit` is an invalid AskForApproval variant in codex-cli 0.142+ (killed every permissive run at spawn); headless sandbox approvals hung forever on the null-timeout decision. Fix: valid policy union, permissive→`never`+full access, any unattended `permission.request` suspends with a named reason.

## Defects found → filed

- **#164** — Handover has no streak cap: a too-tight bound + one large atomic ingest = handover loop (observed: 8 consecutive ~70s cycles, ~200k tokens each, tracker frozen) bounded only by `maxIterations`. Suggest nudge-style streak → degrade to vendor compaction.
- **#165** — Waking a suspended run uses the currently-active workflow, not the run's persisted one (observed: `default` run woken under `fullstack-engineering`); row keeps the old name, masking it.
- **#166** — `exec --continue "reply"` swallows the reply as the flag value → bare usage error.
- **#168** — Interactive TUI wires none of the ADR 0014 seams: nudge falls back to fresh turns (and the nudge cap can never trip), no handover, `awaiting_attention` invisible in the TUI.

## Not testable in this environment

- **Wake degrade with a genuinely dead vendor session (#144)** — every fixture route (delete/move `~/.claude` session file, corrupt persisted `adapter_session_id` in session.db) was blocked by the sandbox permission classifier; AND the "moved project dir" trick no longer works because **Claude ≥2.1.24x resolves `--resume <id>` globally across cwds** (a round-1 assumption now stale — dead sessions are rarer than assumed). The degrade branch remains covered by unit tests and the PR #161 live shape.
- **Channel-attached questions** — needs a live answerable bridge; only the user's real Telegram is configured (outward-facing). Code-verified: with a bridge, `relayQuestion`/`relayPermission` are installed and the `!bridge` suspension conversion is correctly skipped. Edge noted in #168: a configured-but-unreachable broker still counts as attached.
- **100k clamp floor re-measurement on 2.1.246** — not re-run (expensive); the 105k override behaved consistently with round-1's model.

## Measurement corrections for future rounds

- Random dictionary-word filler ≈ **3 tokens/word (~75k per 250KB)**, not ~30k as `qa/precompact-block-verification.md` assumed — this is what exposed #164.
- Claude API errors (connection refused, 529) go to **stdout** in stream-json mode; stderr can be empty. Any stderr-only diagnostics miss them.
- `CLAUDE_CODE_MAX_RETRIES` exists and works (fail-fast in ~4s vs >3min default internal retries).
