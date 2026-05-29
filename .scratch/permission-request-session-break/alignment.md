# Alignment

## Scale

Light.

## Goal

Fix the session/UI break around Codex permission requests by preserving the tool/item correlation on Codex approval server requests.

Observed in the linked session database:

- `tool.pre` seq 70: `fileChange` item `call_eaoSmTPO2GE3XvpoRCxro0tL`.
- `permission.request` seq 72: Edit approval request appears while waiting.
- `permission.decision` seq 73 and `server.request.resolved` seq 74 show the request was accepted.
- The `permission.request` projection has no `tool_use_id`, so UI/feed correlation cannot attach it to the waiting tool item.

## Scope

- `src/harnesses/codex/runtime/eventTranslator.ts`
- `src/harnesses/codex/runtime/__tests__/eventTranslator.test.ts`
- Potentially adjacent Codex runtime approval tests if the first test exposes a deeper response issue.

## Non-Goals

- No changes to permission policy semantics.
- No changes to dashboard session storage schema.
- No changes to Claude harness permissions.

## Verification

- Add a regression test for Codex `item/fileChange/requestApproval` preserving `itemId` as `toolUseId`.
- Check command approval correlation if the protocol provides `itemId`.
- Run focused Vitest tests for Codex event translation and decision mapping.

## QA Mode

Skip browser QA. This is a runtime event translation/correlation fix covered at the protocol mapping seam; no local browser route is required to validate it.

## Domain Updates

`CONTEXT.md` and ADRs unchanged. Existing terms are sufficient: **RuntimeEvent**, **FeedEvent**, **RuntimeDecision**, and **DecisionCorrelation**.
