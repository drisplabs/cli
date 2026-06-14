## Problem Statement

In split mode the terminal UI gives the **feed** (the right-hand table of `FeedEvent` rows: `gutter · TIME · ACTOR · ACTION · DETAILS · RESULT`) an even 50/50 share of the width with the agent message panel. In practice the user mostly reads the agent's narration on the left and only glances at the feed, yet the feed eats half the screen. Two of its columns earn little of that space:

- **ACTOR** is a fixed 10-wide column that, thanks to `duplicateActor` collapsing, renders as `·` on nearly every row in a single-**Actor** run. Its only real payload — attributing a row to a specific subagent — is rare.
- **RESULT** is a wide, data-driven column whose error case (red text) is the only part that reliably draws the eye, while the column's width is paid on every row.

The error signal is also weakly placed: only the RESULT cell turns red, so a failure is easy to miss in a fast-scrolling feed.

## Solution

Slim the feed so the message panel gets the room it deserves, and make errors impossible to miss:

1. **Widen messages**: shift the split so messages take ~65% and the feed ~35%.
2. **Drop the ACTOR column** entirely. Per-row actor attribution will return later as an actor-scoped feed switcher (see Out of Scope) — until then a subagent's work is bracketed by its `sub.start`/`sub.stop` rows.
3. **Drop the RESULT column**, but **fold its non-error outcomes inline** into DETAILS (right-aligned) so counts (`13 files`), diffs (`+5 −2`), exit codes (`exit 0`), and the yellow zero-result tint all survive.
4. **Relocate the error signal**: an errored row turns its gutter, TIME, and DETAILS (including the now-inline error message) red, while the ACTION pill keeps its tool-category color so you can still tell a failed `Read` from a failed `Bash`.

The freed ACTOR + RESULT width (~30–60 columns) flows into the flex DETAILS column, so the feed stays readable even though its panel is narrower.

## User Stories

1. As a user watching a run, I want the agent's message narration to occupy most of the width, so that I can read the agent's reasoning without it wrapping awkwardly.
2. As a user, I want the feed to remain a readable side rail at ~35% width, so that I can still glance at tool activity while focusing on the narration.
3. As a user of a single-Actor run, I want the all-`·` ACTOR column gone, so that the feed isn't wasting 10 columns on dots.
4. As a user, I want DETAILS to be wider now that ACTOR and RESULT are gone, so that file paths and tool arguments truncate less often.
5. As a user, I want tool outcomes like `13 files`, `exit 0`, and `+5 −2` to still appear (now inline at the end of DETAILS), so that I don't lose the result of an action when the RESULT column is removed.
6. As a user, I want a zero-result outcome (`0 matches`) to still show its warning tint, so that "ran but found nothing" stays visually distinct from a normal result.
7. As a user scanning quickly, I want an errored row to be red across its gutter, time, and details, so that failures jump out instead of hiding in a single far-right cell.
8. As a user, I want the error message text itself (e.g. `File does not exist`) to appear inline in DETAILS and be red, so that I can read what went wrong without expanding the row.
9. As a user, I want the ACTION pill on an errored row to keep its category color, so that I can still identify which tool failed at a glance.
10. As a user hovering/focusing an errored row, I want the existing focus highlight to take over, so that focus stays visually consistent with every other row (the inline error text still tells me it failed).
11. As a user, I want the feed header to read `TIME · ACTION · DETAILS`, so that the column labels match the slimmed layout.
12. As a user running subagents, I want a subagent's actions to remain bracketed by its `sub.start`/`sub.stop` rows, so that I can still infer which rows belong to a subagent even without the ACTOR column.
13. As a maintainer, I want the column-width math to keep stabilizing monotonically as new rows stream in, so that the feed doesn't visually jitter when widths recompute.
14. As a maintainer, I want the incremental and ink-full render paths to produce the same slimmed layout, so that the two backends stay consistent.
15. As a maintainer, I want `formatActor` and `formatResult` removed once unused, so that dead code doesn't linger and trip `knip`.
16. As a user on a narrow terminal, I want DETAILS to degrade gracefully (inline outcome truncates before the segments) so the row never overflows its panel width.

## Implementation Decisions

**Modules built/modified**

- **Feed column model** (`computeFeedColumns` / `stabilizeFeedColumns` in `useFeedColumns.ts`): a pure width-allocation module.
  - Drop `ACTOR_W` from `BASE_FIXED` (now gutter + time + suffix only).
  - `GAP_COUNT` `3 → 2` (gaps are now time|action and action|details).
  - Remove `resultW`, `detailsResultGapW` (and the `maxResultLen` / `resultMaxW` inputs) from the `FeedColumns` type, the computation, the stabilizer, and the equality check.
  - DETAILS remains the single flex column and absorbs all freed width.
