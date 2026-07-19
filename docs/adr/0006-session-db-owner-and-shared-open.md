# ADR 0006 - One owner for session.db, a shared versioned-open primitive, and dead-table removal

Status: Active
Date: 2026-07-19

## Context

Persistence in the CLI is opened and evolved by several modules that each re-invent the same
mechanics, and `session.db` in particular was read by three different modules that each embedded
their own SQL:

1. **Three SQL surfaces over `session.db`.** `SessionStore` (`src/infra/sessions/store.ts`) is the
   writer, but `registry.ts` and `hookAudit.ts` each opened the same `session.db` file with their own
   read-only connections and their own `SELECT`s — including their own knowledge of table/column names
   and payload JSON paths (`json_extract(payload, '$.data.prompt')`, the `feed_events.data` shape, the
   `runtime_events` grouping). Three independent SQL surfaces over one file means a schema tweak has to
   be chased through three modules.

2. **Four databases re-inventing "open and migrate."** `session.db`, the gateway state DB
   (`src/gateway/state/db.ts`), the dashboard decision inbox
   (`src/app/dashboard/dashboardDecisionInbox.ts`), and the dashboard feed outbox
   (`src/app/dashboard/dashboardFeedPublisher.ts`) each hand-rolled: ensure parent directory, open the
   connection, set `journal_mode = WAL`, and run a schema-init/migration function. The two versioned
   DBs (`session.db`, gateway state) additionally duplicated the identical `schema_version` guard
   ("read version; throw if newer; insert on fresh; migrate-and-bump otherwise").

3. **Two never-written tables in `session.db`.** `channel_messages` and
   `gateway_function_invocations` were added in the v6 migration but have zero production
   readers/writers — only `schema.migration.test.ts` touched them. Their DDL is carried in both the
   base schema and the v5 → v6 migration for no runtime purpose.

**Hard constraint (ADR 0003).** `session.db` uses hand-rolled, version-gated migrations applied on
open over live `~/.config/athena/sessions/*/session.db` files. Every persisted identifier — table
names, column names (`session_id`, `run_id`, `workflow_runs`, …), and payload JSON keys — must be
preserved. This work is access-seam consolidation plus dead-table removal only; no persisted
identifier is renamed, and the on-disk schema-version semantics (`SCHEMA_VERSION = 6`, the v2→…→v6
upgrade chain) are unchanged.

## Decision

**1. One private SQL surface for `session.db` reads.** Introduce `sessionDbReader.ts`
(`openSessionDbReadonly(dbPath, {fileMustExist?})` → `SessionDbReader`) as the single read-only SQL
surface over `session.db`. `registry.ts` and `hookAudit.ts` route their reads through it instead of
opening their own connections and writing their own `SELECT`s. The queries are moved verbatim, so the
routed reads are byte-identical in columns, filters, ordering, and JSON paths. `SessionStore` remains
the writer surface (it holds an exclusive lock on a live session, so it keeps its own connection); the
reader and the store are the two faces of the same owner, and no third module carries `session.db`
SQL any more.

**2. A shared `openVersionedDb` primitive.** Introduce `src/infra/db/openVersionedDb.ts`:

- `openVersionedDb(dbPath, {version?, migrate, onNewerVersion?, foreignKeys?, ensureDir?, dirMode?})`
  ensures the parent directory, opens the connection, sets WAL (and optionally foreign keys), then
  runs the versioned guard/migration. When `version` is omitted it is a versionless open (no
  `schema_version` table), invoking `migrate` once.
- `migrateVersionedSchema(db, {version, migrate, onNewerVersion?})` owns the `schema_version` dance —
  ensure the table, reject a newer on-disk version, run `migrate(db, fromVersion)`, and stamp the
  version for a fresh database. `initSchema` (session) is re-expressed in terms of it so the guard has
  a single implementation shared with `openVersionedDb`.

Adopters:

- **`session.db`** (`store.ts`) and the **gateway state DB** (`state/db.ts`) use the full versioned
  form; their schema-specific DDL/upgrades live in `migrate` callbacks (`applySessionSchema`,
  `migrateGatewayState`). Exact `onNewerVersion` messages are preserved.
- The two **dashboard DBs** are **versionless** — they have no `schema_version` table and the inbox
  already migrates via index inspection, not a version integer. They adopt the same primitive in its
  versionless mode (mechanical open + WAL, keeping their own `migrate` bodies). They are deliberately
  **not** given a `schema_version` table: that would be an untested on-disk format change for no
  benefit.

**3. Drop the two dead tables.** Remove the DDL for `channel_messages` and
`gateway_function_invocations` from both the base schema and the v5 → v6 migration (and their
indexes). This is DDL removal for never-written tables, not a data migration: fresh databases simply
never create them, and databases already at v6 keep the (empty) tables harmlessly. `SCHEMA_VERSION`
stays `6`; the upgrade chain is otherwise untouched.

## Consequences

Positive:

- `session.db` has one read surface and one write surface, both owned by `src/infra/sessions`; the
  registry and hook-audit become pure consumers with no embedded SQL.
- The "open and migrate" idiom lives in one primitive; the `schema_version` guard has a single
  implementation instead of two copies.
- Two tables of dead DDL leave the schema, shrinking the surface a reader must reason about.

Negative / costs:

- One more indirection (`SessionDbReader`) between the registry/audit and SQLite.
- The dashboard DBs share only the mechanical (versionless) path, so the primitive has both a
  versioned and a versionless mode rather than a single shape.
- Existing v6 databases retain the two empty tables; the removal is forward-only (no `DROP`).

## Verification note

The sqlite-backed vitest suites (`src/infra/sessions/**`, `src/gateway/state/**`, the two dashboard
suites) cannot load `better-sqlite3` under the repo's default Node (v24: the prebuilt native addon is
`NODE_MODULE_VERSION` 115). They were run under the ABI-matching Node 20 runtime, where all suites
pass, alongside a standalone node driver exercising every session/gateway migration path (fresh,
v2→6, v3→6, v4→6, v5→6, idempotent re-open, newer-version and pre-release rejection) and the
production `openVersionedDb` path. CI runs the same suites.

## References

- ADR 0003 - Execution-unit terminology (persisted identifiers must not be renamed)
- `src/infra/db/openVersionedDb.ts` - the shared open/guard primitive
- `src/infra/sessions/sessionDbReader.ts` - the single read-only SQL surface over `session.db`
- `src/infra/sessions/schema.ts` - `SESSION_SCHEMA`, `applySessionSchema`, `initSchema`
- `src/gateway/state/db.ts` - `migrateGatewayState`, `openGatewayState`
