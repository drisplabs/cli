import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
	parseTrackerState,
	readTracker,
	buildContinuePrompt,
	DEFAULT_TRACKER_PATH,
	TRACKER_SKELETON_MARKER,
} from '../trackerReader';

const DEFAULT_MARKERS = {
	completionMarker: '<!-- E2E_COMPLETE -->',
	blockedMarker: '<!-- E2E_BLOCKED',
};

describe('parseTrackerState', () => {
	it('returns a clean state for empty tracker content', () => {
		const state = parseTrackerState('', DEFAULT_MARKERS);

		expect(state.completed).toBe(false);
		expect(state.blocked).toBe(false);
		expect(state.blockedReason).toBeUndefined();
		expect(state.misplacedTerminalMarker).toBeUndefined();
		expect(state.skeletonNotReplaced).toBe(false);
	});

	it('detects a completion marker on the last non-empty line', () => {
		const state = parseTrackerState(
			[
				'# E2E Test Tracker',
				'## Steps',
				'| 1 | Analyze | done |',
				'<!-- E2E_COMPLETE -->',
			].join('\n'),
			DEFAULT_MARKERS,
		);

		expect(state.completed).toBe(true);
	});

	it('ignores completion marker text unless it is the last non-empty line', () => {
		const state = parseTrackerState(
			[
				'# E2E Test Tracker',
				'Do not write <!-- E2E_COMPLETE --> until verification passes.',
				'## Steps',
				'- still running',
			].join('\n'),
			DEFAULT_MARKERS,
		);

		expect(state.completed).toBe(false);
	});

	it('flags a standalone completion marker with trailing tracker content', () => {
		const state = parseTrackerState(
			[
				'# E2E Test Tracker',
				'## Summary',
				'Done and verified.',
				'<!-- E2E_COMPLETE -->',
				'Final summary accidentally written after the marker.',
			].join('\n'),
			DEFAULT_MARKERS,
		);

		expect(state.completed).toBe(false);
		expect(state.misplacedTerminalMarker).toBe('<!-- E2E_COMPLETE -->');
	});

	it('uses the default WORKFLOW_COMPLETE marker when none specified', () => {
		expect(parseTrackerState('<!-- WORKFLOW_COMPLETE -->').completed).toBe(
			true,
		);
	});

	it('uses the default WORKFLOW_BLOCKED marker when none specified', () => {
		const state = parseTrackerState(
			'<!-- WORKFLOW_BLOCKED: browser unavailable -->',
		);

		expect(state.blocked).toBe(true);
		expect(state.blockedReason).toBe('browser unavailable');
	});

	it('detects a blocked marker and extracts its reason', () => {
		const state = parseTrackerState(
			[
				'# E2E Test Tracker',
				'<!-- E2E_BLOCKED: No Playwright config found -->',
			].join('\n'),
			DEFAULT_MARKERS,
		);

		expect(state.blocked).toBe(true);
		expect(state.blockedReason).toBe('No Playwright config found');
	});

	it('accepts a blocked marker without a reason on the last line', () => {
		const state = parseTrackerState(
			[
				'# E2E Test Tracker',
				'## Notes',
				'Waiting on external access.',
				'<!-- E2E_BLOCKED -->',
			].join('\n'),
			DEFAULT_MARKERS,
		);

		expect(state.blocked).toBe(true);
		expect(state.blockedReason).toBeUndefined();
	});

	it('ignores blocked marker text unless it is the last non-empty line', () => {
		const state = parseTrackerState(
			[
				'# E2E Test Tracker',
				'Example marker: <!-- E2E_BLOCKED: placeholder -->',
				'## Steps',
				'- still running',
			].join('\n'),
			DEFAULT_MARKERS,
		);

		expect(state.blocked).toBe(false);
		expect(state.blockedReason).toBeUndefined();
	});

	it('flags a standalone blocked marker with trailing tracker content', () => {
		const state = parseTrackerState(
			[
				'# E2E Test Tracker',
				'Waiting on external access.',
				'<!-- E2E_BLOCKED: No browser access -->',
				'Please retry tomorrow.',
			].join('\n'),
			DEFAULT_MARKERS,
		);

		expect(state.blocked).toBe(false);
		expect(state.misplacedTerminalMarker).toBe(
			'<!-- E2E_BLOCKED: No browser access -->',
		);
	});

	it('reports the runner skeleton as not yet replaced', () => {
		const state = parseTrackerState(
			[
				TRACKER_SKELETON_MARKER,
				'# Workflow Tracker',
				'Orientation in progress.',
			].join('\n'),
			DEFAULT_MARKERS,
		);

		expect(state.skeletonNotReplaced).toBe(true);
	});
});

describe('readTracker', () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, {recursive: true, force: true});
		}
	});

	it('returns the file contents when the tracker exists', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-tracker-'));
		tempDirs.push(dir);
		const trackerPath = path.join(dir, 'tracker.md');
		fs.writeFileSync(trackerPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');

		expect(readTracker(trackerPath)).toBe('<!-- WORKFLOW_COMPLETE -->');
	});

	it('fails open to empty content when the tracker is unreadable', () => {
		expect(readTracker('/nonexistent/tracker.md')).toBe('');
	});
});

describe('buildContinuePrompt', () => {
	it('uses default template with trackerPath substitution', () => {
		const result = buildContinuePrompt({
			enabled: true,
			completionMarker: 'DONE',
			maxIterations: 5,
			trackerPath: 'e2e-tracker.md',
		});
		expect(result).toContain('e2e-tracker.md');
		expect(result).toContain('Continue');
	});

	it('uses custom continuePrompt with {trackerPath} substitution', () => {
		const result = buildContinuePrompt({
			enabled: true,
			completionMarker: 'DONE',
			maxIterations: 5,
			trackerPath: 'my-tracker.md',
			continuePrompt: 'Read {trackerPath} and continue.',
		});
		expect(result).toBe('Read my-tracker.md and continue.');
	});

	it('falls back to default tracker path when trackerPath not specified', () => {
		const result = buildContinuePrompt({
			enabled: true,
			maxIterations: 5,
		});
		expect(result).toContain(DEFAULT_TRACKER_PATH);
	});

	it('reminds the agent that terminal markers must be final', () => {
		const result = buildContinuePrompt({
			enabled: true,
			maxIterations: 5,
		});
		expect(result).toContain('final non-empty line');
		expect(result).toContain('do not write any prose after it');
	});
});
