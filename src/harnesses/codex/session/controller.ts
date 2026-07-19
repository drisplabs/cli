import type {Runtime} from '../../../core/runtime/types';
import type {HarnessProcessConfig} from '../../../core/runtime/process';
import type {
	CreateSessionControllerInput,
	SessionController,
	SessionControllerTurnResult,
} from '../../contracts/session';
import type {CodexRuntime} from '../runtime/server';
import {NULL_TOKENS} from '../runtime/tokenUsage';
import {runCodexTurn} from './turnRunner';

export function createCodexSessionController(
	input: CreateSessionControllerInput,
): SessionController {
	const runtime = input.runtime as (Runtime & CodexRuntime) | null;
	const processConfig = input.processConfig as HarnessProcessConfig | undefined;
	let activeTurnPromise: Promise<SessionControllerTurnResult> | null = null;

	return {
		async startTurn({
			prompt,
			continuation,
			configOverride,
		}): Promise<SessionControllerTurnResult> {
			if (!runtime || typeof runtime.sendPrompt !== 'function') {
				return {
					exitCode: null,
					error: new Error('Codex runtime not available'),
					tokens: {...NULL_TOKENS},
					streamMessage: null,
				};
			}

			const turnPromise = runCodexTurn(runtime, prompt, {
				processConfig,
				continuation,
				configOverride,
				workflowPlan: input.workflowPlan,
				pluginMcpConfig: input.pluginMcpConfig,
				ephemeral: input.ephemeral,
			});
			activeTurnPromise = turnPromise;

			try {
				return await turnPromise;
			} finally {
				activeTurnPromise = null;
			}
		},

		interrupt(): void {
			runtime?.sendInterrupt();
		},

		async kill(): Promise<void> {
			runtime?.sendInterrupt();
			await activeTurnPromise?.catch(() => {});
		},
	};
}
