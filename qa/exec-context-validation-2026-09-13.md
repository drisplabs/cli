# Live exec context validation — 2026-09-13

**Initial result before fixes: failed validation.** A real source-audit task performed 44 tool calls,
experienced native Codex compaction, hit a live token limit, and was resumed.
The resumed run stalled; its timeout launched another Agent Session instead of
stopping. The test process tree was forcibly terminated. No `review.md` was
produced, and the audit task did not complete.

All test-owned processes were verified stopped. The last persisted Workflow Run
row remains `running`, iteration 2, because the final stop was forced; it is not
evidence of a live process. Last persisted usage was 1,179,844 tokens. Unreported
provider-side usage cannot be established from these logs.

## Setup

- Built the current uncommitted rewrite with `npm run build`.
- Ran the actual `dist/cli.js exec` entry point with JSONL logging and durable
  session persistence, against a separate source snapshot.
- Task: audit continuation, checkpoints, accounting, cancellation, wake,
  permissions, steering and terminal markers; write a source-referenced report.
- No subagents, source edits, or nested model calls were requested.
- Initial working attempt: Codex `gpt-5.5`, medium reasoning, context setting
  100,000, lifetime token ceiling 1,000,000, three-Turn ceiling, timeout 360 s.
- Wake: same Workflow Run and Agent Session, lifetime ceiling increased to
  2,000,000, timeout 180 s; asked to finish from existing evidence.
- Workflow Run: `5d0686d1-9632-4474-82fb-ccf00f2b5a24`.
- Athena Session: `8b8e31a5-1375-41eb-b3df-3559a664098b`.
- Original Agent Session: `01a09bb5-6041-74d0-be16-fc207b668a45`.

Claude 2.1.270 could not run: organization policy disabled subscription access,
and no Anthropic API key was configured in the environment. The terminal Codex
0.142.4 and desktop 0.142.0-alpha.1 binaries both rejected the configured
`gpt-6-astra` model as requiring a newer client. The desktop binary succeeded
with `gpt-5.5` selected only in the temporary test workflow. No global model or
binary configuration was changed.

## Observed context and usage

Times below are UTC. Input context is the raw vendor input-token measurement,
not drisp's inflated context value. Cumulative usage is not context occupancy.

| Time                      | Observation                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 16:59:31.085              | First request: 25,083 input, 5,504 of it cached, 246 output, 22 of it reasoning; total 25,329. Drisp displayed context 30,587 and output 268.                |
| 17:00:29.615              | Last usage before native compaction: 90,498 input context; cumulative total 514,488. This is not the precise internal trigger threshold.                     |
| 17:00:29.627–17:01:22.848 | Native `item.contextCompaction` started/completed in 53.221 s. No `run.handover` or fresh-session restart occurred.                                          |
| 17:01:22.846              | Vendor reported a compacted estimate of 24,090 total tokens with zero input/output fields. Drisp mapped context to zero.                                     |
| 17:01:29.561              | First ordinary request after compaction: 29,317 input context. Audit continued in the same Agent Session.                                                    |
| 17:02:17.575–17:02:17.580 | Vendor total reached 1,045,920; drisp emitted a structured token-budget suspension five milliseconds later.                                                  |
| 17:02:20.505              | Vendor reported another 81,146 tokens during shutdown, bringing total to 1,127,066.                                                                          |
| 17:02:22.612              | `exec.completed` still reported 1,045,920; the late usage was omitted. Total raw observed overshoot was 127,066, not just the 45,920 recorded at suspension. |
| 17:02:58.119              | Wake started in the same Agent Session. Its initial usage notification contained the old Turn's 1,127,066 total.                                             |
| 17:05:54.411              | Resumed exec emitted its 180-second timeout with no new model output from the resumed Turn.                                                                  |
| 17:06:02.070              | A fresh Agent Session started, 7.659 seconds after the timeout; it subsequently made tool calls.                                                             |
| 17:06:25.081              | Test-owned process tree terminated explicitly.                                                                                                               |

The Journal had a structurally valid current-Run Restart section of approximately
211 estimated tokens. It was preserved at the budget stop. Its contents still
described initial orientation after the audit had inspected dozens of files;
structural validity did not establish freshness of the substantive work state.
The proposed Journal-based fresh restart was **not exercised**: Claude access was
blocked and Codex used its native compaction path.

## Confirmed issues

