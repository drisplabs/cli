import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
	DEFAULT_BLOCKED_MARKER,
	DEFAULT_COMPLETION_MARKER,
} from '../trackerReader';
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
		expect(workflow?.loop?.blockedMarker).toBe(DEFAULT_BLOCKED_MARKER);
		expect(workflow?.workflowFile).toBeDefined();

		const prompt = fs.readFileSync(workflow!.workflowFile!, 'utf-8');
		expect(prompt).toContain(DEFAULT_COMPLETION_MARKER);
		expect(prompt).toContain(`${DEFAULT_BLOCKED_MARKER} -->`);
		expect(prompt).toContain(`${DEFAULT_BLOCKED_MARKER}: reason -->`);
		expect(prompt).toContain('final non-empty line of the tracker file');
		expect(prompt).toContain(
			'Do not write any tracker content after the terminal marker',
		);
		expect(prompt).not.toContain('TASK_COMPLETE');
		expect(prompt).not.toContain('TASK_BLOCKED');
	});
});
