# Claude Code Spec Drift — Athena Integration Audit

> **What this is**: a point-in-time diff between Athena's Claude Code integration surface
> and the current Claude Code hook/CLI specification.
> **Spec source**: `cli-reference`, `commands`, and `hooks` reference, as published for
> Claude Code v2.1.212. **Not** `docs/claude_code/`, which is a frozen 2026-03-09 snapshot
> and is itself one of the findings below.
> **Audited**: 2026-07-19 against `main` @ `8987c25`.

Athena spawns Claude Code as a subprocess and forwards its hooks over a UDS. Claude Code's
hook and CLI contract is therefore not a dependency detail — it _is_ Athena's integration
surface, and drift in it shows up as silent misbehaviour rather than as a build failure,
because the payload crosses the boundary as `Record<string, unknown>`.

## How to read this

| Mark      | Meaning                                                                            |
| :-------- | :--------------------------------------------------------------------------------- |
| **BUG**   | Athena is wrong on the wire today. Observable misbehaviour, not a missing feature. |
| **STALL** | Correct output, but costs wall-clock that the spec offers a way to avoid.          |
| **GAP**   | Spec offers something Athena does not model or cannot express. Additive.           |
| **ROT**   | A doc in this repo makes a claim about the code that is no longer true.            |

Findings were produced by a fan-out audit (five spec dimensions), then each was
adversarially re-checked against source with a refute-by-default posture. **16 of 51
candidate findings were refuted** and are excluded; the survivors below were confirmed by
reading the cited source. The five marked ✓ were additionally verified by hand while
writing this doc.

---

## 1. Live bugs

### 1.1 **BUG** ✓ — `PermissionRequest` denials carry no rationale

`createPermissionRequestDenyResult` emits `{behavior: 'deny', reason}`
([result.ts:310](../src/harnesses/claude/protocol/result.ts:310)). The spec's deny object
has no `reason` field — the rationale field is **`message`**. Claude Code drops the
unrecognized key, so every denial Athena issues arrives with no explanation and Claude
retries or reformulates blind. The denial itself still lands; only the cause is lost.

The type declares both `reason` and `message` as optional
([result.ts:64-65](../src/harnesses/claude/protocol/result.ts:64)), so the `satisfies`
clause applies no pressure. Three call sites route through this helper: `runtimeController.ts:57-68`,
`relayAdapter.ts:120-127`, and the TUI dialog at `useFeed.ts:366-377`.

The origin is documentary: [hook-signatures.md:115](./hook-signatures.md) calls `reason` an
"alias for message". It is not. Fix the code and the doc together, and drop `reason` from
the type so it cannot recur.

### 1.2 **BUG** ✓ — every `StopFailure` renders as `unknown`

The translator reads `payload['error_type']` and `payload['error_message']`
([eventTranslator.ts:169-176](../src/harnesses/claude/runtime/eventTranslator.ts:169)).
The spec sends **`error`** and **`error_details`**. Both reads resolve to `undefined`,
`decisionProjection.ts:121` substitutes the literal `'unknown'`, and the feed renders
`Stop failure: unknown` with no message.

This silently erases exactly the class of failure an operator most needs attributed:
rate limits, billing errors, auth failures, and overload. `last_assistant_message` — which
on this event carries the rendered API error string — is dropped on the same path.

`StopFailureErrorType` ([events.ts:91-98](../src/harnesses/claude/protocol/events.ts:91))
is also missing three spec members: `overloaded`, `oauth_org_not_allowed`, `model_not_found`.

### 1.3 **BUG** ✓ — the PATH-fallback forwarder bin does not exist

Three source strings name `drisp-hook-forwarder`
([generateHookSettings.ts:163](../src/harnesses/claude/hooks/generateHookSettings.ts:163),
`spawn.ts:90`, `verifyHarness.ts:327`). `package.json:26` installs the bin as
**`athena-hook-forwarder`**. The rename was reverted in `b95a9bd` and these literals never
followed. Whenever the resolved-path lookup misses and the PATH fallback is taken, the hook
command exits 127.

This is normally benign — Claude Code treats a non-zero hook exit as a non-blocking error —
with one exception: for `WorktreeCreate` **any** non-zero exit aborts worktree creation
(§4.3).

### 1.4 **BUG** — `CwdChanged` reports the wrong directory