1. **Timeout does not stop continuation.**
   `src/app/exec/runner.ts:410` records a failure and kills the current harness
   Turn, but does not cancel the Workflow Runner. The timeout uses that latch at
   line 719. A failed resume can then take the reducer's fresh fallback. The
   JSONL confirms both a new session and new tool activity after the timeout.
   Cancellation must reach the Runner and prevent every subsequent kickoff;
   cancelling an individual harness invocation is insufficient.

2. **Usage reported during shutdown is dropped.**
   `src/core/workflows/workflowRunner.ts:676` resolves the resource stop with the
   current total; `observe` ignores subsequent usage once stopped or finished
   at line 683. The raw vendor transcript recorded 81,146 more tokens before
   exec finished, but the persisted stop/result omitted them. Stopping admission
   and finalizing accounting need separate lifecycles. Recovery of some usage
   on a later thread resume does not make the original result accurate.

3. **Codex usage normalization double-counts subsets.**
   `src/harnesses/codex/runtime/tokenUsage.ts:31` adds reasoning to output even
   though the observed output total already includes it. Line 36 adds cached
   input to input even though cached input is a subset. The first real sample
   demonstrates both errors, and the existing fixture arithmetic does not
   reflect the observed vendor semantics. `getCodexUsageTotals` also derives
   context from lifetime totals rather than the latest request. Normalize
   disjoint billing categories and current context separately, preserving the
   special post-compaction estimate when input fields are zero.

The stalled wake's underlying provider/runtime cause is not established. The
post-timeout continuation and accounting discrepancies are directly observed.

## Evidence and replay

- [Structured observations](exec-context-validation-2026-09-13.json): usage
  notifications, raw token-count samples, lifecycle timestamps and process stop.
- Full local run artifacts:
  `/tmp/drisp-context-live-20260913-222633/`.
- Successful model attempt JSONL:
  `/tmp/drisp-context-live-20260913-222633/codex-compatible-attempt/events.jsonl`.
- Wake JSONL:
  `/tmp/drisp-context-live-20260913-222633/codex-resume/events.jsonl`.
- Snapshot and Journal:
  `/tmp/drisp-context-live-20260913-222633/project/`.
- Each attempt has `command.json`, `meta.json`, `stderr.log`, and `exit.json`.
  Monitor snapshots are in `monitor.jsonl`. The workflow remains installed as
  `codex-context-live-20260913-222633` for deliberate replay; its current token
  limit is 2,000,000 after the wake.

Do not treat `exec.completed.success: true` alone as task completion: the budget
attempt also emitted `run.suspended`. Completion requires the Workflow Run's
terminal state and requested output artifact.

## Verification after fixes, before PR

The live findings above led to three fixes: cancel the Workflow Runner when exec
fails, reconcile usage until interruption settles (bounded to six seconds), and
normalize Codex cache/reasoning subsets without adding them twice. Codex interrupt
now uses a JSON-RPC request, and resumed usage notifications do not rebill prior
Turns. Regression tests also cover checkpoint limits, context admission and
boundary telemetry.

A second real Codex exec task read `tokenUsage.ts` and wrote `verification.md`
with the correct arithmetic: input 19,579, cache read 5,504, output 246, total
25,329, context 25,083. It updated the current-Run Restart checkpoint and wrote
the completion marker. Its 200,000-token cap won the final boundary race, so the
Run correctly persisted as awaiting attention, **not completed**, at 215,226
tokens. All eight streamed usage updates and the raw Codex transcript reconciled
with the final exec total (215,226). Opening context was 24,638 tokens and final
context 28,214. This short task did not exercise compaction or a fresh restart.

A separate real exec with a 15-second timeout exited with code 6 after 15,018 ms.
After the timeout event it emitted no new session start, Turn start, or tool call;
only interruption completion and shutdown notifications followed. Both test-owned
exec processes exited. This confirms cancellation during the live first Turn;
the deterministic loop regression additionally checks that no retry is admitted.

Artifacts for these follow-up checks are in `/tmp/drisp-pr-validation-20260913`.
The earlier large audit and a real Claude checkpoint restart remain unverified;
Claude account access was unavailable. These limitations do not imply those live
paths passed. Full local suite: 3,666 tests passed, followed by two added passing
raw-usage fixture cases. Typecheck, build, generated schemas and dead-code checks
passed. ESLint passed with existing warnings when local nested worktrees and
package build output were excluded.
