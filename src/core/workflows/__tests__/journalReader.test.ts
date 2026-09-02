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
