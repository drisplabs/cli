import {describe, expect, it} from 'vitest';
import {
	initialSessionUiState,
	reduceSessionUiState,
	resolveSessionUiState,
	type SessionUiContext,
	type SessionUiState,
} from '../sessionUiState';

function makeContext(
	overrides: Partial<SessionUiContext> = {},
): SessionUiContext {
	const count = overrides.feedEntryCount ?? 10;
	return {
		feedEntryCount: count,
		feedContentRows: 4,
		feedEntries:
			overrides.feedEntries ??
			Array.from({length: count}, (_, i) => ({id: `e${i}`})),
		searchMatchCount: 0,
		todoVisibleCount: 0,
		todoListHeight: 0,
		todoFocusable: false,
		todoAnchorIndex: -1,
		staticFloor: 0,
		messageEntryCount: 0,
		messageEntryLength: 0,
		messageEntryLineOffsets: [],
		messageContentRows: 0,
		...overrides,
	};
}

function resolve(
	state: Partial<SessionUiState>,
	ctx: Partial<SessionUiContext> = {},
) {
	return resolveSessionUiState(
		{...initialSessionUiState, ...state},
		makeContext(ctx),
	);
}

describe('sessionUiState', () => {
	it('resolveSessionUiState returns same reference when state is already resolved', () => {
		const ctx = makeContext({feedEntryCount: 10, feedContentRows: 4});
		const state: SessionUiState = {
			...initialSessionUiState,
			feedCursorId: 'e9',
			feedViewportStart: 6,
			tailFollow: true,
		};
		const result = resolveSessionUiState(state, ctx);
		expect(result).toBe(state);
	});

	it('falls back to feed focus when todo focus is no longer valid', () => {
		const result = resolve({
			focusMode: 'todo',
			todoVisible: true,
		});

		expect(result.focusMode).toBe('feed');
	});

	it('keeps auto todo cursor anchored on the preferred item', () => {
		const result = resolve(
			{
				todoCursor: 0,
				todoCursorMode: 'auto',
			},
			{
				todoVisibleCount: 6,
				todoFocusable: true,
				todoAnchorIndex: 3,
			},
		);

		expect(result.todoCursor).toBe(3);
	});

	it('clamps todo scroll into the visible window without a corrective effect', () => {
		const result = resolve(
			{
				todoCursor: 6,
				todoScroll: 0,
				todoCursorMode: 'manual',
			},
			{
				todoVisibleCount: 8,
				todoFocusable: true,
				todoListHeight: 2,
			},
		);

		expect(result.todoScroll).toBe(5);
	});

	it('clamps searchMatchPos when the match count shrinks', () => {
		const result = resolve(
			{
				searchMatchPos: 5,
			},
			{
				searchMatchCount: 2,
			},
		);

		expect(result.searchMatchPos).toBe(1);
	});

	it('cycles focus through todo only when the panel has focusable items', () => {
		const ctx = makeContext({
			todoVisibleCount: 3,
			todoFocusable: true,
			todoAnchorIndex: 1,
		});
		const afterInput = reduceSessionUiState(
			initialSessionUiState,
			{type: 'cycle_focus'},
			ctx,
		);
		const afterTodo = reduceSessionUiState(
			afterInput,
			{type: 'cycle_focus'},
			ctx,
		);

		expect(afterInput.focusMode).toBe('todo');
		expect(afterInput.todoCursorMode).toBe('auto');
		expect(afterTodo.focusMode).toBe('feed');
	});

	describe('identity preservation on no-op', () => {
		it('move_feed_cursor at top boundary returns same reference', () => {
			const ctx = makeContext({feedEntryCount: 10, feedContentRows: 4});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursorId: 'e0',
				feedViewportStart: 0,
				tailFollow: false,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'move_feed_cursor', delta: -1},
				ctx,
			);
			expect(result).toBe(state);
		});

		it('move_feed_cursor at bottom boundary returns same reference', () => {
			const ctx = makeContext({feedEntryCount: 10, feedContentRows: 4});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursorId: 'e9',
				feedViewportStart: 6,
				tailFollow: false,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'move_feed_cursor', delta: 1},
				ctx,
			);
			expect(result).toBe(state);
		});

		it('jump_feed_tail when already at tail returns same reference', () => {
			const ctx = makeContext({feedEntryCount: 10, feedContentRows: 4});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursorId: 'e9',
				feedViewportStart: 6,
				tailFollow: true,
			};
			const result = reduceSessionUiState(state, {type: 'jump_feed_tail'}, ctx);
			expect(result).toBe(state);
		});

		it('jump_feed_top when already at top returns same reference', () => {
			const ctx = makeContext({feedEntryCount: 10, feedContentRows: 4});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursorId: 'e0',
				feedViewportStart: 0,
				tailFollow: false,
			};
			const result = reduceSessionUiState(state, {type: 'jump_feed_top'}, ctx);
			expect(result).toBe(state);
		});

		it('set_tail_follow(false) when already false returns same reference', () => {
			const ctx = makeContext({feedEntryCount: 10, feedContentRows: 4});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursorId: 'e5',
				feedViewportStart: 3,
				tailFollow: false,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'set_tail_follow', tailFollow: false},
				ctx,
			);
			expect(result).toBe(state);
		});

		it('set_tail_follow(true) when already at tail returns same reference', () => {
			const ctx = makeContext({feedEntryCount: 10, feedContentRows: 4});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursorId: 'e9',
				feedViewportStart: 6,
				tailFollow: true,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'set_tail_follow', tailFollow: true},
				ctx,
			);
			expect(result).toBe(state);
		});

		it('move_todo_cursor at top boundary returns same reference', () => {
			const ctx = makeContext({todoVisibleCount: 5, todoFocusable: true});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursorId: 'e9',
				feedViewportStart: 6,
				todoCursor: 0,
				todoCursorMode: 'manual',
			};
			const result = reduceSessionUiState(
				state,
				{type: 'move_todo_cursor', delta: -1},
				ctx,
			);
			expect(result).toBe(state);
		});

		it('move_todo_cursor at bottom boundary returns same reference', () => {
			const ctx = makeContext({todoVisibleCount: 5, todoFocusable: true});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursorId: 'e9',
				feedViewportStart: 6,
				todoCursor: 4,
				todoCursorMode: 'manual',
			};
			const result = reduceSessionUiState(
				state,
				{type: 'move_todo_cursor', delta: 1},
				ctx,
			);
			expect(result).toBe(state);
		});

		it('set_feed_cursor to current position returns same reference', () => {
			const ctx = makeContext({feedEntryCount: 10, feedContentRows: 4});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursorId: 'e5',
				feedViewportStart: 3,
				tailFollow: false,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'set_feed_cursor', cursor: 5},
				ctx,
			);
			expect(result).toBe(state);
		});

		it('set_todo_cursor to current position returns same reference', () => {
			const ctx = makeContext({todoVisibleCount: 5, todoFocusable: true});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursorId: 'e9',
				feedViewportStart: 6,
				todoCursor: 2,
				todoCursorMode: 'manual',
			};
			const result = reduceSessionUiState(
				state,
				{type: 'set_todo_cursor', cursor: 2},
				ctx,
			);
			expect(result).toBe(state);
		});
	});

	describe('message scroll model', () => {
		it('scroll_message_viewport moves viewport by delta', () => {
			const ctx = makeContext({messageEntryCount: 50, messageContentRows: 10});
			const state: SessionUiState = {
				...initialSessionUiState,
				focusMode: 'messages',
				messageViewportStart: 0,
				messageTailFollow: false,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'scroll_message_viewport', delta: 3},
				ctx,
			);
			expect(result.messageViewportStart).toBe(3);
		});

		it('scroll_message_viewport clamps at bottom', () => {
			const ctx = makeContext({messageEntryCount: 50, messageContentRows: 10});
			const state: SessionUiState = {
				...initialSessionUiState,
				focusMode: 'messages',
				messageViewportStart: 39,
				messageTailFollow: false,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'scroll_message_viewport', delta: 5},
				ctx,
			);
			expect(result.messageViewportStart).toBe(40);
		});

		it('scroll_message_viewport clamps at top', () => {
			const ctx = makeContext({messageEntryCount: 50, messageContentRows: 10});
			const state: SessionUiState = {
				...initialSessionUiState,
				focusMode: 'messages',
				messageViewportStart: 2,
				messageTailFollow: false,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'scroll_message_viewport', delta: -5},
				ctx,
			);
			expect(result.messageViewportStart).toBe(0);
		});

		it('scroll_message_viewport disables tail follow', () => {
			const ctx = makeContext({messageEntryCount: 50, messageContentRows: 10});
			const state: SessionUiState = {
				...initialSessionUiState,
				focusMode: 'messages',
				messageViewportStart: 40,
				messageTailFollow: true,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'scroll_message_viewport', delta: -1},
				ctx,
			);
			expect(result.messageTailFollow).toBe(false);
			expect(result.messageViewportStart).toBe(39);
		});

		it('scroll_message_viewport is not pulled back by message cursor offsets', () => {
			const ctx = makeContext({
				messageEntryCount: 50,
				messageEntryLength: 5,
				messageEntryLineOffsets: [0, 10, 20, 30, 40],
				messageContentRows: 10,
			});
			const state: SessionUiState = {
				...initialSessionUiState,
				focusMode: 'messages',
				messageViewportStart: 0,
				messageCursorIndex: 0,
				messageTailFollow: false,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'scroll_message_viewport', delta: 3},
				ctx,
			);
			expect(result.messageViewportStart).toBe(3);
			expect(result.messageCursorIndex).toBe(0);
		});

		it('scroll_message_viewport can still reach the true bottom with a long final message', () => {
			const ctx = makeContext({
				// Total rendered line count across all messages
				messageEntryCount: 120,
				// Three messages, where the last message starts very late and is tall
				messageEntryLength: 3,
				messageEntryLineOffsets: [0, 8, 70],
				messageContentRows: 10,
			});
			const state: SessionUiState = {
				...initialSessionUiState,
				focusMode: 'messages',
				messageCursorIndex: 0,
				messageViewportStart: 0,
				messageTailFollow: false,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'scroll_message_viewport', delta: 999},
				ctx,
			);
			// maxStart = 120 - 10 = 110; viewport reaches the true bottom and the
			// focused entry derives to the last message occupying that anchor.
			expect(result.messageViewportStart).toBe(110);
			expect(result.messageCursorIndex).toBe(2);
			expect(result.messageTailFollow).toBe(false);
		});

		it('jump_message_tail pins viewport to bottom', () => {
			const ctx = makeContext({messageEntryCount: 50, messageContentRows: 10});
			const state: SessionUiState = {
				...initialSessionUiState,
				focusMode: 'messages',
				messageViewportStart: 0,
				messageTailFollow: false,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'jump_message_tail'},
				ctx,
			);
			expect(result.messageViewportStart).toBe(40);
			expect(result.messageTailFollow).toBe(true);
		});

		it('jump_message_top resets viewport to 0', () => {
			const ctx = makeContext({messageEntryCount: 50, messageContentRows: 10});
			const state: SessionUiState = {
				...initialSessionUiState,
				focusMode: 'messages',
				messageViewportStart: 25,
				messageTailFollow: false,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'jump_message_top'},
				ctx,
			);
			expect(result.messageViewportStart).toBe(0);
			expect(result.messageTailFollow).toBe(false);
		});

		it('resolve reclamps message viewport when line count shrinks', () => {
			const result = resolve(
				{
					messageViewportStart: 25,
					messageTailFollow: false,
				},
				{messageEntryCount: 20, messageContentRows: 10},
			);
			expect(result.messageViewportStart).toBe(10);
		});

		it('tail follow reclamps when line count changes', () => {
			const result = resolve(
				{
					messageTailFollow: true,
				},
				{messageEntryCount: 30, messageContentRows: 10},
			);
			expect(result.messageViewportStart).toBe(20);
		});

		it('falls back to feed focus when message entries are empty', () => {
			const result = resolve(
				{focusMode: 'messages'},
				{messageEntryCount: 0, messageContentRows: 10},
			);
			expect(result.focusMode).toBe('feed');
		});
	});

	describe('line-based message navigation (#20)', () => {
		it('derives cursor from the viewport anchor when scrolling into a long message', () => {
			// Two messages. msg0 occupies lines 0..49, msg1 starts at line 50.
			const ctx = makeContext({
				messageEntryCount: 60,
				messageEntryLength: 2,
				messageEntryLineOffsets: [0, 50],
				messageContentRows: 10,
			});
			const state: SessionUiState = {
				...initialSessionUiState,
				focusMode: 'messages',
				messageViewportStart: 0,
				messageCursorIndex: 0,
				messageTailFollow: false,
			};
			// Scroll deep into / past the long first message.
			const result = reduceSessionUiState(
				state,
				{type: 'scroll_message_viewport', delta: 52},
				ctx,
			);
			// Viewport clamps to maxStart = 60 - 10 = 50; the anchor line is now
			// inside msg1, so the focused entry derives to 1 (not stuck at 0).
			expect(result.messageViewportStart).toBe(50);
			expect(result.messageCursorIndex).toBe(1);
		});
	});

	describe('message cursor model (derived from viewport anchor)', () => {
		// One short message (5 lines) then one long message taller than the
		// viewport (msg1 occupies lines 5..54). Viewport height = 10.
		const longMsgCtx = () =>
			makeContext({
				messageEntryCount: 55,
				messageEntryLength: 2,
				messageEntryLineOffsets: [0, 5],
				messageContentRows: 10,
			});

		it('AC1: scrolls a long message line-by-line from first to last line', () => {
			const ctx = longMsgCtx();
			let state: SessionUiState = {
				...initialSessionUiState,
				focusMode: 'messages',
				messageViewportStart: 0,
				messageTailFollow: false,
			};
			// Step down one line at a time until clamped at the bottom.
			const maxStart = 55 - 10; // 45
			for (let i = 0; i < 60; i++) {
				state = reduceSessionUiState(
					state,
					{type: 'scroll_message_viewport', delta: 1},
					ctx,
				);
			}
			// Every line is reachable and the viewport clamps to the true last line.
			expect(state.messageViewportStart).toBe(maxStart);
			// Anchor line 45 sits inside the long message → focused entry derives to 1.
			expect(state.messageCursorIndex).toBe(1);
		});

		it('AC2: focused entry stays on the long message while its body scrolls', () => {
			const ctx = longMsgCtx();
			const state: SessionUiState = {
				...initialSessionUiState,
				focusMode: 'messages',
				messageViewportStart: 0,
				messageTailFollow: false,
			};
			// Scroll just past the short message into the long message body.
			const result = reduceSessionUiState(
				state,
				{type: 'scroll_message_viewport', delta: 20},
				ctx,
			);
			expect(result.messageViewportStart).toBe(20);
			// Anchor 20 is within msg1 (starts at line 5) → cursor derives to 1, not
			// stuck on msg0 and not jumped past the body.
			expect(result.messageCursorIndex).toBe(1);
		});

		it('derives the focused entry from the top visible line on scroll up', () => {
			const ctx = makeContext({
				messageEntryCount: 50,
				messageEntryLength: 5,
				messageEntryLineOffsets: [0, 10, 20, 30, 40],
				messageContentRows: 10,
			});
			const state: SessionUiState = {
				...initialSessionUiState,
				focusMode: 'messages',
				messageViewportStart: 35,
				messageTailFollow: false,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'scroll_message_viewport', delta: -10},
				ctx,
			);
			expect(result.messageViewportStart).toBe(25);
			// Anchor 25 lands inside entry 2 (offsets [0,10,20,30,40]).
			expect(result.messageCursorIndex).toBe(2);
		});

		it('AC3: PageDown/PageUp scroll by line step and stay clamped', () => {
			const ctx = longMsgCtx();
			const start: SessionUiState = {
				...initialSessionUiState,
				focusMode: 'messages',
				messageViewportStart: 0,
				messageTailFollow: false,
			};
			const down = reduceSessionUiState(
				start,
				{type: 'scroll_message_viewport', delta: 5},
				ctx,
			);
			expect(down.messageViewportStart).toBe(5);
			const up = reduceSessionUiState(
				down,
				{type: 'scroll_message_viewport', delta: -5},
				ctx,
			);
			expect(up.messageViewportStart).toBe(0);
			expect(up.messageCursorIndex).toBe(0);
		});

		it('AC3: Home (jump_message_top) goes to first line / first entry', () => {
			const ctx = longMsgCtx();
			const state: SessionUiState = {
				...initialSessionUiState,
				focusMode: 'messages',
				messageViewportStart: 40,
				messageTailFollow: true,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'jump_message_top'},
				ctx,
			);
			expect(result.messageViewportStart).toBe(0);
			expect(result.messageCursorIndex).toBe(0);
			expect(result.messageTailFollow).toBe(false);
		});

		it('AC3: End (jump_message_tail) pins to bottom, last entry, tailFollow on', () => {
			const ctx = makeContext({
				messageEntryCount: 50,
				messageEntryLength: 10,
				messageEntryLineOffsets: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45],
				messageContentRows: 10,
			});
			const state: SessionUiState = {
				...initialSessionUiState,
				focusMode: 'messages',
				messageViewportStart: 0,
				messageTailFollow: false,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'jump_message_tail'},
				ctx,
			);
			expect(result.messageViewportStart).toBe(40);
			expect(result.messageCursorIndex).toBe(9);
			expect(result.messageTailFollow).toBe(true);
		});

		it('AC4: mixed user/agent — separator lines attribute to the preceding entry', () => {
			// Three entries with separator lines: agent(0) at 0..2, separator at 3,
			// user(1) at 4..6, separator at 7, agent(2) at 8..12.
			const ctx = makeContext({
				messageEntryCount: 13,
				messageEntryLength: 3,
				messageEntryLineOffsets: [0, 4, 8],
				messageContentRows: 5,
			});
			// Anchor on the separator line (3) before entry 1 stays on entry 0.
			const onSep = resolve(
				{
					focusMode: 'messages',
					messageViewportStart: 3,
					messageTailFollow: false,
				},
				ctx,
			);
			expect(onSep.messageCursorIndex).toBe(0);
			// Anchor on entry 1's first content line derives to 1.
			const onEntry1 = resolve(
				{
					focusMode: 'messages',
					messageViewportStart: 4,
					messageTailFollow: false,
				},
				ctx,
			);
			expect(onEntry1.messageCursorIndex).toBe(1);
		});

		it('AC4: tab filtering reclamps viewport and re-derives cursor', () => {
			// Was scrolled deep into a "both" view; switching to a tab with fewer
			// lines reclamps the viewport and re-derives the focused entry.
			const result = resolve(
				{
					focusMode: 'messages',
					messageViewportStart: 40,
					messageCursorIndex: 4,
					messageTailFollow: false,
				},
				{
					messageEntryCount: 25,
					messageEntryLength: 3,
					messageEntryLineOffsets: [0, 8, 16],
					messageContentRows: 10,
				},
			);
			// maxStart = 25 - 10 = 15; anchor 15 lands inside entry 1 (offsets [0,8,16]).
			expect(result.messageViewportStart).toBe(15);
			expect(result.messageCursorIndex).toBe(1);
		});

		it('AC4: resize/clamp — viewport shrinks to the new bottom', () => {
			const result = resolve(
				{
					focusMode: 'messages',
					messageViewportStart: 25,
					messageTailFollow: false,
				},
				{messageEntryCount: 20, messageContentRows: 10},
			);
			expect(result.messageViewportStart).toBe(10);
		});

		it('resolve pins cursor to last entry when tailFollow is true', () => {
			const result = resolve(
				{
					focusMode: 'messages',
					messageCursorIndex: 0,
					messageTailFollow: true,
				},
				{
					messageEntryCount: 50,
					messageEntryLength: 5,
					messageEntryLineOffsets: [0, 10, 20, 30, 40],
					messageContentRows: 10,
				},
			);
			expect(result.messageCursorIndex).toBe(4);
		});

		it('AC4: short messages — single short message keeps cursor at 0', () => {
			const ctx = makeContext({
				messageEntryCount: 3,
				messageEntryLength: 1,
				messageEntryLineOffsets: [0],
				messageContentRows: 10,
			});
			// Document shorter than viewport: scrolling is a no-op, cursor stays 0.
			const result = reduceSessionUiState(
				{
					...initialSessionUiState,
					focusMode: 'messages',
					messageViewportStart: 0,
					messageTailFollow: false,
				},
				{type: 'scroll_message_viewport', delta: 5},
				ctx,
			);
			expect(result.messageViewportStart).toBe(0);
			expect(result.messageCursorIndex).toBe(0);
		});
	});

	describe('identity-based cursor', () => {
		it('move forward by delta resolves correct entry ID', () => {
			const entries = [{id: 'a'}, {id: 'b'}, {id: 'c'}, {id: 'd'}, {id: 'e'}];
			const ctx = makeContext({
				feedEntryCount: 5,
				feedContentRows: 5,
				feedEntries: entries,
			});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursorId: 'b',
				tailFollow: false,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'move_feed_cursor', delta: 2},
				ctx,
			);
			expect(result.feedCursorId).toBe('d');
		});

		it('move backward by negative delta resolves correct entry ID', () => {
			const entries = [{id: 'a'}, {id: 'b'}, {id: 'c'}, {id: 'd'}, {id: 'e'}];
			const ctx = makeContext({
				feedEntryCount: 5,
				feedContentRows: 5,
				feedEntries: entries,
			});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursorId: 'd',
				tailFollow: false,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'move_feed_cursor', delta: -2},
				ctx,
			);
			expect(result.feedCursorId).toBe('b');
		});

		it('move clamps at array bounds (forward)', () => {
			const entries = [{id: 'a'}, {id: 'b'}, {id: 'c'}];
			const ctx = makeContext({
				feedEntryCount: 3,
				feedContentRows: 3,
				feedEntries: entries,
			});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursorId: 'b',
				tailFollow: false,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'move_feed_cursor', delta: 10},
				ctx,
			);
			expect(result.feedCursorId).toBe('c');
		});

		it('move with null cursorId starts from first entry', () => {
			const entries = [{id: 'a'}, {id: 'b'}];
			const ctx = makeContext({
				feedEntryCount: 2,
				feedContentRows: 2,
				feedEntries: entries,
			});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursorId: null,
				tailFollow: false,
			};
			const fwd = reduceSessionUiState(
				state,
				{type: 'move_feed_cursor', delta: 1},
				ctx,
			);
			expect(fwd.feedCursorId).toBe('b');

			const back = reduceSessionUiState(
				state,
				{type: 'move_feed_cursor', delta: -1},
				ctx,
			);
			expect(back.feedCursorId).toBe('a');
		});

		it('jump_feed_tail sets cursorId to last entry', () => {
			const entries = [{id: 'a'}, {id: 'b'}, {id: 'c'}];
			const ctx = makeContext({
				feedEntryCount: 3,
				feedContentRows: 2,
				feedEntries: entries,
			});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursorId: 'a',
				tailFollow: false,
			};
			const result = reduceSessionUiState(state, {type: 'jump_feed_tail'}, ctx);
			expect(result.feedCursorId).toBe('c');
			expect(result.tailFollow).toBe(true);
		});

		it('jump_feed_top sets cursorId to first entry', () => {
			const entries = [{id: 'a'}, {id: 'b'}, {id: 'c'}];
			const ctx = makeContext({
				feedEntryCount: 3,
				feedContentRows: 2,
				feedEntries: entries,
			});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursorId: 'c',
				tailFollow: false,
			};
			const result = reduceSessionUiState(state, {type: 'jump_feed_top'}, ctx);
			expect(result.feedCursorId).toBe('a');
		});

		it('set_feed_cursor sets cursorId by index lookup', () => {
			const entries = [{id: 'a'}, {id: 'b'}, {id: 'c'}];
			const ctx = makeContext({
				feedEntryCount: 3,
				feedContentRows: 3,
				feedEntries: entries,
			});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursorId: 'a',
				tailFollow: false,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'set_feed_cursor', cursor: 2},
				ctx,
			);
			expect(result.feedCursorId).toBe('c');
		});

		it('stale cursorId snaps to last entry on resolve', () => {
			const entries = [{id: 'x'}, {id: 'y'}];
			const ctx = makeContext({
				feedEntryCount: 2,
				feedContentRows: 2,
				feedEntries: entries,
			});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursorId: 'deleted-entry',
				tailFollow: false,
			};
			const result = resolveSessionUiState(state, ctx);
			expect(result.feedCursorId).toBe('y');
		});

		it('tailFollow pins cursorId to last entry on resolve', () => {
			const entries = [{id: 'a'}, {id: 'b'}, {id: 'c'}];
			const ctx = makeContext({
				feedEntryCount: 3,
				feedContentRows: 2,
				feedEntries: entries,
			});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursorId: 'a',
				tailFollow: true,
			};
			const result = resolveSessionUiState(state, ctx);
			expect(result.feedCursorId).toBe('c');
		});

		it('cursor stays valid when entries are filtered to a subset', () => {
			// Simulates split mode: full list has 5 entries, displayed subset has 3
			const fullEntries = [
				{id: 'msg1'},
				{id: 'evt1'},
				{id: 'msg2'},
				{id: 'evt2'},
				{id: 'evt3'},
			];
			// In split mode, only feed events are displayed
			const displayedEntries = [{id: 'evt1'}, {id: 'evt2'}, {id: 'evt3'}];

			// Cursor is on evt2 in the full list — should resolve correctly in subset
			const ctx = makeContext({
				feedEntryCount: 3,
				feedContentRows: 3,
				feedEntries: displayedEntries,
			});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursorId: 'evt2',
				tailFollow: false,
			};
			const result = resolveSessionUiState(state, ctx);
			expect(result.feedCursorId).toBe('evt2');

			// Moving down by 1 should go to evt3 (not msg2)
			const moved = reduceSessionUiState(
				state,
				{type: 'move_feed_cursor', delta: 1},
				ctx,
			);
			expect(moved.feedCursorId).toBe('evt3');

			// Cursor on a message entry (not in displayed subset) should snap
			const staleState: SessionUiState = {
				...initialSessionUiState,
				feedCursorId: 'msg1',
				tailFollow: false,
			};
			const snapped = resolveSessionUiState(staleState, ctx);
			expect(snapped.feedCursorId).toBe('evt3');

			void fullEntries; // referenced for documentation
		});

		it('step_search_match jumps cursor to match index', () => {
			const entries = [{id: 'a'}, {id: 'b'}, {id: 'c'}, {id: 'd'}];
			const ctx = makeContext({
				feedEntryCount: 4,
				feedContentRows: 4,
				feedEntries: entries,
				searchMatchCount: 2,
			});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursorId: 'a',
				searchMatchPos: 0,
				tailFollow: false,
			};
			// Matches at display indices 1 and 3
			const result = reduceSessionUiState(
				state,
				{type: 'step_search_match', direction: 1, matches: [1, 3]},
				ctx,
			);
			expect(result.feedCursorId).toBe('d');
			expect(result.searchMatchPos).toBe(1);
		});
	});
});
