import type {Interruption} from '@drisp/protocol';
import type {LoopConfig} from './types';

export const DEFAULT_RESTART_TOKENS = 2_000;
export const DEFAULT_WORKING_TOKENS = 8_000;
export type ResourceStop = NonNullable<
	Extract<Interruption, {kind: 'cap_exhausted'}>['resource']
>;

export function resourceInterruption(stop: ResourceStop): Interruption {
	const names: Record<ResourceStop['cause'], string> = {
		tokens: 'token budget',
		iterations: 'iteration ceiling',
		context: 'restart context allowance',
		restart: 'restart checkpoint',
	};
	return {
		kind: 'cap_exhausted',
		cap:
			stop.cause === 'iterations'
				? 'iterations'
				: stop.cause === 'tokens'
					? 'tokens'
					: 'handover',
		limit: stop.limit,
		message: `${names[stop.cause]} reached: ${stop.limit}; used ${stop.used}${stop.detail ? ` — ${stop.detail}` : ''}`,
		resource: stop,
	};
}

/** Every Turn start (including Retry and wake) passes this pure decision. */
export function admitContinuation(input: {
	loop?: LoopConfig;
	iteration: number;
	tokens: number | null;
	checkpointPath?: string;
	context?: {
		opening: number;
		required: number;
		ceiling: number;
		source: string;
	};
}): ResourceStop | null {
	const {loop} = input;
	if (!loop?.enabled) return null;
	const base = {fresh: false, checkpointPath: input.checkpointPath};
	if (
		loop.maxRunTokens !== undefined &&
		(input.tokens ?? 0) >= loop.maxRunTokens
	)
		return {
			...base,
			cause: 'tokens',
			limit: loop.maxRunTokens,
			used: input.tokens ?? 0,
		};
	if (input.iteration > loop.maxIterations)
		return {
			...base,
			cause: 'iterations',
			limit: loop.maxIterations,
			used: input.iteration - 1,
		};
	if (input.context) {
		const {opening, required, ceiling, source} = input.context;
		const used = opening + required + DEFAULT_WORKING_TOKENS;
		if (used > ceiling)
			return {
				...base,
				cause: 'context',
				fresh: true,
				limit: ceiling,
				used,
				detail: `opening ${opening} + checkpoint ${required} + ${DEFAULT_WORKING_TOKENS} working tokens; ${source}; reduce startup context or increase its allowance`,
			};
	}
	return null;
}
