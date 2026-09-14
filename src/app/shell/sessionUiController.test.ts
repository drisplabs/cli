import {describe, expect, it} from 'vitest';
import {createSessionUiController} from './sessionUiController';
import {
	initialSessionUiState,
	type SessionUiState,
	type SessionUiContext,
} from './sessionUiState';

function makeContext(): SessionUiContext {
	return {
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
}

describe('session UI intents', () => {
	it('reveals an event with focus and viewport together, then returns to live output', () => {
		let state = {...initialSessionUiState};
		const context = makeContext();
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
	it('moves wheel focus, cursor and viewport in one published update', () => {
		let state = {...initialSessionUiState};
		const published: SessionUiState[] = [];
		const context = makeContext();
		const ui = createSessionUiController(
			change => {
				state = change(state);
				published.push(state);
			},
			() => context,
		);
		ui.scrollPanel('feed', -5);
		expect(published).toHaveLength(1);
		expect(state).toMatchObject({
			focusMode: 'feed',
			feedCursorId: '4',
			feedViewportStart: 4,
			tailFollow: false,
		});
		context.messageEntryCount = 10;
		context.messageEntryLength = 10;
		context.messageEntryLineOffsets = Array.from({length: 10}, (_, i) => i);
		context.messageContentRows = 3;
		ui.scrollPanel('messages', -2);
		expect(published).toHaveLength(2);
		expect(state).toMatchObject({
			focusMode: 'messages',
			messageViewportStart: 5,
			messageTailFollow: false,
		});
	});

	it('keeps the selected task visible and restores focus when its panel closes', () => {
		let state = {...initialSessionUiState};
		const context = {
			...makeContext(),
			todoVisibleCount: 8,
			todoListHeight: 3,
			todoFocusable: true,
			todoAnchorIndex: 1,
		};
		const ui = createSessionUiController(
			change => {
				state = change(state);
			},
			() => context,
		);
		ui.focus('todo');
		expect(state).toMatchObject({
			focusMode: 'todo',
			todoCursor: 1,
			todoScroll: 0,
		});
		ui.todo.move(4);
		expect(state).toMatchObject({
			focusMode: 'todo',
			todoCursor: 5,
			todoScroll: 3,
			todoCursorMode: 'manual',
		});
		ui.todo.toggle();
		expect(state).toMatchObject({todoVisible: false, focusMode: 'feed'});
		ui.todo.show();
		expect(state).toMatchObject({
			todoVisible: true,
			todoCursorMode: 'auto',
			todoCursor: 1,
			todoScroll: 1,
		});
	});
});
