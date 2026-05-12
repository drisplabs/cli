import type {HeaderStatus} from './statusBadge';
import {detectHarness} from '../../shared/utils/detectHarness';

export type {HeaderStatus} from './statusBadge';

export interface HeaderModel {
	session_id: string;
	session_index: number | null;
	session_total: number;
	workflow: string;
	harness: string;
	model_name: string | null;
	context: {used: number | null; max: number | null};
	total_tokens: number | null;
	token_label: string;
	run_count: number;
	run_label: string;
	engine?: string;
	progress?: {done: number; total: number};
	status: HeaderStatus;
	error_reason?: string;
	tail_mode: boolean;
}

export interface HeaderModelInput {
	session: {session_id?: string; agent_type?: string} | null;
	currentRun: {
		run_id: string;
		trigger: {prompt_preview?: string};
		started_at: number;
	} | null;
	runSummaries: {status: string; endedAt?: number}[];
	metrics: {failures: number; blocks: number};
	todoPanel: {
		doneCount: number;
		doingCount: number;
		todoItems: {length: number};
	};
	tailFollow: boolean;
	now: number;
	workflowRef?: string;
	harness?: string;
	modelName?: string | null;
	contextUsed?: number | null;
	contextMax?: number | null;
	totalTokens?: number | null;
	runCount?: number;
	turnCount?: number;
	sessionIndex?: number | null;
	sessionTotal?: number;
	errorReason?: string;
}

function deriveStatus(
	currentRun: HeaderModelInput['currentRun'],
	runSummaries: HeaderModelInput['runSummaries'],
	errorReason?: string,
): HeaderStatus {
	if (errorReason) return 'error';
	if (currentRun) return 'active';
	const last = runSummaries.at(-1);
	if (!last) return 'idle';
	if (last.status === 'FAILED') return 'error';
	if (last.status === 'CANCELLED') return 'stopped';
	if (last.status === 'SUCCEEDED') return 'idle';
	return 'idle';
}

function isCodexHarness(input: HeaderModelInput): boolean {
	const rawHarness = input.harness?.toLowerCase() ?? '';
	const rawAgentType = input.session?.agent_type?.toLowerCase() ?? '';
	return rawHarness.includes('codex') || rawAgentType.includes('codex');
}

export function countDistinctTurnIds(
	events: ReadonlyArray<{data?: unknown}>,
): number {
	const turnIds = new Set<string>();
	for (const event of events) {
		const data =
			typeof event.data === 'object' && event.data !== null
				? (event.data as Record<string, unknown>)
				: {};
		const turnId = data['turn_id'];
		if (typeof turnId === 'string' && turnId.length > 0) {
			turnIds.add(turnId);
		}
	}
	return turnIds.size;
}

export function buildHeaderModel(input: HeaderModelInput): HeaderModel {
	const {
		session,
		currentRun,
		runSummaries,
		todoPanel,
		tailFollow,
		workflowRef,
	} = input;

	const status = deriveStatus(currentRun, runSummaries, input.errorReason);
	const sessionTotal = Math.max(
		0,
		Math.trunc(input.sessionTotal ?? (session?.session_id ? 1 : 0)),
	);
	const sessionIndex =
		sessionTotal > 0 && session?.session_id
			? Math.min(
					Math.max(1, Math.trunc(input.sessionIndex ?? sessionTotal)),
					sessionTotal,
				)
			: null;
	const codexHarness = isCodexHarness(input);

	return {
		session_id: session?.session_id ?? '–',
		session_index: sessionIndex,
		session_total: sessionTotal,
		workflow: workflowRef ?? 'default',
		harness: detectHarness(input.harness),
		model_name: input.modelName ?? null,
		context: {used: input.contextUsed ?? null, max: input.contextMax ?? null},
		total_tokens: input.totalTokens ?? null,
		token_label: codexHarness ? 'Billable' : 'Tokens',
		run_count: codexHarness
			? (input.turnCount ?? input.runCount ?? 0)
			: (input.runCount ?? 0),
		run_label: codexHarness ? 'Turns' : 'Runs',
		engine: session?.agent_type,
		progress:
			todoPanel.todoItems.length > 0
				? {done: todoPanel.doneCount, total: todoPanel.todoItems.length}
				: undefined,
		status,
		error_reason: status === 'error' ? input.errorReason : undefined,
		tail_mode: tailFollow,
	};
}
