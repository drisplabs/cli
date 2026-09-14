import {describe, expect, it} from 'vitest';
import {createSessionUiController} from './sessionUiController';
import {initialSessionUiState, type SessionUiContext} from './sessionUiState';

describe('session UI intents', () => {
	it('reveals an event with focus and viewport together, then returns to live output', () => {
		let state = {...initialSessionUiState};
		const context: SessionUiContext = {
			feedEntryCount: 10,
			feedContentRows: 3,
			feedEntries: Array.from({length: 10}, (_, i) => ({id: String(i)})),
			searchMatchCount: 0,
			todoVisibleCount: 0,
			todoListHeight: 0,
			todoFocusable: false,
			todoAnchorIndex: -1,
			messageEntryCount: 0,
			messageEntryLength: 0,
			messageEntryLineOffsets: [],
			messageContentRows: 0,
		};
		const ui = createSessionUiController(
			change => {
				state = change(state);
			},
			() => context,
		);
		ui.reveal(2);
		expect(state).toMatchObject({
			feedCursorId: '2',
			focusMode: 'feed',
			tailFollow: false,
		});
		ui.navigate('feed', 'tail');
		expect(state).toMatchObject({
			feedCursorId: '9',
			tailFollow: true,
			feedViewportStart: 7,
		});
		ui.input('search-open');
		expect(state.inputMode).toBe('search');
		ui.search.submit('needle', 1);
		expect(state.searchQuery).toBe('needle');
	});
});