`CwdChangedEvent` adds no fields ([events.ts:289-292](../src/harnesses/claude/protocol/events.ts:289))
and the translator falls back to the base `cwd`. But `hook-forwarder.ts:171` documents base
`cwd` as the invariant project directory and derives the socket path from it, so it does not
track `cd`. `timeline.ts:790-792` renders `cwd -> ${data.cwd}`, which prints the project root
on every directory change. The spec sends `old_cwd` and `new_cwd`; model both and render the
transition.

---

## 2. The registration stall

### 2.1 **STALL** ✓ — ~4s of dead wall-clock after every tool call

This is the highest-value item in the audit.

[generateHookSettings.ts:187-190](../src/harnesses/claude/hooks/generateHookSettings.ts:187)
builds **one** `{type: 'command', command}` literal and reuses it for all 26 registered
events (`:196-212`). It sets neither `async` nor `timeout`.

The consequence follows from Athena's own decision machinery. For an event Athena does not
decide on, `runtimeController.ts:129` returns `{handled: false}`, no `sendDecision` is
issued, and the envelope sits in `pending` with the socket held open
([server.ts:286-291](../src/harnesses/claude/runtime/server.ts:286)). The _only_ resolution
is the timer at [server.ts:270-284](../src/harnesses/claude/runtime/server.ts:270) firing
`{type: 'passthrough', source: 'timeout'}` after `DEFAULT_TIMEOUT_MS = 4000`
([interactionRules.ts:6](../src/harnesses/claude/runtime/interactionRules.ts:6)).
Claude Code is blocked that entire time, because the forwarder process has not exited.

That is ~4s after **every `PostToolUse`**, plus `Notification`, `SessionStart`/`SessionEnd`,
`PreCompact`/`PostCompact`, `Subagent*`, `UserPromptSubmit`, `Setup`, `CwdChanged`,
`TeammateIdle`, `Task*`, `ConfigChange`, `InstructionsLoaded`, `Worktree*` — and
`stop.request` at every turn end. A 50-tool workflow burns roughly 200 seconds buying a
passthrough that Athena already knows at registration time.

**The fix is unusually clean, because the required metadata already exists.**
`interactionRules.ts` already classifies every kind with `canBlock` and `expectsDecision` —
`tool.post` is already `{expectsDecision: false, canBlock: false}`
([interactionRules.ts:24-29](../src/harnesses/claude/runtime/interactionRules.ts:24)).

- Add `async?: boolean` to the `HookCommand` type (`generateHookSettings.ts:57-61`).
- Stop reusing a single literal. Emit `async: true` for every event whose rule has
  `canBlock === false` — i.e. derive registration from `interactionRules.ts` rather than
  from the two hand-maintained string arrays at `:16-52`. Per spec, an `async` hook cannot
  block and its decision fields are ignored, which is precisely what these events already do.
- This removes the stall on ~19 of 26 events with **no semantic change**.

### 2.2 **GAP** — no `timeout` is ever written, so blocking prompts are capped at 600s

Because nothing sets `timeout`, the two paths deliberately designed to wait indefinitely —
`PreToolUse` and `PermissionRequest`, both `defaultTimeoutMs: null` — are silently subject
to Claude Code's 600s default. Past 600s Claude kills the forwarder, `server.ts:302-317`
synthesizes a passthrough, and because Athena spawns with `--setting-sources ''`
(`spawn.ts:229`) that passthrough leaves Claude with no permission config and the tool
**fails silently** — the exact failure `runtimeController.ts:97-100` documents and works
around. A permission prompt left through lunch breaks the tool call, and the user's later
click no-ops at `server.ts:407-408`. Set an explicit large `timeout` on those two handlers.

Related: the forwarder's wait-forever allowlist is hardcoded to two event names
([hook-forwarder.ts:165-169](../src/harnesses/claude/hook-forwarder.ts:165)), which
contradicts `Elicitation`'s declared `defaultTimeoutMs: null` (§4.4). Consult the
interaction rules instead.

### 2.3 **GAP** — exec form is computed, then discarded

`resolveHookForwarderCommand` already returns `executable: process.execPath, args: [resolvedPath]`
(`generateHookSettings.ts:152-158`), and the caller throws them away in favour of a
POSIX-quoted shell string. The spec's exec form (`command` + `args`) spawns the executable
directly with no shell, which removes an `sh -c` per hook and the entire quoting surface —
including the path-with-spaces class of bug. Emit `args`.

---

## 3. Dropped event fields

