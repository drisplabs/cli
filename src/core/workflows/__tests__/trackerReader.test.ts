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
	demoteTerminalMarkers,
	estimateTokenCount,
	buildTrackerSizeNudgeSuffix,
	DEFAULT_TRACKER_TOKEN_BOUND,
	parseUnitTable,
	parseUnitRecordFrontmatter,
	projectTrackerTasks,
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

describe('demoteTerminalMarkers', () => {
	it('rewrites a completion marker into an inert note', () => {
		const out = demoteTerminalMarkers('work\n\n<!-- WORKFLOW_COMPLETE -->\n');
		expect(out).not.toContain('<!-- WORKFLOW_COMPLETE -->');
		expect(out).toContain('Prior Run ended: complete');
		expect(out).toContain('work');
	});

	it('carries a blocked marker reason into the note', () => {
		const out = demoteTerminalMarkers(
			'work\n<!-- WORKFLOW_BLOCKED: need the API key -->\n',
		);
		expect(out).not.toContain('WORKFLOW_BLOCKED:');
		expect(out).toContain('need the API key');
	});

	it('leaves marker-like text inside prose alone', () => {
		const prose = 'Write `<!-- WORKFLOW_COMPLETE -->` when the work is done.';
		expect(demoteTerminalMarkers(prose)).toBe(prose);
	});

	it('demotes a marker wherever it sits, not just the last line', () => {
		const out = demoteTerminalMarkers(
			'<!-- WORKFLOW_COMPLETE -->\nmore work below\n',
		);
		expect(out).not.toContain('<!-- WORKFLOW_COMPLETE -->');
		expect(out).toContain('more work below');
	});

	it('honours configured markers', () => {
		const out = demoteTerminalMarkers('done\n<!-- ALL_DONE -->\n', {
			completionMarker: '<!-- ALL_DONE -->',
		});
		expect(out).not.toContain('<!-- ALL_DONE -->');
		expect(out).toContain('Prior Run ended: complete');
	});

	it('leaves a Tracker with no markers untouched', () => {
		const content = '# Workflow Tracker\n\nstill working\n';
		expect(demoteTerminalMarkers(content)).toBe(content);
	});
});

describe('estimateTokenCount', () => {
	it('estimates roughly 4 characters per token', () => {
		expect(estimateTokenCount('a'.repeat(4000))).toBe(1000);
	});

	it('rounds up a partial token', () => {
		expect(estimateTokenCount('abc')).toBe(1);
	});

	it('returns 0 for empty content', () => {
		expect(estimateTokenCount('')).toBe(0);
	});

	it('matches the ADR 0015 §3 shed backstop at ~32,000 characters', () => {
		expect(DEFAULT_TRACKER_TOKEN_BOUND).toBe(8000);
		expect(estimateTokenCount('a'.repeat(32_000))).toBe(
			DEFAULT_TRACKER_TOKEN_BOUND,
		);
	});
});

describe('buildTrackerSizeNudgeSuffix', () => {
	it('names the configured tracker path', () => {
		const suffix = buildTrackerSizeNudgeSuffix('.athena/abc/tracker.md');
		expect(suffix).toContain('.athena/abc/tracker.md');
	});

	it('falls back to a generic name when no path is given', () => {
		const suffix = buildTrackerSizeNudgeSuffix(undefined);
		expect(suffix).toContain('the tracker');
	});

	it('frames the suffix as a nudge, never a requirement', () => {
		const suffix = buildTrackerSizeNudgeSuffix('tracker.md');
		expect(suffix).toContain('nudge');
		expect(suffix).toContain('ADR 0015 §3');
	});
});

describe('parseUnitTable', () => {
	it('returns null when the ## Units heading is absent', () => {
		expect(parseUnitTable('# Workflow Tracker\n\nno units here\n')).toBeNull();
	});

	it('returns null when the heading has no table beneath it', () => {
		const content = ['## Units', '', 'Nothing shed yet.'].join('\n');
		expect(parseUnitTable(content)).toBeNull();
	});

	it('returns null when only a header row follows, with no separator', () => {
		const content = ['## Units', '', '| Unit | Record |'].join('\n');
		expect(parseUnitTable(content)).toBeNull();
	});

	it('parses a well-formed two-column table', () => {
		const content = [
			'## Units',
			'',
			'| Unit | Record |',
			'| --- | --- |',
			'| Add the size nudge | units/size-nudge.md |',
			'| Wire up task projection | units/task-projection.md |',
		].join('\n');

		expect(parseUnitTable(content)).toEqual([
			{label: 'Add the size nudge', recordPath: 'units/size-nudge.md'},
			{
				label: 'Wire up task projection',
				recordPath: 'units/task-projection.md',
			},
		]);
	});

	it('skips a malformed row without failing the whole table', () => {
		const content = [
			'## Units',
			'',
			'| Unit | Record |',
			'| --- | --- |',
			'| Good row | units/good.md |',
			'| Missing a cell |',
			'| Too | Many | Cells |',
			'| | units/empty-label.md |',
		].join('\n');

		expect(parseUnitTable(content)).toEqual([
			{label: 'Good row', recordPath: 'units/good.md'},
		]);
	});

	it('tolerates leading/trailing pipes and extra blank lines before the table', () => {
		const content = [
			'## Units',
			'',
			'',
			'| Unit | Record |',
			'|---|---|',
			'|Shed unit|units/shed.md|',
		].join('\n');

		expect(parseUnitTable(content)).toEqual([
			{label: 'Shed unit', recordPath: 'units/shed.md'},
		]);
	});
});

