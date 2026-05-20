import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';
import {createFeedMapper} from '../../core/feed/mapper';
import {mapLegacyHookNameToRuntimeKind} from '../../core/runtime/events';
import type {RuntimeEvent} from '../../core/runtime/types';
import {auditHookPipelineSnapshot, auditSessionHookPipeline} from './hookAudit';
import {createSessionStore} from './store';

function makeRuntimeEvent(
	hookName: string,
	payload: Record<string, unknown>,
): RuntimeEvent {
	const kind = mapLegacyHookNameToRuntimeKind(hookName);
	return {
		id: `req-${hookName}`,
		timestamp: Date.now(),
		kind,
		data: payload,
		hookName,
		sessionId: 'adapter-1',
		context: {
			cwd: '/project',
			transcriptPath: '/tmp/t.jsonl',
		},
		interaction: {expectsDecision: false},
		payload,
	};
}

describe('auditSessionHookPipeline', () => {
	it('reports live runtime/feed snapshot visibility counts', () => {
		const mapper = createFeedMapper();
		const event = makeRuntimeEvent('InstructionsLoaded', {
			hook_event_name: 'InstructionsLoaded',
			session_id: 'adapter-1',
			transcript_path: '/tmp/t.jsonl',
			cwd: '/project',
			file_path: '/project/CLAUDE.md',
			memory_type: 'Project',
			load_reason: 'session_start',
		});

		const report = auditHookPipelineSnapshot({
			runtimeEvents: [event],
			feedEvents: mapper.mapEvent(event),
		});

		expect(report.runtimeByHookName.InstructionsLoaded).toBe(1);
		expect(report.feedByKind['instructions.loaded']).toBe(1);
		expect(report.visibleNormalByKind['instructions.loaded']).toBeUndefined();
		expect(report.visibleVerboseByKind['instructions.loaded']).toBe(1);
	});

	it('reports runtime, feed, and normal/verbose visibility counts', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-hook-audit-'));
		const dbPath = path.join(dir, 'session.db');
		const store = createSessionStore({
			sessionId: 'athena-1',
			projectDir: '/project',
			dbPath,
		});
		const mapper = createFeedMapper();
		const event = makeRuntimeEvent('InstructionsLoaded', {
			hook_event_name: 'InstructionsLoaded',
			session_id: 'adapter-1',
			transcript_path: '/tmp/t.jsonl',
			cwd: '/project',
			file_path: '/project/CLAUDE.md',
			memory_type: 'Project',
			load_reason: 'session_start',
		});
		store.recordEvent(event, mapper.mapEvent(event));
		store.close();

		const report = auditSessionHookPipeline(dbPath);
		expect(report.runtimeByHookName.InstructionsLoaded).toBe(1);
		expect(report.feedByKind['instructions.loaded']).toBe(1);
		expect(report.visibleNormalByKind['instructions.loaded']).toBeUndefined();
		expect(report.visibleVerboseByKind['instructions.loaded']).toBe(1);
	});
});
