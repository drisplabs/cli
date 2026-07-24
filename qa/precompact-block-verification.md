# PreCompact block verification (ADR 0014 / issue #137)

Proves, against a real Claude Code session, that a synchronous `PreCompact` hook
replying `{"decision":"block"}` on stdout **prevents auto-compaction** — and that
the same reply dispatched `async` is **silently dropped**. This is the mechanism
the whole Handover chain rests on; its failure mode produces no error and no
crash, so only a live run demonstrates it.

Verified: 2026-07-24, Claude Code `2.1.217` (macOS arm64), model default.

## What was verified

| #   | Claim                                                                                     | Result                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | A sync `PreCompact` hook's stdout `{"decision":"block","reason":...}` prevents compaction | **Confirmed** — 13 auto-compaction attempts, 13 `PreCompact` events, **0** `PostCompact`, **0** `compact_boundary`; session kept working past each blocked attempt |
| 2   | The identical reply from an `async: true` hook is ignored                                 | **Confirmed** — 3 `PreCompact` events with the same block reply, **3** `PostCompact`, **3** `compact_boundary`; compaction completed every time                    |
| 3   | With no effective block, the session degrades to normal vendor compaction and never hangs | **Confirmed** — the async run compacted three times and finished `success`                                                                                         |

Two incidental findings recorded for issue #141:

- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is **clamped to a minimum of 100 000 tokens**
  (and a maximum of 1 000 000) in 2.1.217 — values below 100k are silently raised.
  `maxTurnTokenCount` for the Claude harness therefore cannot trigger below 100k.
- The auto-compact check runs between steps of the agentic loop; a blocked
  compaction is re-attempted at (roughly) every subsequent step while context
  stays above the threshold, so the orchestrator receives repeated `PreCompact`
  events until it acts (or the Turn ends).

## How to re-run

Everything below runs from a scratch directory.

1. **Hook script** — `precompact-hook.mjs` (logs its stdin, replies with the same
   wire shape athena's `decisionMapper` emits for intent `compact_block`):

   ```js
   #!/usr/bin/env node
   import fs from 'node:fs';
   const MODE = process.env.PRECOMPACT_QA_MODE ?? 'block'; // block | passthrough
   const LOG = process.env.PRECOMPACT_QA_LOG ?? '/tmp/precompact-qa.log';
   let data = '';
   process.stdin.setEncoding('utf8');
   process.stdin.on('data', c => (data += c));
   process.stdin.on('end', () => {
   	fs.appendFileSync(
   		LOG,
   		JSON.stringify({ts: Date.now(), mode: MODE, input: data.trim()}) + '\n',
   	);
   	if (MODE === 'block') {
   		process.stdout.write(
   			JSON.stringify({decision: 'block', reason: 'QA: compaction blocked.'}),
   		);
   	}
   	process.exit(0);
   });
   ```

2. **Settings files** — register the script for `PreCompact` **and** `PostCompact`
   (the latter is the compaction-completed detector). `settings-sync.json` uses
   `{"type":"command","command":"node <abs path>/precompact-hook.mjs"}`;
   `settings-async.json` is identical except the PreCompact entry adds
   `"async": true`. This mirrors `generateHookSettings.ts` exactly: sync entries
   omit `async`; async entries carry `async: true`.

3. **Context filler** — auto-compaction cannot be triggered cheaply below the
   100k clamp, so generate ~4 × 250 KB files of dictionary words
   (`/usr/share/dict/words`, 2000 lines × 12 words each): reading them via the
   Read tool adds ~30k tokens apiece.

4. **Case A (sync + block):**

   ```sh
   CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000 \
   PRECOMPACT_QA_MODE=block PRECOMPACT_QA_LOG=$PWD/hook-sync.log \
   claude -p "Use the Read tool to fully read these files one at a time, in order: big1.txt, big2.txt, big3.txt, big4.txt. After each file, reply with just 'ok <filename>' and continue. Do not summarize contents." \
     --output-format stream-json --verbose \
     --settings settings-sync.json --setting-sources "" \
     --permission-mode bypassPermissions --max-turns 16 > run-sync.log 2>&1
   ```

   **Pass criteria:** `hook-sync.log` contains `PreCompact` entries and **no**
   `PostCompact` entries; `grep -c compact_boundary run-sync.log` is `0`; the
   stream shows `status: compacting` followed by a cleared status with no
   boundary each time (blocked attempt), and the session continues working.

5. **Case B (async + block — the silent failure mode):** same command with
   `--settings settings-async.json`. **Pass criteria:** `hook-async.log`
   contains both `PreCompact` and `PostCompact` entries and
   `grep -c compact_boundary run-async.log` is ≥ 1 — the identical block reply
   was ignored and compaction completed. If Case B ever starts _blocking_,
   Claude has changed async-hook semantics and `SYNC_HOOK_EVENTS` no longer
   needs `PreCompact` (but keeping it is harmless).

## Where the mechanism lives in athena

Three coupled changes, all required (each alone fails silently):

- `src/harnesses/claude/runtime/interactionRules.ts` — `compact.pre` claims
  `expectsDecision: true` **and** `canBlock: true`, with a **finite** timeout:
  the timeout passthrough is the degrade-to-vendor-compaction fallback.
- `src/harnesses/claude/hooks/generateHookSettings.ts` — `PreCompact` is in
  `SYNC_HOOK_EVENTS` so the forwarder's stdout reply is honored.
- `src/core/controller/runtimeController.ts` — the `interceptCompaction`
  callback answers `compact.pre` with intent `{kind: 'compact_block'}`, which
  `decisionMapper.ts` translates to `{"decision":"block","reason":...}`.

Non-workflow sessions register no `interceptCompaction`, the event goes
unhandled, the adapter timeout fires a passthrough, and vendor compaction
proceeds unchanged.
