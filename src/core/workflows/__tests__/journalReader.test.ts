import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
	parseJournalState,
	readJournal,
	buildContinuePrompt,
	DEFAULT_JOURNAL_PATH,
	JOURNAL_SKELETON_MARKER,
	LEGACY_TRACKER_SKELETON_MARKER,
	LEGACY_BLOCKED_MARKER,
	demoteTerminalMarkers,
	insertAboveTerminalMarker,
	estimateTokenCount,
	buildJournalSizeNudgeSuffix,
	DEFAULT_JOURNAL_TOKEN_BOUND,
	parseUnitTable,
	checkShedIntegrity,
	buildShedIntegrityNudgeSuffix,
	parseUnitRecordFrontmatter,
	projectJournalTasks,
} from '../journalReader';

const DEFAULT_MARKERS = {
	completionMarker: '<!-- E2E_COMPLETE -->',
	needsHumanMarker: '<!-- E2E_BLOCKED',
};

describe('parseJournalState', () => {
	it('returns a clean state for empty journal content', () => {
		const state = parseJournalState('', DEFAULT_MARKERS);

		expect(state.completed).toBe(false);
		expect(state.needsHuman).toBe(false);
		expect(state.needsHumanReason).toBeUndefined();
		expect(state.misplacedTerminalMarker).toBeUndefined();
		expect(state.skeletonNotReplaced).toBe(false);
	});

	it('detects a completion marker on the last non-empty line', () => {
		const state = parseJournalState(
			[
				'# E2E Test Journal',
				'## Steps',
				'| 1 | Analyze | done |',
				'<!-- E2E_COMPLETE -->',
			].join('\n'),
			DEFAULT_MARKERS,
		);

		expect(state.completed).toBe(true);
	});

	it('ignores completion marker text unless it is the last non-empty line', () => {
		const state = parseJournalState(
			[
				'# E2E Test Journal',
				'Do not write <!-- E2E_COMPLETE --> until verification passes.',
				'## Steps',
				'- still running',
			].join('\n'),
			DEFAULT_MARKERS,
		);

		expect(state.completed).toBe(false);
	});

	it('flags a standalone completion marker with trailing journal content', () => {
		const state = parseJournalState(
			[
				'# E2E Test Journal',
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
		expect(parseJournalState('<!-- WORKFLOW_COMPLETE -->').completed).toBe(
			true,
		);
	});

	it('uses the default NEEDS_HUMAN marker when none specified', () => {
		const state = parseJournalState(
			'<!-- NEEDS_HUMAN: browser unavailable -->',
		);

		expect(state.needsHuman).toBe(true);
		expect(state.needsHumanReason).toBe('browser unavailable');
		expect(state.deprecatedMarker).toBeUndefined();
	});

	it('still recognises the legacy WORKFLOW_BLOCKED marker and reports it as deprecated', () => {
		const state = parseJournalState(
			'<!-- WORKFLOW_BLOCKED: browser unavailable -->',
		);

		expect(state.needsHuman).toBe(true);
		expect(state.needsHumanReason).toBe('browser unavailable');
		expect(state.deprecatedMarker).toBe(LEGACY_BLOCKED_MARKER);

		const bare = parseJournalState('<!-- WORKFLOW_BLOCKED -->');
		expect(bare.needsHuman).toBe(true);
		expect(bare.needsHumanReason).toBeUndefined();
		expect(bare.deprecatedMarker).toBe(LEGACY_BLOCKED_MARKER);
	});

	it('recognises the canonical NEEDS_HUMAN marker even under a workflow-configured marker', () => {
		// NEEDS_HUMAN is the one way a Turn asks for a person; a workflow's own
		// marker is accepted in addition, never instead.
		const state = parseJournalState(
			'<!-- NEEDS_HUMAN: need the API key -->',
			DEFAULT_MARKERS,
		);

		expect(state.needsHuman).toBe(true);
		expect(state.needsHumanReason).toBe('need the API key');
		expect(state.deprecatedMarker).toBeUndefined();
	});

	it('accepts the legacy blockedMarker config key as an alias for needsHumanMarker', () => {
		const state = parseJournalState('<!-- E2E_BLOCKED: no browser -->', {
			completionMarker: '<!-- E2E_COMPLETE -->',
			blockedMarker: '<!-- E2E_BLOCKED',
		});

		expect(state.needsHuman).toBe(true);
		expect(state.needsHumanReason).toBe('no browser');
	});

	it('detects a blocked marker and extracts its reason', () => {
		const state = parseJournalState(
			[
				'# E2E Test Journal',
				'<!-- E2E_BLOCKED: No Playwright config found -->',
			].join('\n'),
			DEFAULT_MARKERS,
		);

		expect(state.needsHuman).toBe(true);
		expect(state.needsHumanReason).toBe('No Playwright config found');
	});

	it('accepts a blocked marker without a reason on the last line', () => {
		const state = parseJournalState(
			[
				'# E2E Test Journal',
				'## Notes',
				'Waiting on external access.',
				'<!-- E2E_BLOCKED -->',
			].join('\n'),
			DEFAULT_MARKERS,
		);

		expect(state.needsHuman).toBe(true);
		expect(state.needsHumanReason).toBeUndefined();
	});

	it('ignores blocked marker text unless it is the last non-empty line', () => {
		const state = parseJournalState(
			[
				'# E2E Test Journal',
				'Example marker: <!-- E2E_BLOCKED: placeholder -->',
				'## Steps',
				'- still running',
			].join('\n'),
			DEFAULT_MARKERS,
		);

		expect(state.needsHuman).toBe(false);
		expect(state.needsHumanReason).toBeUndefined();
	});

	it('flags a standalone blocked marker with trailing journal content', () => {
		const state = parseJournalState(
			[
				'# E2E Test Journal',
				'Waiting on external access.',
				'<!-- E2E_BLOCKED: No browser access -->',
				'Please retry tomorrow.',
			].join('\n'),
			DEFAULT_MARKERS,
		);

		expect(state.needsHuman).toBe(false);
		expect(state.misplacedTerminalMarker).toBe(
			'<!-- E2E_BLOCKED: No browser access -->',
		);
	});

	it('reports the runner skeleton as not yet replaced', () => {
		const state = parseJournalState(
			[
				JOURNAL_SKELETON_MARKER,
				'# Workflow Journal',
				'Orientation in progress.',
			].join('\n'),
			DEFAULT_MARKERS,
		);

		expect(state.skeletonNotReplaced).toBe(true);
	});

	it('reports the legacy TRACKER_SKELETON sentinel as an unreplaced skeleton too', () => {
		const state = parseJournalState(
			[
				LEGACY_TRACKER_SKELETON_MARKER,
				'# Workflow Tracker',
				'Orientation in progress.',
			].join('\n'),
			DEFAULT_MARKERS,
		);

		expect(state.skeletonNotReplaced).toBe(true);
		expect(LEGACY_TRACKER_SKELETON_MARKER).toBe('<!-- TRACKER_SKELETON -->');
		expect(JOURNAL_SKELETON_MARKER).toBe('<!-- JOURNAL_SKELETON -->');
	});
});

describe('readJournal', () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, {recursive: true, force: true});
		}
	});

	it('returns the file contents when the journal exists', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-journal-'));
		tempDirs.push(dir);
		const journalPath = path.join(dir, 'journal.md');
		fs.writeFileSync(journalPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');

		expect(readJournal(journalPath)).toBe('<!-- WORKFLOW_COMPLETE -->');
	});

	it('fails open to empty content when the journal is unreadable', () => {
		expect(readJournal('/nonexistent/journal.md')).toBe('');
	});
});

