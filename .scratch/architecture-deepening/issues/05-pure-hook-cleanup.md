# Move pure derivations out of `src/ui/hooks/`

Status: ready-for-human

## Files

- `src/ui/hooks/useAppMode.ts` (~24 LOC, confirmed pure)
- Likely siblings in `src/ui/hooks/` — CLAUDE.md says ~30 hooks; expect 4-8 to be pure derivations

## Problem

Files named `useX` imply React hooks (state, effects, refs). Pure if-else / derivation functions exported as `useX` for testability are fiction. The directory name lies: scanning `src/ui/hooks/` to understand "what UI state exists" includes pure functions that hold no state. Locality of "what is React state?" is broken.

## Sketch of deepening

1. Audit all of `src/ui/hooks/` — identify any file with no `useState`, `useEffect`, `useReducer`, `useRef`, `useContext`, or hook composition.
2. Move pure derivations to `src/ui/utils/` (or `shared/utils/` if not React-flavoured) as named functions. Drop the `use` prefix.
3. Reserve `src/ui/hooks/` for actual hooks.

Each move is a small mechanical refactor: rename, change import path at call sites, drop the unused dependency-array tracking if any.

## Why this deepens

- Per-file leverage is small, but cumulative locality benefit when scanning the UI layer is meaningful.
- Removes a category of "is this a hook or just a function?" mental overhead.

## Open design questions

- Is `useAppMode` really called from a single component? If so, inline rather than extract.
- Do any "pure" hooks actually use `useMemo` for memoization purposes? Those legitimately stay hooks.

## Effort

Low per file. Total effort scales with how many of the 30 hooks turn out to be pure.

## Risk

Very low — name + path changes only.
