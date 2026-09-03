import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {resolveTurnOutcome} from './terminalOutcome';
import {
	JOURNAL_SKELETON_MARKER,
	LEGACY_TRACKER_SKELETON_MARKER,
} from './journalReader';
import type {LoopConfig} from './types';

const tempDirs: string[] = [];

function writeJournal(content: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-outcome-'));
	tempDirs.push(dir);
	const journalPath = path.join(dir, 'journal.md');
	fs.writeFileSync(journalPath, content, 'utf-8');
	return journalPath;
}

const LOOP: LoopConfig = {
	enabled: true,
	completionMarker: '<!-- DONE -->',
	needsHumanMarker: '<!-- BLOCKED',
	maxIterations: 5,
};

const DEFAULT_LOOP: LoopConfig = {enabled: true, maxIterations: 5};

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

describe('resolveTurnOutcome', () => {
	it('continues while the journal is still running below the iteration limit', () => {
		const journalPath = writeJournal('## Plan\n- [ ] task 1');

		expect(resolveTurnOutcome({journalPath, loop: LOOP, iteration: 1})).toEqual(
			{kind: 'continue'},
		);
	});

	it('stops as completed when the journal ends with the completion marker', () => {
		const journalPath = writeJournal('## Plan\n- [x] task 1\n<!-- DONE -->');

		expect(resolveTurnOutcome({journalPath, loop: LOOP, iteration: 2})).toEqual(
			{kind: 'stop', status: 'completed', stopReason: undefined},
		);
	});

	it('suspends as awaiting_attention on a declared need for a human, carrying the reason', () => {
		const journalPath = writeJournal(
			'## Notes\n<!-- BLOCKED: needs credentials -->',
		);

		expect(resolveTurnOutcome({journalPath, loop: LOOP, iteration: 2})).toEqual(
			{
				kind: 'suspend',
				status: 'awaiting_attention',
				stopReason: 'agent declared NEEDS_HUMAN: needs credentials',
			},
		);
	});

	it('suspends on a bare declaration, still naming it', () => {
		const journalPath = writeJournal('## Notes\n<!-- BLOCKED -->');

		expect(resolveTurnOutcome({journalPath, loop: LOOP, iteration: 2})).toEqual(
			{
				kind: 'suspend',
				status: 'awaiting_attention',
				stopReason: 'agent declared NEEDS_HUMAN',
			},
		);
	});

	describe('the NEEDS_HUMAN marker and its deprecated WORKFLOW_BLOCKED spelling', () => {
		it('NEEDS_HUMAN is the default marker and suspends with no deprecation', () => {
			const journalPath = writeJournal(
				'## Notes\n<!-- NEEDS_HUMAN: which env? -->',
			);

			expect(
				resolveTurnOutcome({journalPath, loop: DEFAULT_LOOP, iteration: 2}),
			).toEqual({
				kind: 'suspend',
				status: 'awaiting_attention',
				stopReason: 'agent declared NEEDS_HUMAN: which env?',
			});
		});

		it('the legacy WORKFLOW_BLOCKED marker reaches the same terminal outcome and carries a deprecation', () => {
			const legacyPath = writeJournal(
				'## Notes\n<!-- WORKFLOW_BLOCKED: which env? -->',
			);
			const newPath = writeJournal(
				'## Notes\n<!-- NEEDS_HUMAN: which env? -->',
			);

			const legacy = resolveTurnOutcome({
				journalPath: legacyPath,
				loop: DEFAULT_LOOP,
				iteration: 2,
			});
			const current = resolveTurnOutcome({
				journalPath: newPath,
				loop: DEFAULT_LOOP,
				iteration: 2,
			});

			expect(legacy.kind).toBe('suspend');
			if (legacy.kind !== 'suspend') return;
			// Same status, same human message — the marker spelling is the only
			// difference, and it is reported, not silently accepted.
			expect({...legacy, deprecation: undefined}).toEqual(current);
			expect(legacy.deprecation).toContain('WORKFLOW_BLOCKED');
			expect(legacy.deprecation).toContain('NEEDS_HUMAN');
			expect(legacy.deprecation).toContain('0.7.0');
			expect(current).not.toHaveProperty('deprecation');
		});

		it('the deprecation still surfaces when the legacy marker beats the iteration ceiling', () => {
			const journalPath = writeJournal(
				'## Notes\n<!-- WORKFLOW_BLOCKED: need a decision -->',
			);

			const outcome = resolveTurnOutcome({
				journalPath,
				loop: DEFAULT_LOOP,
				iteration: 5,
			});
			expect(outcome).toMatchObject({
				kind: 'suspend',
				status: 'awaiting_attention',
				stopReason: 'agent declared NEEDS_HUMAN: need a decision',
			});
			expect(outcome).toHaveProperty('deprecation');
		});
	});

	it('suspends as awaiting_attention at the iteration ceiling, naming the bound', () => {
		const journalPath = writeJournal('## Plan\n- [ ] still working');

		const outcome = resolveTurnOutcome({journalPath, loop: LOOP, iteration: 5});
		expect(outcome.kind).toBe('suspend');
		if (outcome.kind !== 'suspend') return;
		expect(outcome.status).toBe('awaiting_attention');
		// Three bounds funnel into one suspended state; the message must name
		// which one tripped.
		expect(outcome.stopReason).toContain('iteration ceiling');
		expect(outcome.stopReason).toContain('maxIterations');
		expect(outcome.stopReason).toContain('5');
	});

	it('a declared need for a human wins over the iteration ceiling', () => {
		const journalPath = writeJournal(
			'## Notes\n<!-- BLOCKED: need a decision -->',
		);

		const outcome = resolveTurnOutcome({journalPath, loop: LOOP, iteration: 5});
		expect(outcome).toMatchObject({
			kind: 'suspend',
			status: 'awaiting_attention',
			stopReason: 'agent declared NEEDS_HUMAN: need a decision',
		});
	});

	it('fails with a human message — never the raw enum — when the journal is gone', () => {
		const outcome = resolveTurnOutcome({
			journalPath: '/nonexistent/journal.md',
			loop: LOOP,
			iteration: 2,
		});

		expect(outcome.kind).toBe('stop');
		if (outcome.kind !== 'stop') return;
		expect(outcome.status).toBe('failed');
		expect(outcome.stopReason).not.toContain('missing_journal');
		expect(outcome.stopReason).not.toContain('missing_tracker');
		expect(outcome.stopReason).toMatch(/journal/i);
	});

	it('continues on an untouched skeleton — an undeclared stop, handled by the Nudge path', () => {
		// The common live shape: the agent answered a trivial ask in chat before
		// any tool work. That is a premature stop (ADR 0014 §3), not a terminal
		// bootstrap failure; the Nudge cap bounds a genuinely broken bootstrap
		// because the journal content never advances.
		const journalPath = writeJournal(
			`${JOURNAL_SKELETON_MARKER}\n# Workflow Journal\nOrientation in progress.`,
		);

		expect(resolveTurnOutcome({journalPath, loop: LOOP, iteration: 2})).toEqual(
			{kind: 'continue'},
		);
	});

	it('treats the legacy TRACKER_SKELETON sentinel exactly like the journal skeleton', () => {
		const journalPath = writeJournal(
			`${LEGACY_TRACKER_SKELETON_MARKER}\n# Workflow Tracker\nOrientation in progress.`,
		);

		expect(resolveTurnOutcome({journalPath, loop: LOOP, iteration: 2})).toEqual(
			{kind: 'continue'},
		);
	});

	it('fails when a terminal marker is not the final journal line', () => {
		const journalPath = writeJournal(
			['## Summary', 'All done.', '<!-- DONE -->', 'Trailing prose.'].join(
				'\n',
			),
		);

		const outcome = resolveTurnOutcome({journalPath, loop: LOOP, iteration: 2});

		expect(outcome.kind).toBe('stop');
		if (outcome.kind !== 'stop') return;
		expect(outcome.status).toBe('failed');
		expect(outcome.stopReason).toContain('final non-empty line');
	});

	it('prioritises a missing journal over every journal-content signal', () => {
		// Even at the iteration limit, a vanished journal is the failure reported.
		const outcome = resolveTurnOutcome({
			journalPath: '/nonexistent/journal.md',
			loop: LOOP,
			iteration: 5,
		});

		expect(outcome).toMatchObject({status: 'failed'});
	});
});