The translator builds a fresh per-kind `data` object from named keys. That is the right
design — but the source is `Record<string, unknown>`, so a key that does not exist is
indistinguishable from a key that is absent, and the compiler cannot catch either. §1.2
is the same defect having already landed.

| Field                                                                                       | Event                               | Where dropped                                                                        | Worth                                                                                                                                                                                                                                                                                                                                     |
| :------------------------------------------------------------------------------------------ | :---------------------------------- | :----------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `duration_ms`                                                                               | `PostToolUse`, `PostToolUseFailure` | [eventTranslator.ts:100-128](../src/harnesses/claude/runtime/eventTranslator.ts:100) | **Medium.** Athena has _no_ per-tool latency. The forwarder already delivers it verbatim (`hook-forwarder.ts:147,160`) and the whitelist discards it. No local substitute exists — `toolCorrelation.ts:31-68` stores no timestamps. A live terminal feed that cannot say "Bash 4.2s" is leaving the cheapest observability win unclaimed. |
| `background_tasks[]`, `session_crons[]`                                                     | `Stop`, `SubagentStop`              | not modelled                                                                         | Low–medium. The only structured signal that detached work is outstanding at a turn boundary. Prerequisite for a background-task panel or an orphan-warning on quit.                                                                                                                                                                       |
| `resolvedModel`, `totalTokens`, `totalDurationMs`, `totalToolUseCount`, `usage{}`, `status` | Agent tool `tool_response`          | `ToolResponseMap` covers only Write/NotebookEdit/Skill (`toolSchemas.ts:288-293`)    | Low–medium. `SubagentMetrics.tokenCount` is hardcoded `null` (`useHeaderMetrics.ts:132`) with a reserved slot waiting. Aggregate subagent tokens _are_ already counted; what is missing is per-subagent attribution and `status: 'async_launched'` — the only signal that a backgrounded Agent is still running.                          |
| `event` (`change`\|`add`\|`unlink`)                                                         | `FileChanged`                       | not modelled                                                                         | Low. A creation, a modification and a deletion currently render byte-identical (`titleGen.ts:162-163`). Low reach — `FileChanged` is deliberately not registered.                                                                                                                                                                         |
| `prompt_id`, `effort`                                                                       | all events (spec-common)            | not modelled                                                                         | Low. `prompt_id` matches the OTel `prompt.id` attribute, so it is the join key between Athena's feed and any telemetry pipeline.                                                                                                                                                                                                          |

**Remediation shape** for each: `protocol/events.ts` → `core/runtime/events.ts` →
`core/feed/types.ts` → the translator case. A translator-only patch will not typecheck,
which is the type system working as intended. Consider a shared `readString`/`readNumber`
helper keyed by a spec-field-name constant so the §1.2 typo class becomes greppable.

Note the same `duration_ms` hole exists on the Codex side — `ThreadItem.ts:77,99,113`
supplies `durationMs` and `codex/runtime/eventTranslator.ts:632-647` drops it. Fix once in
`ToolPostRuntimeData`/`ToolFailureRuntimeData` and wire both harnesses.

---

## 4. Output-contract capability gaps

### 4.1 **GAP** — assistant prose never reaches the structured feed on the Claude path

`message.delta` / `message.complete` are declared runtime kinds with `turn_id`/`item_id`/`delta`
payloads (`core/runtime/events.ts:10-11,81-94`), and `agentMessageStream`
(`runSessionProjection.ts:143-163`) is driven exclusively by them. The Claude translator
emits 28 kinds and **none is `message.*`** — only Codex emits them.

The assumed mitigation does not exist: `feedStdout` routes into `streamJsonToolParser`,
whose own docstring says it handles tool events only and that "assistant messages are parsed
elsewhere" (`streamJsonToolParser.ts:8-9`). Claude's sole assistant-text capture is
`assistantMessageAccumulator.ts:70-72`, a single `lastMessage` surfaced at process exit.

**This is fixable without touching hooks at all.** Athena already spawns with
`includePartialMessages: true` (`spawn.ts:209-210`), so the deltas are on the stdout wire
right now. Extend `streamJsonToolParser.ts` to emit `message.delta`/`message.complete` from
`stream_event`/`assistant` frames and feed the existing dead consumer. This is strictly
better than adopting the spec's `MessageDisplay` hook, which targets Claude Code's own TUI —
a surface Athena does not use, since it runs headless.

### 4.2 **GAP** — `updatedPermissions` is untyped and unreachable

