# New Hook Events Spike Report (#116)

De-risking report for four Claude Code hook events that athena does not yet type:
`UserPromptExpansion`, `PostToolBatch`, `Elicitation`, `ElicitationResult`.

Every shape below was **captured from a real Claude Code process**, not read from
documentation. Captured against **Claude Code 2.1.215** on macOS.

Fixtures: `src/harnesses/claude/protocol/__fixtures__/hook-payloads/`
Guard test: `src/harnesses/claude/protocol/__tests__/hookPayloadFixtures.test.ts`

Related: [Hook Shapes Reference](./hook-shapes-reference.md) · downstream slices #118
(`UserPromptExpansion`), #119 (`PostToolBatch`), #120 (`Elicitation*`).

---

## How the payloads were captured

Fully programmatic — no interactive session, no human at the keyboard:

1. A capture hook reads the raw payload from stdin, writes it verbatim to
   `<hrtime_ns>-<event>.json`, appends the receipt order to `order.log`, prints
   nothing (so it stays transparent to Claude's own hook decision) and exits `0`.
2. A settings file registers that one command for all twelve events of interest.
3. Claude is driven headlessly:

   ```
   claude -p "<prompt>" --settings <capture-settings.json> \
     --setting-sources 'project' --dangerously-skip-permissions
   ```

`Elicitation` needs a counterparty, so the spike also used a ~130-line stdio MCP
server whose single tool issues an `elicitation/create` request back to the client.

Reproduction gotchas worth knowing:

- The hook `command` must use an **absolute** interpreter path, and the capture
  script must write to an **absolute** output directory — hooks inherit Claude's cwd.
- `--setting-sources ''` suppresses project slash-command discovery, which silently
  prevents `UserPromptExpansion` from ever firing. Use `'project'`.
- macOS ships neither `timeout` nor `gtimeout`.

---

## `UserPromptExpansion` (#118)

```jsonc
{
	"session_id": "…",
	"transcript_path": "…",
	"cwd": "…",
	"prompt_id": "…",
	"permission_mode": "bypassPermissions",
	"hook_event_name": "UserPromptExpansion",
	"expansion_type": "slash_command",
	"command_name": "greet",
	"command_args": "",
	"command_source": "projectSettings",
	"prompt": "/greet",
}
```

- `expansion_type` is **`slash_command | mcp_prompt` only**. `@file` mentions do
  **not** trigger this event — an easy wrong assumption to build on.
- Trigger requires a real command file (`.claude/commands/<name>.md`) plus
  `--setting-sources 'project'`.
- **Ordering:** fires ~32 ms **before** `UserPromptSubmit`, sharing the same
  `prompt_id`. Both carried the _unexpanded_ prompt (`"/greet"`) in this capture.
- Carries no `effort` field.

## `PostToolBatch` (#119)

```jsonc
{
  "session_id": "…", "transcript_path": "…", "cwd": "…",
  "prompt_id": "…", "permission_mode": "…", "effort": { "level": "high" },
  "hook_event_name": "PostToolBatch",
  "tool_calls": [
    { "tool_name": "Read", "tool_input": {…}, "tool_use_id": "toolu_…", "tool_response": "1\thello capture\n2\t" }
  ]
}
```

- 🔴 **`tool_calls[].tool_response` is a `string`** — the flattened, model-facing
  rendering — whereas `PostToolUse.tool_response` is a structured **object**.
  Proven against the same tool call: for one `tool_use_id`, `PostToolUse` gave
  `{"type":"text","file":{filePath,content,numLines,…}}` while `PostToolBatch`
  gave `"1\thello capture\n2\t"`. **A translator must not assume the two fields
  share a type.** Both fixtures are checked in, so this stays provable.
- Fires **exactly once per assistant tool batch**, ~28 ms after the last
  `PostToolUse` of that batch. Confirmed with a three-way parallel `Read`: three
  `PreToolUse`/`PostToolUse` pairs, then a single `PostToolBatch` carrying all
  three entries in issue order, each `tool_use_id` correlating 1:1.
- Official contract (recovered from the binary's embedded schema docs): _"Fired
  once after every tool call in a batch has resolved, before the next model
  request. PostToolUse fires per-tool and **may run concurrently for parallel tool
  calls**; PostToolBatch fires exactly once with the full batch."_

## `Elicitation` / `ElicitationResult` (#120)

```jsonc
// Elicitation
{
  "session_id": "…", "transcript_path": "…", "cwd": "…", "prompt_id": "…",
  "hook_event_name": "Elicitation",
  "mcp_server_name": "elicitstub",
  "message": "What is your favourite colour?",
  "mode": "form",
  "requested_schema": { "type": "object", "properties": {…}, "required": [...] }
}

// ElicitationResult (cancel path — note: no `content` key at all)
{
  "…common…": "…",
  "hook_event_name": "ElicitationResult",
  "mcp_server_name": "elicitstub",
  "mode": "form",
  "action": "cancel"
}
```

- ✅ **The server-name field is `mcp_server_name`** — neither of the two candidates
  the issue posed (`mcp_server`, `server_name`). Present on both events.
- 🔴 **The existing types in `src/harnesses/claude/protocol/events.ts` are wrong.**
  They were written speculatively and declare `mcp_server` (reality:
  `mcp_server_name`) and `form: {fields: ElicitationFormField[]}` (reality:
  `message` + `mode` + `requested_schema`). #120 must correct both; there is no
  `form` object and no `fields` array in the real payload.
- `Elicitation` carries **no `permission_mode` and no `effort`**.
- A `Notification` follows the result with
  `notification_type: "elicitation_response"` and
  `message: 'Elicitation response for server "elicitstub": cancel'`. Note that
  [hook-shapes-reference.md](./hook-shapes-reference.md) currently lists only
  `elicitation_dialog` for that enum — `elicitation_response` is a new value.
- **Headless always cancels** (there is no interactive dialog), so `cancel` is the
  default-path capture. The **accept** payload was confirmed at the transport
  layer instead, from the stub server's log of the client's JSON-RPC reply:
  `{"result":{"action":"accept","content":{"colour":"blue"}}}` versus the cancel
  path's `{"result":{"action":"cancel"}}`. So modelling `content` as
  `Record<string, unknown>` **present only on `accept`** is correct.
- 🔴 **The two events are not a guaranteed pair.** A hook that returns
  `{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"accept","content":{…}}}`
  auto-responds _instead of_ showing the dialog, and `ElicitationResult` (and the
  trailing `Notification`) then **never fire at all** — verified by a run that
  produced `Elicitation` with no result event, while the model still received the
  accepted content. athena's forwarder prints nothing, so athena will always see
  both today; #120 must nonetheless not model the result as guaranteed.
- The client advertises `"elicitation": {}` in its MCP `initialize` capabilities;
  that is what lets a server elicit at all.

---

## Unknown-hook-key tolerance (AC3)

An isolated settings file registered a bogus event name (`TotallyFakeEventXyz`), an
unknown config key, an unknown per-hook field, and a `matcher` on a non-tool event.

**Result: everything unknown was silently ignored and every real hook still fired.**
Clean exit, correct answer, nothing rejected.

🔴 **There is no diagnostic — not even under `--debug`.** Consequences:

- ✅ athena can safely register the four new events unconditionally; older Claude
  builds that don't know them will ignore them rather than erroring.
- ⚠️ Registering a hook is therefore **not a feature-detection channel**. Support
  must be inferred from the Claude version, or from whether the event is ever
  actually received.

## Dispatch ordering vs receipt-ordered `seq` (AC4)

Measured from `hrtime` deltas across five capture runs:

- Consecutive hooks are separated by a consistent **~27–42 ms** (subprocess spawn
  cost) and **never overlapped** — including the three-way _parallel_ `Read`, which
  still produced strictly serialized `Pre→Post, Pre→Post, Pre→Post`.
- `PostToolBatch` always arrives **last**, after every `PostToolUse` in its batch.
- ⚠️ The contract nonetheless permits concurrency ("PostToolUse … may run
  concurrently for parallel tool calls"). FeedMapper's receipt-ordered `seq` should
  rely on the **batch boundary** as the guarantee, not on per-tool ordering.
- 🔴 `Elicitation` / `ElicitationResult` / `Notification` arrive **nested inside a
  tool call** — between that tool's `PreToolUse` and `PostToolUse`, not between
  calls. The feed must tolerate events landing mid-tool-call.

Observed receipt order for the MCP elicitation run:

```
SessionStart → UserPromptSubmit
  → PreToolUse → PostToolUse → PostToolBatch
  → PreToolUse(mcp) → Elicitation → ElicitationResult → Notification → PostToolUse → PostToolBatch
  → Stop → SessionEnd
```

---

## Incidental findings

Worth checking before the in-flight mapping slices merge — in **every** capture run
(all `source: "startup"`), `SessionStart` carried **no `effort`, no `model`, and no
`session_title`**. Those three fields are mapped from `SessionStart` by slices #113,
#115 and #112 respectively. This may be source-dependent (`startup` vs
`resume`/`compact`/`maintenance`), but it should be confirmed rather than assumed.

Other fields observed but not currently mapped: `PostToolUse.duration_ms`,
`Stop.background_tasks[]`, `Stop.session_crons[]`, `SessionEnd.reason`.

`prompt_id` is present on **every** payload, including `SessionStart`, `Stop` and
`SessionEnd` — which confirms the central-read-in-mapper design from #111.
