import {type UICommand} from '../types';
import {generateId} from '../../../harnesses/claude/protocol/index';
import * as registry from '../registry';

export const helpCommand: UICommand = {
	name: 'help',
	description: 'Lists all available commands',
	category: 'ui',
	aliases: ['h', '?'],
	execute(ctx) {
		const commands = registry.getAll();
		const lines = commands.map(cmd => {
			const aliases = cmd.aliases?.length
				? ` (${cmd.aliases.map(a => `/${a}`).join(', ')})`
				: '';
			return `  /${cmd.name}${aliases} - ${cmd.description}`;
		});

		const interactionHints = [
			'',
			'Interaction:',
			'  Mouse wheel - scroll the panel under the pointer when mouse mode is on',
			'  Click - focus the panel under the pointer when mouse mode is on',
			'  y - copy the focused message/detail to clipboard',
			'  /mouse off - disable app mouse handling for native terminal drag selection',
			'  /mouse on - restore panel wheel scrolling and click focus',
			'  Fn-drag - native terminal text selection on macOS terminals that reserve mouse drag for the app',
		];

		ctx.addMessage({
			id: generateId(),
			role: 'assistant',
			content: `Available commands:\n${lines.join('\n')}${interactionHints.join('\n')}`,
			timestamp: new Date(),
		});
	},
};
