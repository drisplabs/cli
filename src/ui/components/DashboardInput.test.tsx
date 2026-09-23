import React from 'react';
import {render} from 'ink-testing-library';
import {describe, expect, it, vi} from 'vitest';
import DashboardInput from './DashboardInput';
import {
	waitFor,
	waitForFrame,
	waitForInputReady,
} from '../__tests__/inkTestHelpers';

const KEY = {ENTER: '\r'};

describe('DashboardInput', () => {
	it('renders placeholder and run label', () => {
		const {lastFrame} = render(
			<DashboardInput width={60} onSubmit={vi.fn()} runLabel="RUN" />,
		);

		const frame = lastFrame() ?? '';
		expect(frame).toContain('input>');
		expect(frame).toContain('[RUN]');
		expect(frame).toContain('Type a message or /command');
	});

	it('submits entered text on enter', async () => {
		const onSubmit = vi.fn();
		const {stdin, lastFrame} = render(
			<DashboardInput width={60} onSubmit={onSubmit} runLabel="SEND" />,
		);

		stdin.write('hello world');
		await waitForInputReady(lastFrame, 'hello world');
		stdin.write(KEY.ENTER);
		await waitFor(() => {
			expect(onSubmit).toHaveBeenCalledWith('hello world');
		});
	});

	it('supports history callbacks via ctrl+p / ctrl+n', async () => {
		const onHistoryBack = vi.fn().mockReturnValue('prev prompt');
		const onHistoryForward = vi.fn().mockReturnValue('next prompt');
		const {stdin, lastFrame} = render(
			<DashboardInput
				width={60}
				onSubmit={vi.fn()}
				onHistoryBack={onHistoryBack}
				onHistoryForward={onHistoryForward}
			/>,
		);

		stdin.write('\x10'); // Ctrl+P
		await waitForInputReady(lastFrame, 'prev prompt');
		expect(onHistoryBack).toHaveBeenCalled();

		stdin.write('\x0e'); // Ctrl+N
		await waitForFrame(lastFrame, 'next prompt');
		expect(onHistoryForward).toHaveBeenCalled();
	});
});
