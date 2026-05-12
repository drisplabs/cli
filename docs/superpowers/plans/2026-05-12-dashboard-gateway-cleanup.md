# Dashboard Gateway Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove dashboard console/gateway sidecar behavior from the paired dashboard architecture.

**Architecture:** Dashboard pairing and daemon operation continue to mirror dashboard attachment metadata locally, but they no longer project runners into gateway console sidecars or reload gateway channels. `dashboard console enable|link` becomes a migration stub that returns a clear message instead of writing files.

**Tech Stack:** TypeScript, Vitest, existing dashboard command and runtime daemon modules.

---

### Task 1: Deprecate Dashboard Console Command

**Files:**

- Modify: `src/app/entry/dashboardCommand.test.ts`
- Modify: `src/app/entry/dashboardCommand.ts`

- [x] Add tests that `dashboard console link <runnerId>` and `dashboard console enable <runnerId>` return a migration message and do not write channel sidecars or reload the gateway.
- [x] Replace the console command implementation with a deprecation stub.
- [x] Remove console command details from dashboard command usage.

### Task 2: Stop Auto-Reconciling Console Sidecars

**Files:**

- Modify: `src/app/entry/dashboardCommand.test.ts`
- Modify: `src/app/entry/dashboardCommand.ts`
- Modify: `src/app/dashboard/runtimeDaemon.test.ts`
- Modify: `src/app/dashboard/runtimeDaemon.ts`

- [x] Change pair tests so pair still writes the attachment mirror but does not call sidecar reconciliation or gateway reload.
- [x] Change daemon attachment tests so `attachments.changed` updates only the mirror.
- [x] Remove the `reconcileConsoleSidecars` dependency from pair and runtime daemon.
- [x] Remove now-unused daemon test seams for channel reconciliation/reload.

### Task 3: Verify

**Files:**

- Test: `src/app/entry/dashboardCommand.test.ts`
- Test: `src/app/dashboard/runtimeDaemon.test.ts`

- [x] Run targeted tests for dashboard command and daemon.
- [x] Run `npm run typecheck`, `npm run lint`, and `npm run build`.

Note: `npm run lint` is blocked in this dirty workspace by pre-existing
formatting drift under `.agents/skills/*` and `skills-lock.json`, plus the
unstaged deletion paths before commit staging. Ran `npm run lint:eslint` and
targeted Prettier checks for the cleanup files instead.
