import {type UICommand} from '../types';
import {generateId} from '../../../harnesses/claude/protocol/index';

export const mouseCommand: UICommand = {
	name: 'mouse',
	description: 'Show or change terminal mouse mode',
	category: 'ui',
	args: [
		{
			name: 'mode',
			description: 'on, off, or toggle',
			required: false,
		},
	],
	execute: ctx => {
		const rawMode = ctx.args['mode']?.toLowerCase();
		if (!rawMode) {
			ctx.addMessage({
				id: generateId(),
				role: 'assistant',
				content:
					ctx.mouseMode === 'on'
						? 'Mouse mode is on. Wheel scrolls panels; use /mouse off for native drag selection.'
						: 'Mouse mode is off. Terminal drag selection is native; use /mouse on to restore panel wheel scrolling.',
				timestamp: new Date(),
			});
			return;
		}

		if (rawMode !== 'on' && rawMode !== 'off' && rawMode !== 'toggle') {
			ctx.addMessage({
				id: generateId(),
				role: 'assistant',
				content: 'Usage: /mouse [on|off|toggle]',
				timestamp: new Date(),
			});
			return;
		}

		const nextMode =
			rawMode === 'toggle' ? (ctx.mouseMode === 'on' ? 'off' : 'on') : rawMode;
		ctx.setMouseMode(nextMode);
		ctx.addMessage({
			id: generateId(),
			role: 'assistant',
			content:
				nextMode === 'on'
					? 'Mouse mode on: wheel scrolls panels and clicks focus panels.'
					: 'Mouse mode off: terminal drag selection is native; use keyboard navigation or /mouse on to restore wheel scrolling.',
			timestamp: new Date(),
		});
	},
};
