import {describe, it, expect, vi} from 'vitest';
import {mouseCommand} from '../builtins/mouse';
import {type UICommandContext} from '../types';

const NULL_TOKENS = {
	input: null,
	output: null,
	cacheRead: null,
	cacheWrite: null,
	total: null,
	contextSize: null,
};

function makeUIContext(
	overrides?: Partial<UICommandContext>,
): UICommandContext {
	return {
		args: {},
		messages: [],
		setMessages: vi.fn(),
		addMessage: vi.fn(),
		exit: vi.fn(),
		clearScreen: vi.fn(),
		mouseMode: 'on',
		setMouseMode: vi.fn(),
		showSessions: vi.fn(),
		showSetup: vi.fn(),
		showWorkflowPicker: vi.fn(),
		showModelPicker: vi.fn(),
		sessionStats: {
			metrics: {
				modelName: null,
				toolCallCount: 0,
				totalToolCallCount: 0,
				subagentCount: 0,
				subagentMetrics: [],
				permissions: {allowed: 0, denied: 0},
				sessionStartTime: null,
				tokens: NULL_TOKENS,
			},
			tokens: NULL_TOKENS,
			elapsed: 0,
		},
		...overrides,
	};
}

describe('mouseCommand', () => {
	it('reports current mouse mode with no args', () => {
		const ctx = makeUIContext({mouseMode: 'off'});

		mouseCommand.execute(ctx);

		expect(ctx.setMouseMode).not.toHaveBeenCalled();
		expect(ctx.addMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.stringContaining('Mouse mode is off'),
			}),
		);
	});

	it('turns mouse mode off', () => {
		const ctx = makeUIContext({args: {mode: 'off'}});

		mouseCommand.execute(ctx);

		expect(ctx.setMouseMode).toHaveBeenCalledWith('off');
		expect(ctx.addMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.stringContaining('Mouse mode off'),
			}),
		);
	});

	it('toggles mouse mode', () => {
		const ctx = makeUIContext({args: {mode: 'toggle'}, mouseMode: 'off'});

		mouseCommand.execute(ctx);

		expect(ctx.setMouseMode).toHaveBeenCalledWith('on');
	});

	it('prints usage for invalid mode', () => {
		const ctx = makeUIContext({args: {mode: 'maybe'}});

		mouseCommand.execute(ctx);

		expect(ctx.setMouseMode).not.toHaveBeenCalled();
		expect(ctx.addMessage).toHaveBeenCalledWith(
			expect.objectContaining({content: 'Usage: /mouse [on|off|toggle]'}),
		);
	});
});