describe('parseUnitRecordFrontmatter', () => {
	it('returns null when there is no frontmatter block', () => {
		expect(parseUnitRecordFrontmatter('# Just prose\n\nno frontmatter')).toBe(
			null,
		);
	});

	it('parses an open status', () => {
		const content = ['---', 'status: open', '---', '', 'Unit body.'].join('\n');
		expect(parseUnitRecordFrontmatter(content)).toEqual({status: 'open'});
	});

	it('parses a closed status', () => {
		const content = ['---', 'status: closed', '---', ''].join('\n');
		expect(parseUnitRecordFrontmatter(content)).toEqual({status: 'closed'});
	});

	it('is case-insensitive on the status value', () => {
		const content = ['---', 'status: OPEN', '---', ''].join('\n');
		expect(parseUnitRecordFrontmatter(content)).toEqual({status: 'open'});
	});

	it('ignores an unrecognized status value', () => {
		const content = ['---', 'status: in_progress', '---', ''].join('\n');
		expect(parseUnitRecordFrontmatter(content)).toBeNull();
	});

	it('returns null when the status key is missing', () => {
		const content = ['---', 'gates: []', '---', ''].join('\n');
		expect(parseUnitRecordFrontmatter(content)).toBeNull();
	});

	it('tolerates an unrelated gates block alongside a valid status', () => {
		const content = ['---', 'status: closed', 'gates: []', '---', ''].join(
			'\n',
		);
		expect(parseUnitRecordFrontmatter(content)).toEqual({status: 'closed'});
	});
});

describe('projectTrackerTasks', () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, {recursive: true, force: true});
		}
	});

	function makeDossier(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-dossier-'));
		tempDirs.push(dir);
		fs.mkdirSync(path.join(dir, 'units'));
		return dir;
	}

	it('returns null when the tracker file is unreadable', () => {
		expect(projectTrackerTasks('/nonexistent/tracker.md')).toBeNull();
	});

	it('returns null when the tracker has no unit table', () => {
		const dir = makeDossier();
		const trackerPath = path.join(dir, 'tracker.md');
		fs.writeFileSync(trackerPath, '# Workflow Tracker\n\nNo units yet.\n');

		expect(projectTrackerTasks(trackerPath)).toBeNull();
	});

	it('projects an open and a closed unit into pending/completed tasks', () => {
		const dir = makeDossier();
		const trackerPath = path.join(dir, 'tracker.md');
		fs.writeFileSync(
			trackerPath,
			[
				'# Workflow Tracker',
				'',
				'## Units',
				'',
				'| Unit | Record |',
				'| --- | --- |',
				'| First unit | units/first-unit.md |',
				'| Second unit | units/second-unit.md |',
			].join('\n'),
		);
		fs.writeFileSync(
			path.join(dir, 'units', 'first-unit.md'),
			['---', 'status: closed', '---', '', 'Done.'].join('\n'),
		);
		fs.writeFileSync(
			path.join(dir, 'units', 'second-unit.md'),
			['---', 'status: open', '---', '', 'Still going.'].join('\n'),
		);

		expect(projectTrackerTasks(trackerPath)).toEqual([
			{taskId: 'first-unit', content: 'First unit', status: 'completed'},
			{taskId: 'second-unit', content: 'Second unit', status: 'pending'},
		]);
	});

	it('skips a row whose record file is missing, without failing the rest', () => {
		const dir = makeDossier();
		const trackerPath = path.join(dir, 'tracker.md');
		fs.writeFileSync(
			trackerPath,
			[
				'# Workflow Tracker',
				'',
				'## Units',
				'',
				'| Unit | Record |',
				'| --- | --- |',
				'| Missing record | units/missing.md |',
				'| Present record | units/present.md |',
			].join('\n'),
		);
		fs.writeFileSync(
			path.join(dir, 'units', 'present.md'),
			['---', 'status: open', '---', ''].join('\n'),
		);

		expect(projectTrackerTasks(trackerPath)).toEqual([
			{taskId: 'present', content: 'Present record', status: 'pending'},
		]);
	});

	it('skips a row whose record has malformed frontmatter, without failing the rest', () => {
		const dir = makeDossier();
		const trackerPath = path.join(dir, 'tracker.md');
		fs.writeFileSync(
			trackerPath,
			[
				'# Workflow Tracker',
				'',
				'## Units',
				'',
				'| Unit | Record |',
				'| --- | --- |',
				'| Bad record | units/bad.md |',
				'| Good record | units/good.md |',
			].join('\n'),
		);
		fs.writeFileSync(path.join(dir, 'units', 'bad.md'), 'no frontmatter here');
		fs.writeFileSync(
			path.join(dir, 'units', 'good.md'),
			['---', 'status: closed', '---', ''].join('\n'),
		);

		expect(projectTrackerTasks(trackerPath)).toEqual([
			{taskId: 'good', content: 'Good record', status: 'completed'},
		]);
	});

	it('returns an empty array, not null, when the table exists but every row is unusable', () => {
		const dir = makeDossier();
		const trackerPath = path.join(dir, 'tracker.md');
		fs.writeFileSync(
			trackerPath,
			[
				'# Workflow Tracker',
				'',
				'## Units',
				'',
				'| Unit | Record |',
				'| --- | --- |',
				'| Missing record | units/missing.md |',
			].join('\n'),
		);

		expect(projectTrackerTasks(trackerPath)).toEqual([]);
	});
});
