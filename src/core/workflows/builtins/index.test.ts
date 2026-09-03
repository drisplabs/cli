import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
	DEFAULT_NEEDS_HUMAN_MARKER,
	DEFAULT_COMPLETION_MARKER,
} from '../journalReader';
import {resolveBuiltinWorkflow} from './index';

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-builtins-'));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

describe('resolveBuiltinWorkflow', () => {
	it('uses the same terminal markers as the shared loop protocol', () => {
		const homeDir = makeTempDir();
		vi.spyOn(os, 'homedir').mockReturnValue(homeDir);

		const workflow = resolveBuiltinWorkflow('default');

		expect(workflow?.loop?.completionMarker).toBe(DEFAULT_COMPLETION_MARKER);
		expect(workflow?.loop?.needsHumanMarker).toBe(DEFAULT_NEEDS_HUMAN_MARKER);
		expect(workflow?.workflowFile).toBeDefined();

		const prompt = fs.readFileSync(workflow!.workflowFile!, 'utf-8');
		expect(prompt).toContain(DEFAULT_COMPLETION_MARKER);
		expect(prompt).toContain(`${DEFAULT_NEEDS_HUMAN_MARKER} -->`);
		expect(prompt).toContain(`${DEFAULT_NEEDS_HUMAN_MARKER}: reason -->`);
		expect(prompt).toContain('final non-empty line of the journal file');
		expect(prompt).toContain(
			'Do not write any journal content after the terminal marker',
		);
		expect(prompt).not.toContain('TASK_COMPLETE');
		expect(prompt).not.toContain('TASK_BLOCKED');
	});
});