`result.ts:63` types it `unknown[]`, and `decisionMapper.ts:46` calls the allow helper with
**zero arguments**, so nothing can ever populate it. The correct union already exists at
`shared/types/permissionSuggestion.ts:12-31` and is currently applied input-only — fixing
the type is a one-line import.

What this forfeits: Athena's in-memory `HookRule` layer (`useFeed.ts:350-363`) covers
"always allow this tool" for the current run only. The spec's `updatedPermissions` offers
cross-run persistence, `setMode`, and `addDirectories` — none of which `rules.ts:25-36`
(tool-name matching only) can represent. Today `PermissionDialog.tsx:63` offers
`Always allow "<tool>"` while delivering run-scoped memory.

### 4.3 **GAP** — `WorktreeCreate` uses the wrong return contract

It is registered as a plain command hook (`generateHookSettings.ts:50,187-190`). Per spec a
_command_ hook for this event must print the worktree path as the **last non-empty stdout
line**; only an _http_ hook returns `hookSpecificOutput.worktreePath`. Athena's timeout
passthrough exits 0 with zero stdout (`hook-forwarder.ts:197-200`), and the otherwise-dead
`createWorktreeCreateResult` would emit a JSON blob that Claude would take _as_ the path.

This event is also the sole exception to the exit-code rule: **any** non-zero exit aborts
creation, which is what makes §1.3 load-bearing here. Either wire it correctly or drop it
from `NON_TOOL_HOOK_EVENTS`.

### 4.4 **GAP** — `Elicitation` is declared a decision point that cannot be decided

`interactionRules.ts:180-184` sets `expectsDecision: true` and `defaultTimeoutMs: null`, but
`runtimeController` never handles the kind, `createElicitationResult` has zero callers, and
`RuntimeIntent` has no elicitation variant. So no server timer arms and no decision can be
produced: MCP elicitation forms appear in the feed as awaiting a decision and are then
abandoned until the forwarder's own `SOCKET_TIMEOUT_MS = 5000` self-aborts. Codex implements
this (`codex/runtime/decisionMapper.ts:75,83-86`). The helper also hardcodes
`hookEventName: 'Elicitation'`, so it cannot serve `ElicitationResult`.

### 4.5 **GAP** — smaller unreachable surfaces

- **`updatedToolOutput`** (`PostToolUse`) — absent; only the deprecated
  `updatedMCPToolOutput` exists (`result.ts:44`). This is the only hook that can redact or
  normalize a tool result before Claude sees it. Note the generic `block` path maps to exit 2
  (`decisionMapper.ts:28-33`), which per spec **does not block `PostToolUse`** — so flipping
  `canBlock` alone would silently no-op.
- **`PermissionDenied.retry`** (`result.ts:73`) — the only field this event reads; nothing
  constructs it. Registering the event for observation only forfeits the sole lever for
  overriding an auto-mode classifier denial in a headless run.
- **`Stop` `hookSpecificOutput.additionalContext`** — `result.ts:94-99` has no
  `hookSpecificOutput`, though seven sibling events do. Currently moot: `stop_block` has
  zero production callers, so Athena does no Stop-time steering at all. Build both or neither.
- **`terminalSequence`** — unmodelled. Since v2.1.139 hooks run with no controlling terminal,
  and this is the supported replacement for writing to `/dev/tty` (allowlist: OSC 0/1/2/9/99/777
  and BEL). Relevant if Athena ever wants desktop notifications on permission prompts.
- **10,000-char output cap** — unhandled. Longer `additionalContext`/`systemMessage`/stdout
  is spilled to a file by Claude Code and replaced with a preview plus path.

---

## 5. Unregistered spec events

`PostToolBatch`, `MessageDisplay`, and `UserPromptExpansion` have **zero occurrences** in
`src/` or `docs/`. `generateHookSettings.ts` is the sole registration site and `spawn.ts:229`
passes `--setting-sources ''`, so no user or project settings can register them either. The
forwarder itself is name-agnostic (`hook-forwarder.ts:159`) — registration is the only blocker.

Impact is smaller than the raw count suggests, and this ranks below everything above:

- **`UserPromptExpansion`** — the only one with a clean argument. Slash-command and MCP-prompt
  expansions are currently invisible and unblockable; `UserPromptSubmit` yields the raw prompt
  only. **Recommend adopting**: add to `NON_TOOL_HOOK_EVENTS` plus a `user.prompt.expansion` kind.
