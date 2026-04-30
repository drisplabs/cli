# Question Channel Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relay `AskUserQuestion` / Codex `user_input` prompts through the existing channel subsystem, starting with Telegram.

**Architecture:** Add question-specific channel protocol messages and a `QuestionRelay` that mirrors the existing permission race model. `runtimeController` remains the single harness-neutral seam; `useFeed` owns mapping local/remote answers back to `runtime.sendDecision`.

**Tech Stack:** TypeScript, Vitest, Ink/React hooks, NDJSON channel subprocess protocol.

---

### Task 1: Protocol and Parser Tests

**Files:**

- Modify: `src/channels/protocol.test.ts`
- Modify: `src/channels/telegram/verdict.test.ts`

- [ ] **Step 1: Write failing protocol tests**

Add tests that `question.request`, `question.cancel`, and `question.answer` are accepted by protocol validators.

- [ ] **Step 2: Write failing Telegram parser tests**

Add tests for `answer abcde yes` and JSON answer syntax.

- [ ] **Step 3: Run red tests**

Run: `npm test -- src/channels/protocol.test.ts src/channels/telegram/verdict.test.ts --run`

Expected: tests fail because question messages are not implemented.

### Task 2: Channel Protocol Types

**Files:**

- Modify: `src/channels/types.ts`
- Modify: `src/channels/protocol.ts`
- Modify: `src/channels/telegram/verdict.ts`

- [ ] **Step 1: Add question message types**

Add `question.request`, `question.cancel`, and `question.answer` to the channel method/event unions.

- [ ] **Step 2: Validate protocol messages**

Extend `parseMethodMessage` and `parseEventMessage` with structural validation for question payloads.

- [ ] **Step 3: Add Telegram answer parser**

Parse `answer <id> <text>` and `answer <id> <json object>` into `Record<string,string>`.

- [ ] **Step 4: Run tests green**

Run: `npm test -- src/channels/protocol.test.ts src/channels/telegram/verdict.test.ts --run`

### Task 3: Question Relay and Registry

**Files:**

- Create: `src/channels/questionRelay.ts`
- Create: `src/channels/questionRelay.test.ts`
- Modify: `src/channels/registry.ts`
- Modify: `src/channels/registry.test.ts`
- Modify: `src/channels/feedEvents.ts`
- Modify: `src/core/feed/types.ts`

- [ ] **Step 1: Add failing relay tests**

Test registering questions, first-answer-wins, local-first wins, and runtime decision cleanup.

- [ ] **Step 2: Implement `QuestionRelay`**

Track pending question requests by runtime id and channel id, with claim semantics.

- [ ] **Step 3: Add registry question methods**

Add `requestQuestion(event)` and `tryClaimLocalQuestion(eventId)` plus channel `question.answer` handling.

- [ ] **Step 4: Add feed event data**

Add relayed/resolved feed event payloads for channel questions.

### Task 4: Wire Controller and Feed

**Files:**

- Modify: `src/core/controller/runtimeController.ts`
- Modify: `src/core/controller/runtimeController.test.ts`
- Modify: `src/app/providers/useFeed.ts`
- Modify: `src/app/providers/RuntimeProvider.tsx`

- [ ] **Step 1: Add controller callback**

Add `relayQuestion?: (event: RuntimeEvent) => void` and call it for `tool.pre` `AskUserQuestion` and `permission.request` `user_input`.

- [ ] **Step 2: Wire `useFeed`**

Call `channelRegistry.requestQuestion(event)` when the controller relays a question, and guard `resolveQuestion` through `tryClaimLocalQuestion`.

- [ ] **Step 3: Instantiate relay**

Create `QuestionRelay` alongside `PermissionRelay` in `RuntimeProvider`.

### Task 5: Telegram Question Support

**Files:**

- Modify: `src/channels/telegram/index.ts`

- [ ] **Step 1: Send question prompts**

On `question.request`, send the question text and reply syntax to Telegram.

- [ ] **Step 2: Accept answers**

On inbound `answer <id> ...`, emit `question.answer`.

- [ ] **Step 3: Cancel messages**

On `question.cancel`, edit the Telegram prompt to resolved text.

### Task 6: Verification

**Files:**

- N/A

- [ ] **Step 1: Focused tests**

Run: `npm test -- src/channels/protocol.test.ts src/channels/telegram/verdict.test.ts src/channels/questionRelay.test.ts src/channels/registry.test.ts src/core/controller/runtimeController.test.ts --run`

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

- [ ] **Step 3: Build**

Run: `npm run build`
