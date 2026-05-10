import {describe, expect, it, vi} from 'vitest';
import type {ControllerCallbacks} from '../controller/runtimeController';
import type {HookRule} from '../controller/rules';
import type {RuntimeDecision, RuntimeEvent} from '../runtime/types';
import type {SessionStore} from '../../infra/sessions/store';
import type {FeedEvent} from './types';
import type {FeedMapper} from './mapper';
import {ingestRuntimeDecision, ingestRuntimeEvent} from './ingest';

function makePermissionRequest(toolName: string, id = 'r1'): RuntimeEvent {
	const payload = {
		hook_event_name: 'PreToolUse',
		session_id: 'sess-1',
		transcript_path: '/tmp/t.jsonl',
		cwd: '/project',
		tool_name: toolName,
		tool_input: {command: 'echo hi'},
	};
	return {
		id,
		timestamp: 0,
		kind: 'permission.request',
		data: payload,
		hookName: 'PreToolUse',
		sessionId: 'sess-1',
		context: {cwd: '/project', transcriptPath: '/tmp/t.jsonl'},
		interaction: {expectsDecision: true},
		payload,
		toolName,
	};
}

function makeMapperStub(opts?: {
	mapEvent?: (event: RuntimeEvent) => FeedEvent[];
	mapDecision?: (id: string, d: RuntimeDecision) => FeedEvent | null;
}): FeedMapper {
	const mapEvent =
		opts?.mapEvent ??
		((event: RuntimeEvent): FeedEvent[] => [
			{
				event_id: `fe-${event.id}`,
				seq: 1,
				run_id: 'run-1',
				session_id: event.sessionId ?? 'sess-1',
				actor_id: 'agent:root',
				kind: 'tool.pre',
				ts: 0,
				data: {
					tool_name: event.toolName ?? 'X',
					tool_use_id: 'tu-1',
					input: {},
				},
			} as unknown as FeedEvent,
		]);
	const mapDecision =
		opts?.mapDecision ??
		((id: string, d: RuntimeDecision): FeedEvent | null =>
			({
				event_id: `fe-dec-${id}`,
				seq: 2,
				run_id: 'run-1',
				session_id: 'sess-1',
				actor_id: 'agent:root',
				kind: 'permission.decision',
				ts: 0,
				data: {decision: d.intent?.kind ?? 'unknown'},
			}) as unknown as FeedEvent);
	return {
		mapEvent,
		mapDecision,
	} as unknown as FeedMapper;
}

function makeStoreStub(overrides?: Partial<SessionStore>): SessionStore {
	return {
		recordEvent: vi.fn(),
		recordFeedEvents: vi.fn(),
		markDegraded: vi.fn(),
		isDegraded: false,
		degradedReason: undefined,
		// unused in these tests
		restore: vi.fn(),
		toBootstrap: vi.fn(),
		getAthenaSession: vi.fn(),
		updateLabel: vi.fn(),
		recordTokens: vi.fn(),
		getRestoredTokens: vi.fn(),
		close: vi.fn(),
		persistRun: vi.fn(),
		getLatestRun: vi.fn(),
		linkAdapterSession: vi.fn(),
		...overrides,
	} as unknown as SessionStore;
}

function makeCallbacks(rules: HookRule[] = []): ControllerCallbacks {
	return {
		getRules: () => rules,
		enqueuePermission: vi.fn(),
		enqueueQuestion: vi.fn(),
	};
}

