# Replace structural reducer with semantic SessionUiController

Status: ready-for-human

## Files

- `src/app/shell/sessionUiState.ts` (~666 LOC, ~25-arm `SessionUiAction` discriminated union)
- All callers in `src/app/shell/` and `src/ui/` that `dispatch({type: ...})`

## Problem

Public interface today is `{state, dispatch}` over a wide action union. Callers must learn the action shapes; tests poke the reducer with raw `{type: 'TOGGLE_TODO_PANEL'}` payloads. The interface is nearly as wide as the implementation — shallow.

## Sketch of deepening

A `SessionUiController` whose interface is semantic verbs:

- `scrollFeedUp()` / `scrollFeedDown()`
- `toggleTodoPanel()`
- `setInputMode(mode)`
- `focusMessage(id)` / `clearFocus()`
- …etc, one method per action variant the UI legitimately needs

Reducer + action types become private. `useReducer` stays internally.

## Why this deepens

- Interface shrinks (verbs replace 25 action constants).
- Test surface flips from "did action X mutate slice Y?" to "did intent Z produce the right user-visible state?" — the question that matters.
- Discoverability: a UI component author lists controller methods, not action types.

## Open design questions

- Does the controller hold the state internally (`useRef` + reducer), or expose it via a hook (`useSessionUi(): {state, controller}`)?
- Are any actions truly _structural_ (e.g. used by replay/devtools)? Those would need an escape hatch.
- Migration: one big switch, or strangle by replacing call sites incrementally while both interfaces coexist?

## Effort

Medium. ~25 action variants × call-site count. Mechanical once the controller shape is decided.