describe('buildContinuePrompt', () => {
	it('uses default template with journalPath substitution', () => {
		const result = buildContinuePrompt({
			enabled: true,
			completionMarker: 'DONE',
			maxIterations: 5,
			journalPath: 'e2e-journal.md',
		});
		expect(result).toContain('e2e-journal.md');
		expect(result).toContain('Continue');
	});

	it('uses custom continuePrompt with {journalPath} substitution', () => {
		const result = buildContinuePrompt({
			enabled: true,
			completionMarker: 'DONE',
			maxIterations: 5,
			journalPath: 'my-journal.md',
			continuePrompt: 'Read {journalPath} and continue.',
		});
		expect(result).toBe('Read my-journal.md and continue.');
	});

	it('falls back to default journal path when journalPath not specified', () => {
		const result = buildContinuePrompt({
			enabled: true,
			maxIterations: 5,
		});
		expect(result).toContain(DEFAULT_JOURNAL_PATH);
		expect(DEFAULT_JOURNAL_PATH).toBe('.athena/{sessionId}/journal.md');
	});

	it('honours the legacy trackerPath key and {trackerPath} placeholder for one release', () => {
		const result = buildContinuePrompt({
			enabled: true,
			maxIterations: 5,
			trackerPath: 'legacy-tracker.md',
			continuePrompt: 'Read {trackerPath} (also {journalPath}) and continue.',
		});
		expect(result).toBe(
			'Read legacy-tracker.md (also legacy-tracker.md) and continue.',
		);
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

	it('leaves a Journal with no markers untouched', () => {
		const content = '# Workflow Journal\n\nstill working\n';
		expect(demoteTerminalMarkers(content)).toBe(content);
	});
});

describe('insertAboveTerminalMarker', () => {
	it('appends at the end when the Journal has no terminal marker', () => {
		const out = insertAboveTerminalMarker(
			'# Journal\n\nworking\n',
			'\n## Entry\n',
		);
		expect(out).toBe('# Journal\n\nworking\n\n## Entry\n');
		expect(parseJournalState(out).completed).toBe(false);
	});

	it('keeps a terminal marker as the final non-empty line by inserting above it', () => {
		const out = insertAboveTerminalMarker(
			'# Journal\n\nasked a question\n\n<!-- NEEDS_HUMAN: which env? -->\n',
			'\n## Entry\n',
		);
		const state = parseJournalState(out);
		expect(state.needsHuman).toBe(true);
		expect(state.needsHumanReason).toBe('which env?');
		expect(state.misplacedTerminalMarker).toBeUndefined();
		expect(out.indexOf('## Entry')).toBeLessThan(
			out.indexOf('<!-- NEEDS_HUMAN'),
		);
		expect(out.indexOf('asked a question')).toBeLessThan(
			out.indexOf('## Entry'),
		);
	});

	it('honours configured markers', () => {
		const out = insertAboveTerminalMarker(
			'done\n<!-- ALL_DONE -->\n',
			'\n## Entry\n',
			{completionMarker: '<!-- ALL_DONE -->'},
		);
		expect(
			parseJournalState(out, {completionMarker: '<!-- ALL_DONE -->'}).completed,
		).toBe(true);
		expect(out.indexOf('## Entry')).toBeLessThan(out.indexOf('<!-- ALL_DONE'));
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
		expect(DEFAULT_JOURNAL_TOKEN_BOUND).toBe(8000);
		expect(estimateTokenCount('a'.repeat(32_000))).toBe(
			DEFAULT_JOURNAL_TOKEN_BOUND,
		);
	});
});

describe('buildJournalSizeNudgeSuffix', () => {
	it('names the configured journal path', () => {
		const suffix = buildJournalSizeNudgeSuffix('.athena/abc/journal.md');
		expect(suffix).toContain('.athena/abc/journal.md');
	});

	it('falls back to a generic name when no path is given', () => {
		const suffix = buildJournalSizeNudgeSuffix(undefined);
		expect(suffix).toContain('the journal');
	});

	it('frames the suffix as a nudge, never a requirement', () => {
		const suffix = buildJournalSizeNudgeSuffix('journal.md');
		expect(suffix).toContain('nudge');
		expect(suffix).toContain('ADR 0015 §3');
	});
});

describe('parseUnitTable', () => {
	it('returns null when the ## Units heading is absent', () => {
		expect(parseUnitTable('# Workflow Journal\n\nno units here\n')).toBeNull();
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

describe('checkShedIntegrity (ADR 0018 §7, #214)', () => {
	const JOURNAL = [
		'# Workflow Journal',
		'',
		'## Status',
		'Working on the size nudge.',
		'',
		'## Units',
		'',
		'| Unit | Record |',
		'| --- | --- |',
		'| Add the size nudge | units/size-nudge.md |',
		'',
		'## Design',
		'The journal still carries the design section.',
	].join('\n');

	it('names a unit record with no row in the ## Units table', () => {
		const gaps = checkShedIntegrity(JOURNAL, [
			{
				recordPath: 'units/size-nudge.md',
				content: '---\nstatus: open\n---\n## Build\n',
			},
			{
				recordPath: 'units/orphan.md',
				content: '---\nstatus: closed\n---\n## Contract\n',
			},
		]);
		expect(gaps).toEqual({
			orphanRecords: ['units/orphan.md'],
			sharedHeadings: [],
		});
		const suffix = buildShedIntegrityNudgeSuffix(gaps!);
		expect(suffix).toContain('units/orphan.md');
		expect(suffix).toContain('no row');
		expect(suffix).toContain('cut');
		expect(suffix).toContain('paste');
		expect(suffix).toContain('pointer');
	});

	it('names a ## heading present in both the journal and a unit record', () => {
		const gaps = checkShedIntegrity(JOURNAL, [
			{
				recordPath: 'units/size-nudge.md',
				content:
					'---\nstatus: open\n---\n## Design\nThe design, again.\n## Build\n',
			},
		]);
		expect(gaps).toEqual({
			orphanRecords: [],
			sharedHeadings: [
				{heading: '## Design', recordPath: 'units/size-nudge.md'},
			],
		});
		const suffix = buildShedIntegrityNudgeSuffix(gaps!);
		expect(suffix).toContain('"## Design"');
		expect(suffix).toContain('units/size-nudge.md');
	});

	it('reports both kinds at once, each record once', () => {
		const gaps = checkShedIntegrity(JOURNAL, [
			{recordPath: 'units/orphan.md', content: '## Status\n## Design\n'},
		]);
		expect(gaps).toEqual({
			orphanRecords: ['units/orphan.md'],
			sharedHeadings: [
				{heading: '## Status', recordPath: 'units/orphan.md'},
				{heading: '## Design', recordPath: 'units/orphan.md'},
			],
		});
	});

	it('a clean Dossier yields no nudge', () => {
		expect(
			checkShedIntegrity(JOURNAL, [
				{
					recordPath: 'units/size-nudge.md',
					content: '---\nstatus: open\n---\n## Build\n',
				},
			]),
		).toBeNull();
		expect(checkShedIntegrity(JOURNAL, [])).toBeNull();
	});

	it('matches table rows written with a leading ./ or backslashes', () => {
		const journal = JOURNAL.replace(
			'units/size-nudge.md',
			'./units\\size-nudge.md',
		);
		expect(
			checkShedIntegrity(journal, [
				{recordPath: 'units/size-nudge.md', content: '## Build\n'},
			]),
		).toBeNull();
	});

	it('only level-two headings count', () => {
		expect(
			checkShedIntegrity(JOURNAL, [
				{recordPath: 'units/size-nudge.md', content: '### Design\n# Status\n'},
			]),
		).toBeNull();
	});

	it('a missing ## Units table yields no nudge, whatever the units directory holds', () => {
		expect(
			checkShedIntegrity('# Workflow Journal\n\n## Design\n', [
				{recordPath: 'units/orphan.md', content: '## Design\n'},
			]),
		).toBeNull();
	});

	it('a malformed table yields no nudge', () => {
		const journal = ['## Units', '', '| Unit | Record |', '', '## Design'].join(
			'\n',
		);
		expect(
			checkShedIntegrity(journal, [
				{recordPath: 'units/orphan.md', content: '## Design\n'},
			]),
		).toBeNull();
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

describe('projectJournalTasks', () => {
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

	it('returns null when the journal file is unreadable', () => {
		expect(projectJournalTasks('/nonexistent/journal.md')).toBeNull();
	});

	it('returns null when the journal has no unit table', () => {
		const dir = makeDossier();
		const journalPath = path.join(dir, 'journal.md');
		fs.writeFileSync(journalPath, '# Workflow Journal\n\nNo units yet.\n');

		expect(projectJournalTasks(journalPath)).toBeNull();
	});

	it('projects an open and a closed unit into pending/completed tasks', () => {
		const dir = makeDossier();
		const journalPath = path.join(dir, 'journal.md');
		fs.writeFileSync(
			journalPath,
			[
				'# Workflow Journal',
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

		expect(projectJournalTasks(journalPath)).toEqual([
			{taskId: 'first-unit', content: 'First unit', status: 'completed'},
			{taskId: 'second-unit', content: 'Second unit', status: 'pending'},
		]);
	});

	it('skips a row whose record file is missing, without failing the rest', () => {
		const dir = makeDossier();
		const journalPath = path.join(dir, 'journal.md');
		fs.writeFileSync(
			journalPath,
			[
				'# Workflow Journal',
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

		expect(projectJournalTasks(journalPath)).toEqual([
			{taskId: 'present', content: 'Present record', status: 'pending'},
		]);
	});

	it('skips a row pointing outside the Dossier, without failing the rest', () => {
		const dir = makeDossier();
		const journalPath = path.join(dir, 'journal.md');
		// A record placed OUTSIDE the Dossier, valid in every other respect: if
		// containment were missing it would parse and project.
		const outsidePath = path.join(dir, '..', 'outside-record.md');
		fs.writeFileSync(
			outsidePath,
			['---', 'status: open', '---', ''].join('\n'),
		);
		fs.writeFileSync(
			journalPath,
			[
				'# Workflow Journal',
				'',
				'## Units',
				'',
				'| Unit | Record |',
				'| --- | --- |',
				'| Escaping row | ../outside-record.md |',
				'| Absolute row | ' + outsidePath + ' |',
				'| Present record | units/present.md |',
			].join('\n'),
		);
		fs.writeFileSync(
			path.join(dir, 'units', 'present.md'),
			['---', 'status: open', '---', ''].join('\n'),
		);

		expect(projectJournalTasks(journalPath)).toEqual([
			{taskId: 'present', content: 'Present record', status: 'pending'},
		]);
	});

	it('skips a row whose record has malformed frontmatter, without failing the rest', () => {
		const dir = makeDossier();
		const journalPath = path.join(dir, 'journal.md');
		fs.writeFileSync(
			journalPath,
			[
				'# Workflow Journal',
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

		expect(projectJournalTasks(journalPath)).toEqual([
			{taskId: 'good', content: 'Good record', status: 'completed'},
		]);
	});

	it('returns an empty array, not null, when the table exists but every row is unusable', () => {
		const dir = makeDossier();
		const journalPath = path.join(dir, 'journal.md');
		fs.writeFileSync(
			journalPath,
			[
				'# Workflow Journal',
				'',
				'## Units',
				'',
				'| Unit | Record |',
				'| --- | --- |',
				'| Missing record | units/missing.md |',
			].join('\n'),
		);

		expect(projectJournalTasks(journalPath)).toEqual([]);
	});
});