- **Cell formatters** (`cellFormatters.ts`): pure string functions.
  - `formatDetails` gains an `error?: boolean` flag threaded into `renderSegments` / `renderOutcome`, tinting both the segments and the right-aligned outcome with `theme.status.error` when set.
  - Non-error outcomes are folded in by having the row pass `outcome`/`outcomeZero` into `formatDetails` (the function already supports right-aligned outcome layout); the zero-result case keeps `theme.status.warning`.
  - `formatActor` and `formatResult` are deleted (only `FeedRow` consumed them).
- **Line composition** (`formatFeedRowLine` in `FeedRow.tsx`, `formatFeedHeaderLine` in `FeedHeader.tsx` — the canonical string path used by `feedSurfaceModel` and `FeedScrollback`, plus the parallel ink `FeedRowImpl`/`FeedHeaderImpl`):
  - Remove the actor and result cells/boxes from both the string assembly and the JSX path.
  - Header becomes `TIME · ACTION · DETAILS`.
  - On `entry.error`, apply a red override to the gutter and time, and pass `error: true` into `formatDetails`; the ACTION pill is left untouched.
  - When the row is focused, the existing focus override (bright text on focus background) takes precedence over the error red.
  - Drop `resultW` / `detailsResultGapW` from the `FeedColumnWidths` type and from `buildLineCacheKey`.
- **Layout ratio** (`useLayout.ts`): `MESSAGE_PANEL_RATIO` `0.5 → 0.65`. Split behavior is otherwise unchanged and still only engages when `splitMode` (there are messages).

**Domain & docs**

- No change to `CONTEXT.md`: the **Actor** domain concept is unchanged — only its per-row _display_ is removed. Feed columns were never glossary terms.
- No ADR: all four changes are reversible and low-architectural-weight. The actor-scoping direction is recorded as future work but is too undesigned to warrant an ADR yet.

## Testing Decisions

Good tests here assert **external behavior** of pure functions — given inputs (entries, widths, error flag), assert the produced column widths and rendered line strings (via `strip-ansi` for layout assertions and color-code assertions for tinting) — never internal call order or private state. All three modules are pure and have existing prior art.

- **Feed column model** (prior art: `useFeedColumns.test.ts`): DETAILS absorbs the width freed by dropping ACTOR + RESULT; the `FeedColumns` result no longer carries `resultW`/`detailsResultGapW`; `GAP_COUNT` reflects 2 gaps; `stabilizeFeedColumns` stays monotonic (widths never shrink mid-stream) and returns the previous object when equal.
- **Cell formatters** (prior art: `cellFormatters.test.ts`): `formatDetails` folds a non-error outcome right-aligned inside the content width; a zero-result outcome keeps the warning tint; with `error: true`, segments and outcome are tinted with the error color; the inline outcome truncates before the segments on a narrow width.
- **Line composition** (prior art: `cellFormatters.test.ts` / feed-surface string tests): `formatFeedHeaderLine` emits `TIME · ACTION · DETAILS` with no ACTOR/RESULT labels; `formatFeedRowLine` omits the actor and result cells; an errored row reds the gutter + time + details but leaves the ACTION pill's category color intact; a focused errored row uses the focus styling.

## Out of Scope

- **Actor-scoped feed switcher**: the planned feature that scopes the feed to one **Actor** at a time and lets the user cycle between per-agent feeds. This is the long-term home for actor attribution and the justification for dropping the ACTOR column now — but it is a separate piece of work, not part of this PRD.
- Any change to the message panel's own rendering, tabs, or content.
- Any change to the expanded/detail row view (`PostToolResult`) or to how outcomes are computed upstream in the `FeedMapper` — only their _presentation_ in the collapsed feed row changes.
- Theme palette changes; this reuses existing `theme.status.error` / `theme.status.warning`.

## Further Notes

- The split (`MESSAGE_PANEL_RATIO`) is a one-line constant; 0.65 is a starting point the user can fine-tune live.
- The two render paths must stay in lockstep — `feedSurfaceModel` builds every line through `formatFeedRowLine` + `formatFeedHeaderLine`, so that string path is canonical; the ink `FeedRowImpl`/`FeedHeaderImpl` must be updated to match (or verified unused).
- Tests touched by the removed columns to reconcile: `useFeedColumns.test.ts`, `cellFormatters.test.ts`, `feedSurfaceModel.test.ts`, `FeedGrid.test.ts` / `__tests__/FeedGrid.test.tsx`. Matches in `toolExtractors.test.ts` / workflow tests appear incidental — verify, likely no change.
- A short memory note (`project_subagent_feed_switcher.md`) records the switcher as the reason ACTOR is removed.
