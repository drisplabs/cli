# Feed Co-Occurrence Reference

Companion to [`feed-model-reference.md`](./feed-model-reference.md). That doc tells you which fields on each `FeedEvent` kind are required vs optional. **This doc tells you which optional fields travel together** — i.e., when you see one, which others you can rely on being there (and which you can rely on being absent).

The shared feed schema is a superset across harnesses, so most fields are optional at the type level. In practice the harnesses emit them in tight bundles. Knowing those bundles makes UI code, fixtures, and tests easier to write — you don't have to defensively guard every key independently.

Citations point at the source of the rule (`mapper.ts`, `eventTranslator.ts`).

---

## 1. The Codex `thread_id` + `turn_id` cluster

By far the most common co-occurrence pattern. **From Codex, `thread_id` and `turn_id` ride along on most events that originate inside a turn.** When the underlying Codex notification carries both, the translator/mapper passes them through together. **Claude never emits either** — these fields are a reliable harness signal.

```
From Codex:  thread_id and turn_id present  (almost always together)
From Claude: neither present  (always)
```

Kinds where this applies:

- `plan.update` — `eventTranslator.ts:397-398` and `:411-412`
- `reasoning.summary` — Codex only
- `usage.update` — `eventTranslator.ts:670-674`. `usage` and `delta` (token counts) also typically co-occur — both come from the same `tokenUsage` calculation.
- `tool.delta` — `eventTranslator.ts:439-450` (Bash output deltas)
- `compact.pre` — Codex only carries thread/turn ids
- `runtime.error` — `mapper.ts:1244-1245`
- `turn.diff` — `mapper.ts:1275-1276`
- `thread.status` — `thread_id` only (no turn — it's a thread-level event)

**Practical rule:** if you're consuming any of these kinds and you see `thread_id`, you're looking at a Codex-originated event. Treat the absence of both as the Claude path.

> Caveat: at the type level each is independently optional, and the mapper passes them through with `readString(...)`. So if a malformed Codex payload omits one, the other can still appear. Don't _assert_ both — just expect them in normal operation.

---

## 2. Discriminator-coupled kinds

These kinds carry a discriminator that determines the rest of the shape. Treat them like tagged unions even though the type isn't always declared as one.

### `permission.decision` — fully tagged union

This one **is** a discriminated union in `types.ts:205-219`. `decision_type` controls which fields are even legal:

```
decision_type: 'allow'      → updated_input?, updated_permissions?, reason?
decision_type: 'deny'       → message (required!), interrupt?, reason?
decision_type: 'ask'        → reason?
decision_type: 'no_opinion' → reason?
```

Only `'deny'` has a required field beyond the discriminator (`message`). Don't try to read `updated_input` on a `deny` decision — TypeScript will reject it.

### `stop.decision` — same pattern

```
decision_type: 'block'      → reason (required)
decision_type: 'allow'      → reason?
decision_type: 'no_opinion' → reason?
```

Source: `types.ts:226-229`.

### `web.search` — phase-coupled

`web.search` is mapper-synthesized from `tool.pre` / `tool.post` for both harnesses (`mapper.ts:885-997`). The phase determines which fields are populated:

```
phase: 'started'    → query?    (read from tool_input.query)
                      message describes "Searching web for ..."

phase: 'completed'  → action_type?, url?, pattern?, queries?, query?
                      message varies by action_type:
                        'openPage'    uses url
                        'findInPage'  uses pattern + url
                        'search'      uses queries[] or query
```

`item_id` (the tool_use_id) bridges the two phases — pair them with that.

### `compact.pre` — trigger-coupled

```
trigger: 'manual'  → custom_instructions?  (Claude path; user-provided text)
trigger: 'auto'    → no custom_instructions (Codex auto-compaction)
```

### `review.status` and `context.compaction` — phase-coupled

Both have `phase: 'started' | 'completed'`. The phase comes from the suffix of the Codex notification type (`mapper.ts:1187-1189` and `:1226-1228`). For `review.status`, `review` is read off the item payload and only typically present on `'completed'`.

---

## 3. Harness-exclusive bundles

Fields that only appear from one harness. Useful as a harness-detection signal.

### `permission.request`

Two mutually-exclusive optional bundles depending on origin:

```
From Claude:  permission_suggestions?: PermissionSuggestion[]
              (each suggestion: { type, destination } — both required;
               see src/shared/types/permissionSuggestion.ts)

From Codex:   network_context?: { host?, protocol? }
              (host and protocol travel together for network approval prompts)
```

You will never see both on the same event. `tool_name` and `tool_input` are always present from either harness.

### `subagent.start` / `subagent.stop`

Codex emits a thread-coordination bundle that Claude never does:

```
From Codex (subagent.start/stop):
  sender_thread_id, receiver_thread_id, new_thread_id  → typically all-or-none
  agent_status  → Codex only

From Claude (subagent.stop):
  agent_transcript_path?, last_assistant_message?  → Claude only
```

`agent_id` and `agent_type` are required on both kinds from both harnesses. `subagent.stop` additionally requires `stop_hook_active` (always `false` when synthesized on the Codex path).

### Claude-only kinds

These have no Codex emission path at all, so seeing them tells you the harness:

- `permission.denied`, `stop.failure`
- `compact.post` (Claude has both pre and post; Codex only emits pre)
- `task.created`, `task.completed`, `teammate.idle`
- `config.change`, `cwd.changed`, `file.changed`, `setup`
- `elicitation.request`, `elicitation.result`

### Codex-only kinds

- `plan.update`, `reasoning.summary`, `usage.update`
- `runtime.error`, `thread.status`, `turn.diff`
- `review.status`, `image.view`, `context.compaction`
- `mcp.progress`, `terminal.input`, `skills.changed`, `skills.loaded`
- `server.request.resolved`

---

## 4. Mapper-synthesized kinds — what's guaranteed

When the mapper synthesizes an event (rather than a translator emitting it), the shape is tighter than the type suggests. The synthesis sites set fields together.

### `user.prompt` synthesized from Codex `turn.start`

```
Guaranteed: prompt, cwd
Never:      permission_mode  (Claude-only; comes from UserPromptSubmit hook)
```

Source: `mapper.ts:647`.

### `stop.request` synthesized from Codex `turn.complete`

```
Guaranteed: stop_hook_active = false   (always literal false)
Optional:   last_assistant_message?    (from turn complete payload)
```

Source: `mapper.ts:682`.

### `tool.delta` parent linkage

```
If tool_use_id is present  →  a prior tool.pre with the same id exists in the same run
```

The mapper maintains `toolPreIndex` keyed by `tool_use_id` (`mapper.ts:842, 857`). Use it to reconstruct parent/child timelines without re-deriving the relationship.

### `web.search` is fully synthesized

`web.search` is not emitted by either translator — the mapper produces both `started` and `completed` events from the surrounding `tool.pre`/`tool.post` whenever `tool_name === 'WebSearch'`. Both events share the same `item_id` (= `tool_use_id`), and the `phase: 'completed'` event is emitted as a child of the `tool.post` (`mapper.ts:993-995`).

---

## 5. Sub-bundles inside fields

A few nested objects have their own all-or-none semantics:

- `permission.request.network_context` — `{ host?, protocol? }`. Both are typed optional but in practice the Codex translator populates them together for network approval prompts (`eventTranslator.ts:1413-1421`).
- `PermissionSuggestion` items inside `permission.request.permission_suggestions[]` — each item carries `{ type, destination }` as required fields (`src/shared/types/permissionSuggestion.ts`). If the array is present it's never empty in practice.
- `server.request.resolved` — `{ request_id?, resolved_kind? }`. `resolved_kind` is only populated when the mapper finds a matching parent event in `resolvedRequestById` (`mapper.ts:1287-1289`). So: `resolved_kind` present ⇒ `request_id` was present. The reverse is not guaranteed.

---

## TL;DR: rules of thumb

1. **`thread_id` present ⇒ Codex.** Same for `turn_id` (except on thread-scoped events).
2. **`permission_suggestions` present ⇒ Claude.** **`network_context` present ⇒ Codex.** Never both.
3. **Treat `permission.decision` and `stop.decision` as discriminated unions** — read `decision_type` first.
4. **`web.search` always comes in pairs** (`started` + `completed`) sharing `item_id`.
5. **Synthesized events have tighter guarantees than the type says** — check the mapper site if you're unsure.