- **`PostToolBatch`** — `PreToolUse` is registered with matcher `*`, so every call inside a
  batch is still gated and observed. What is lost is only the batch _boundary_. Nothing in
  `core/feed` or `ui/` groups parallel calls today, so nothing is degraded. **Defer.**
- **`MessageDisplay`** — superseded by §4.1; the stdout path is strictly better here. **Defer.**

Also correct the docblock at `generateHookSettings.ts:4-5`, which claims it registers "all
hook events".

---

## 6. CLI surface

`FLAG_REGISTRY` (`flagRegistry.ts:40-129`) is closed — `buildIsolationArgs` iterates it
exclusively and `spawn.ts:220-247` has no passthrough, so there is no escape hatch.

| Flag                                                    | Assessment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| :------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--input-format stream-json` + `--replay-user-messages` | The only item with architectural weight. The prompt is baked into argv (`spawn.ts:220`) and stdin is `'ignore'` (`spawn.ts:263`), which is why `turnConfig.ts:39-51` throws on `reuse-current`. Every turn pays a full process respawn. This is a latency-and-architecture project — long-lived child, stdin pump, turn demarcation, hook-socket lifetime — not two registry entries. Codex already does it (`codex/runtime/appServerManager.ts:135-171`). Note `reuse-current` has zero production constructors today, so the throw is defensive, not a live crash. |
| `--session-id`                                          | Cheap, real cleanliness win. The vendor session id is learned reactively from the first hook envelope (`server.ts:96,256-258`) with no stdout fallback — `streamJsonToolParser` discards the init line's `session_id`. `resumeResolution.ts:56` already mints a UUID that Claude never adopts. Passing it makes run records keyable at spawn.                                                                                                                                                                                                                        |
| `--include-hook-events`, `--forward-subagent-text`      | Worth evaluating for an observability runtime: the first emits hook lifecycle into stream-json, the second (v2.1.211+) emits subagent text with `parent_tool_use_id` so full subagent transcripts can be reconstructed. Both are gated on §6 version detection.                                                                                                                                                                                                                                                                                                      |
| `--effort`                                              | Genuinely absent, no workaround. But it would land at run scope like `model` does (`bootstrapConfig.ts:191-214`), so "cheap effort for mechanical steps" needs per-step config that does not exist for any flag yet.                                                                                                                                                                                                                                                                                                                                                 |
| `--exclude-dynamic-system-prompt-sections`              | **Low value — do not bother.** The tempting argument (Athena's appended handoff prompt varies per turn) is false: `HANDOFF_COMPACT_SYSTEM_PROMPT` is a constant appended identically every spawn (`spawn.ts:156-165`). The spec rationale is cross-_machine_ cache reuse; Athena's turns run on one box.                                                                                                                                                                                                                                                             |

**Version gating is the prerequisite.** `detectClaudeVersion()` exists
(`detectVersion.ts:8-23`) but both consumers use it for display only —
`verifyHarness.ts:256-269` branches on truthiness alone, so `athena verify` reports green
for any parseable version, including binaries too old for the hook protocol. `FlagDef`
(`flagRegistry.ts:24-32`) has no `minVersion`, so a constraint like `ultracode`'s v2.1.203+
is inexpressible. Latent today, blocking for `--effort` and `--forward-subagent-text`. Codex
shows the shape at `codex/system/verifyHarness.ts:36-46`; a semver comparator already exists,
mis-sited, at `dashboardCommand.ts:1855`.

---

## 7. Documentation rot

Both self-authored extraction docs make **affirmatively false claims about the current
implementation** — which is worse than being merely incomplete, because they are cited as
ground truth.

### 7.1 **ROT** — `docs/hook-signatures.md` is a net liability

Section 6 "Known Mismatches" is wrong in **4 of 6 items**. It claims `TeammateIdle` and
`TaskCompleted` are unmodelled (they are at `events.ts:244-268`, in the union at `:350,352`,
with guards), that `bypass_permissions_disabled` is missing (`events.ts:72`), that
`permission_suggestions` is untyped (`events.ts:135`), and that `Notification.title` is
absent (`events.ts:161`). Section 7's table covers 15 of 27 events. The doc is frozen at
`855dd14` (2026-02-18) while `events.ts` moved at `c7d6854` (2026-04-19). It also originated
the §1.1 wire bug.

**Recommendation: delete it.** Everything still true in it is also in
`hook-shapes-reference.md`, and nothing imports it. _(Not done as part of this audit —
deleting a checked-in doc is the maintainer's call.)_

### 7.2 **ROT** — `docs/hook-shapes-reference.md` needs regeneration, not editing

The "Missing Items / Gaps" list is stale in **10 of 19** items (and skips #17 entirely),
including three "**Completely missing** from athena-cli" claims for `InstructionsLoaded`,
`WorktreeCreate`, and `WorktreeRemove` — all three of which have a protocol type, a
`RuntimeEventKind`, a `RuntimeEventDataMap` entry, and a hook mapping. Its "canonical event
kinds" table lists 17 of 36 `RuntimeEventKind` values and hides the streaming kinds
(`message.delta`, `tool.delta`, `usage.update`) entirely.

Regenerate the gap list and kinds table from `events.ts` / `result.ts` /
`core/runtime/events.ts`. Consider an `npm run docs:check` that diffs the kinds table against
the `RuntimeEventKind` union so this cannot rot silently again.

### 7.3 **ROT** — both docs assert three things the spec now contradicts

`Setup` is called "non-public or internal"; `AskUserQuestion` is called "not documented as
hookable"; and its `answers` field is called "an athena convention, not a Claude Code
contract". All three clauses are now false — the spec documents `Setup` with `init`/`maintenance`
matchers, and documents `AskUserQuestion`'s `questions[]` + `answers{}` exactly as
`toolSchemas.ts:228-233` already models them. `events.ts:220-223` carries a milder version of
the same stale claim.

### 7.4 **ROT** — `docs/claude_code/` is an unlabelled frozen snapshot

It documents 12 of 31 hook events, is frozen at `a57114b` (2026-03-09), and carries **no
banner anywhere** saying so. Notably the _code has outrun the mirror_: `protocol/events.ts`
models `PermissionDenied`, `TeammateIdle`, `WorktreeCreate` and `ElicitationResult`, none of
which appear in `docs/claude_code/hooks.md`. A live type points at it
(`permissionSuggestion.ts:9`).

Add `> Snapshot of docs.claude.com as of 2026-03-09. Not authoritative — see
docs/claude-code-spec-drift.md.` to every file.

### 7.5 **ROT** — `CONTEXT.md` names a module that does not exist

`CONTEXT.md:237` says "task" has two senses (TodoWrite plan items, Task-tool subagents) and
mandates "never bare _task_". The protocol now carries a **third**: `TaskCreatedEvent` /
`TaskCompletedEvent` (`events.ts:251-268`, with `task_id`/`teammate_name`/`team_name`) and
runtime kinds `task.created`/`task.completed`. It has no sanctioned name, and the collision
already landed:

- `CONTEXT.md:55-57,185` names **RootPlanTracker** as a FeedMapper seam.
  `grep RootPlanTracker src/` returns zero hits. The real module is
  `core/feed/internals/taskStateTracker.ts:20,74` — named exactly what CONTEXT.md's own
  `_Avoid_` list forbids, because it absorbed the third sense.
- `CONTEXT.md:115` says the Root plan is sourced from TodoWrite or `plan.delta` and surfaced
  via `getTasks()`. `taskStateTracker.ts:76-77` keeps `rootPlanItems` _and_ `taskItems`, and
  `current()` returns a flat `TodoItem[]` with no discriminator, fed by four sources.

The code is fine and its header comment (`taskStateTracker.ts:3-18`) explains the merge.
Fix: coin **Teammate task**, extend the `:237` note to three senses, rename
**RootPlanTracker** → **TaskStateTracker** at `:55` and `:185`, and correct `:115`.

---

## Suggested order of work

1. §1.1, §1.2, §1.3 — three small patches, each fixing wrong-on-the-wire behaviour.
2. §2.1 — `async` registration derived from `interactionRules`. Largest runtime win.
3. §2.2 — explicit `timeout` on the two wait-forever handlers.
4. §3 `duration_ms` — one field, both harnesses, unlocks per-tool latency in the feed.
5. §4.1 — `message.*` from the stdout parser; closes the assistant-prose hole.
6. §7 — delete one doc, regenerate another, banner the mirror, fix `CONTEXT.md`.

Everything else is genuinely optional.

## Breaking changes to internal protocol types

§3 and §4 both widen `RuntimeEventDataMap` entries and `HookResultPayload`. These are
internal to the process boundary — not persisted in `session.db` and not part of the plugin
API — so the blast radius is the translator, the feed types, and their tests. §7.5's
**RootPlanTracker** → **TaskStateTracker** rename is documentation-only; the code already
uses the correct name.
