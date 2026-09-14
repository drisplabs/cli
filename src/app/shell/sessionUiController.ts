import {
	reduceSessionUiState,
	type SessionUiAction,
	type SessionUiState,
	type SessionUiContext,
} from './sessionUiState';
import type {InputMode, FocusMode} from './types';
import type {MessageTab} from '../../core/feed/panelFilter';

type Update<T> = T | ((previous: T) => T);
/** UI intents keep cursor, viewport, follow mode and focus updates together. */
export function createSessionUiController(
	update: (change: (state: SessionUiState) => SessionUiState) => void,
	context: () => SessionUiContext,
) {
	const dispatch = (action: SessionUiAction) =>
		update(state => reduceSessionUiState(state, action, context()));
	return {
		focus: (focusMode: FocusMode) =>
			dispatch({type: 'set_focus_mode', focusMode}),
		cycleFocus: () => dispatch({type: 'cycle_focus'}),
		input: (
			mode:
				| InputMode
				| 'cancel'
				| 'command-open'
				| 'search-open'
				| 'normal-open',
		) => {
			switch (mode) {
				case 'cancel':
					dispatch({type: 'cancel_input'});
					break;
				case 'command-open':
					dispatch({type: 'open_command_input'});
					break;
				case 'search-open':
					dispatch({type: 'open_search_input'});
					break;
				case 'normal-open':
					dispatch({type: 'open_normal_input'});
					break;
				case 'search':
				case 'command':
				case 'normal':
					dispatch({type: 'set_input_mode', inputMode: mode});
			}
		},
		cycleHints: () => dispatch({type: 'cycle_hints_forced'}),
		hideOverlay: () => dispatch({type: 'set_show_run_overlay', show: false}),
		search: {
			edit: (query: string) => dispatch({type: 'set_search_query', query}),
			submit: (query: string, firstMatchIndex: number | null) =>
				dispatch({type: 'submit_search_query', query, firstMatchIndex}),
			step: (direction: 1 | -1, matches: number[]) =>
				dispatch({type: 'step_search_match', direction, matches}),
			clear: () => dispatch({type: 'clear_search_and_jump_tail'}),
		},
		navigate: (
			panel: 'feed' | 'messages',
			destination: 'top' | 'tail' | number,
		) => {
			if (typeof destination === 'number')
				dispatch(
					panel === 'feed'
						? {type: 'move_feed_cursor', delta: destination}
						: {type: 'scroll_message_viewport', delta: destination},
				);
			else if (panel === 'feed')
				dispatch({
					type: destination === 'top' ? 'jump_feed_top' : 'jump_feed_tail',
				});
			else
				dispatch({
					type:
						destination === 'top' ? 'jump_message_top' : 'jump_message_tail',
				});
		},
		selectFeed: (cursor: number) => dispatch({type: 'set_feed_cursor', cursor}),
		followFeed: (tailFollow: boolean) =>
			dispatch({type: 'set_tail_follow', tailFollow}),
		reveal: (cursor: number) => dispatch({type: 'reveal_feed_entry', cursor}),
		messageTab: (tab: MessageTab) => dispatch({type: 'set_message_tab', tab}),
		todo: {
			toggle: () => dispatch({type: 'toggle_todo_visible'}),
			move: (delta: number) => dispatch({type: 'move_todo_cursor', delta}),
			visible: (value: Update<boolean>) =>
				update(state =>
					reduceSessionUiState(
						state,
						{
							type: 'set_todo_visible',
							visible:
								typeof value === 'function' ? value(state.todoVisible) : value,
						},
						context(),
					),
				),
			showDone: (value: Update<boolean>) =>
				update(state =>
					reduceSessionUiState(
						state,
						{
							type: 'set_todo_show_done',
							showDone:
								typeof value === 'function' ? value(state.todoShowDone) : value,
						},
						context(),
					),
				),
			cursor: (value: Update<number>) =>
				update(state =>
					reduceSessionUiState(
						state,
						{
							type: 'set_todo_cursor',
							cursor:
								typeof value === 'function' ? value(state.todoCursor) : value,
						},
						context(),
					),
				),
			scroll: (value: Update<number>) =>
				update(state => ({
					...state,
					todoScroll:
						typeof value === 'function' ? value(state.todoScroll) : value,
				})),
		},
	};
}
