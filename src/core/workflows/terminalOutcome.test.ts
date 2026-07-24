import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {resolveTurnOutcome} from './terminalOutcome';
import {TRACKER_SKELETON_MARKER} from './trackerReader';
import type {LoopConfig} from './types';

const tempDirs: string[] = [];

function writeTracker(content: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-outcome-'));
	tempDirs.push(dir);
	const trackerPath = path.join(dir, 'tracker.md');
	fs.writeFileSync(trackerPath, content, 'utf-8');
	return trackerPath;
}

const LOOP: LoopConfig = {
	enabled: true,
	completionMarker: '<!-- DONE -->',
	blockedMarker: '<!-- BLOCKED',
	maxIterations: 5,
};

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

describe('resolveTurnOutcome', () => {
	it('continues while the tracker is still running below the iteration limit', () => {
		const trackerPath = writeTracker('## Plan\n- [ ] task 1');

		expect(resolveTurnOutcome({trackerPath, loop: LOOP, iteration: 1})).toEqual(
			{kind: 'continue'},
		);
	});

	it('stops as completed when the tracker ends with the completion marker', () => {
		const trackerPath = writeTracker('## Plan\n- [x] task 1\n<!-- DONE -->');

		expect(resolveTurnOutcome({trackerPath, loop: LOOP, iteration: 2})).toEqual(
			{kind: 'stop', status: 'completed', stopReason: undefined},
		);
	});

	it('suspends as awaiting_attention on a declared block, carrying the reason', () => {
		const trackerPath = writeTracker(
			'## Notes\n<!-- BLOCKED: needs credentials -->',
		);

		expect(resolveTurnOutcome({trackerPath, loop: LOOP, iteration: 2})).toEqual(
			{
				kind: 'suspend',
				status: 'awaiting_attention',
				stopReason: 'agent declared WORKFLOW_BLOCKED: needs credentials',
			},
		);
	});

	it('suspends on a bare declared block, still naming the declaration', () => {
		const trackerPath = writeTracker('## Notes\n<!-- BLOCKED -->');

		expect(resolveTurnOutcome({trackerPath, loop: LOOP, iteration: 2})).toEqual(
			{
				kind: 'suspend',
				status: 'awaiting_attention',
				stopReason: 'agent declared WORKFLOW_BLOCKED',
			},
		);
	});

	it('suspends as awaiting_attention at the iteration ceiling, naming the bound', () => {
		const trackerPath = writeTracker('## Plan\n- [ ] still working');

		const outcome = resolveTurnOutcome({trackerPath, loop: LOOP, iteration: 5});
		expect(outcome.kind).toBe('suspend');
		if (outcome.kind !== 'suspend') return;
		expect(outcome.status).toBe('awaiting_attention');
		// Three bounds funnel into one suspended state; the message must name
		// which one tripped.
		expect(outcome.stopReason).toContain('iteration ceiling');
		expect(outcome.stopReason).toContain('maxIterations');
		expect(outcome.stopReason).toContain('5');
	});

	it('a declared block wins over the iteration ceiling', () => {
		const trackerPath = writeTracker(
			'## Notes\n<!-- BLOCKED: need a decision -->',
		);

		const outcome = resolveTurnOutcome({trackerPath, loop: LOOP, iteration: 5});
		expect(outcome).toMatchObject({
			kind: 'suspend',
			status: 'awaiting_attention',
			stopReason: 'agent declared WORKFLOW_BLOCKED: need a decision',
		});
	});

	it('fails with a human message — never the raw enum — when the tracker is gone', () => {
		const outcome = resolveTurnOutcome({
			trackerPath: '/nonexistent/tracker.md',
			loop: LOOP,
			iteration: 2,
		});

		expect(outcome.kind).toBe('stop');
		if (outcome.kind !== 'stop') return;
		expect(outcome.status).toBe('failed');
		expect(outcome.stopReason).not.toContain('missing_tracker');
		expect(outcome.stopReason).toMatch(/tracker/i);
	});

	it('fails when the runner skeleton was never replaced', () => {
		const trackerPath = writeTracker(
			`${TRACKER_SKELETON_MARKER}\n# Workflow Tracker\nOrientation in progress.`,
		);

		const outcome = resolveTurnOutcome({trackerPath, loop: LOOP, iteration: 2});

		expect(outcome.kind).toBe('stop');
		if (outcome.kind !== 'stop') return;
		expect(outcome.status).toBe('failed');
		expect(outcome.stopReason).toMatch(/skeleton.*never.*replaced/i);
	});

	it('fails when a terminal marker is not the final tracker line', () => {
		const trackerPath = writeTracker(
			['## Summary', 'All done.', '<!-- DONE -->', 'Trailing prose.'].join(
				'\n',
			),
		);

		const outcome = resolveTurnOutcome({trackerPath, loop: LOOP, iteration: 2});

		expect(outcome.kind).toBe('stop');
		if (outcome.kind !== 'stop') return;
		expect(outcome.status).toBe('failed');
		expect(outcome.stopReason).toContain('final non-empty line');
	});

	it('prioritises a missing tracker over every tracker-content signal', () => {
		// Even at the iteration limit, a vanished tracker is the failure reported.
		const outcome = resolveTurnOutcome({
			trackerPath: '/nonexistent/tracker.md',
			loop: LOOP,
			iteration: 5,
		});

		expect(outcome).toMatchObject({status: 'failed'});
	});
});