describe('ingestRuntimeEvent', () => {
	it('returns mapped feed events and persists them through the store', () => {
		const mapper = makeMapperStub();
		const store = makeStoreStub();
		const callbacks = makeCallbacks();
		const event = makePermissionRequest('Bash');

		const result = ingestRuntimeEvent(event, {
			mapper,
			store,
			controllerCallbacks: callbacks,
		});

		expect(result.feedEvents).toHaveLength(1);
		expect(store.recordEvent).toHaveBeenCalledWith(event, result.feedEvents);
		expect(store.markDegraded).not.toHaveBeenCalled();
	});

	it('returns a rule-matched decision for the caller to dispatch', () => {
		const mapper = makeMapperStub();
		const callbacks = makeCallbacks([
			{
				id: 'rule-1',
				toolName: 'Bash',
				action: 'approve',
				addedBy: 'test',
			},
		]);

		const result = ingestRuntimeEvent(makePermissionRequest('Bash'), {
			mapper,
			controllerCallbacks: callbacks,
		});

		expect(result.decision).not.toBeNull();
		expect(result.decision?.source).toBe('rule');
		expect(result.decision?.intent?.kind).toBe('permission_allow');
	});

	it('returns null decision when no rule matches', () => {
		const mapper = makeMapperStub();
		const callbacks = makeCallbacks();
		const result = ingestRuntimeEvent(makePermissionRequest('Bash'), {
			mapper,
			controllerCallbacks: callbacks,
		});
		expect(result.decision).toBeNull();
		expect(callbacks.enqueuePermission).toHaveBeenCalledTimes(1);
	});

	it('marks the store degraded and forwards onPersistFailure when recordEvent throws', () => {
		const mapper = makeMapperStub();
		const onPersistFailure = vi.fn();
		const store = makeStoreStub({
			recordEvent: vi.fn(() => {
				throw new Error('disk full');
			}),
		});

		ingestRuntimeEvent(makePermissionRequest('Bash'), {
			mapper,
			store,
			controllerCallbacks: makeCallbacks(),
			onPersistFailure,
		});

		expect(store.markDegraded).toHaveBeenCalledWith(
			'recordEvent failed: disk full',
		);
		expect(onPersistFailure).toHaveBeenCalledWith(
			'recordEvent failed: disk full',
		);
	});

	it('skips persistence when no store is supplied', () => {
		const mapper = makeMapperStub();
		const result = ingestRuntimeEvent(makePermissionRequest('Bash'), {
			mapper,
			controllerCallbacks: makeCallbacks(),
		});
		expect(result.feedEvents).toHaveLength(1);
	});
});

describe('ingestRuntimeDecision', () => {
	it('persists the mapped feed event when the mapper produces one', () => {
		const mapper = makeMapperStub();
		const store = makeStoreStub();
		const decision: RuntimeDecision = {
			type: 'json',
			source: 'user',
			intent: {kind: 'permission_allow'},
		};

		const fe = ingestRuntimeDecision('r1', decision, {mapper, store});

		expect(fe).not.toBeNull();
		expect(store.recordFeedEvents).toHaveBeenCalledWith([fe]);
	});

	it('returns null and does not touch the store when the mapper drops the decision', () => {
		const mapper = makeMapperStub({mapDecision: () => null});
		const store = makeStoreStub();
		const decision: RuntimeDecision = {
			type: 'json',
			source: 'user',
			intent: {kind: 'permission_allow'},
		};

		const fe = ingestRuntimeDecision('r1', decision, {mapper, store});

		expect(fe).toBeNull();
		expect(store.recordFeedEvents).not.toHaveBeenCalled();
	});

	it('marks the store degraded and forwards onPersistFailure when recordFeedEvents throws', () => {
		const mapper = makeMapperStub();
		const onPersistFailure = vi.fn();
		const store = makeStoreStub({
			recordFeedEvents: vi.fn(() => {
				throw new Error('locked');
			}),
		});

		ingestRuntimeDecision(
			'r1',
			{
				type: 'json',
				source: 'user',
				intent: {kind: 'permission_allow'},
			},
			{mapper, store, onPersistFailure},
		);

		expect(store.markDegraded).toHaveBeenCalledWith(
			'recordFeedEvents failed: locked',
		);
		expect(onPersistFailure).toHaveBeenCalledWith(
			'recordFeedEvents failed: locked',
		);
	});
});
