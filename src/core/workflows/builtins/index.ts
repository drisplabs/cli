/**
 * Built-in workflows bundled with the CLI.
 *
 * Workflow configs are inlined so they survive tsup bundling (no runtime
 * file reads from __dirname needed). The registry falls back here when a
 * name isn't found in the user's installed registry.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {ResolvedWorkflowConfig} from '../types';
import {
	DEFAULT_NEEDS_HUMAN_MARKER,
	DEFAULT_COMPLETION_MARKER,
} from '../journalReader';

const DEFAULT_NEEDS_HUMAN_CLOSED_MARKER = `${DEFAULT_NEEDS_HUMAN_MARKER} -->`;
const DEFAULT_NEEDS_HUMAN_REASON_MARKER = `${DEFAULT_NEEDS_HUMAN_MARKER}: reason -->`;

const SYSTEM_PROMPT = `You are working on a long-horizon task managed by Athena. A journal file is used to persist progress across sessions.

## Journal File

At the start of each session, read the journal file if it exists. It contains the task plan, completed steps, and current status from prior sessions.

If no journal file exists, create one by:
1. Analyzing the user's request to understand the full scope
2. Breaking the task into concrete, actionable steps
3. Writing the plan to the journal file

### Journal Format

Use this markdown format for the journal:

\`\`\`
# Task: <one-line summary>

## Plan
- [x] Step 1 description
- [x] Step 2 description
- [ ] Step 3 description (current)
- [ ] Step 4 description

## Current Status
<brief description of where things stand and what to do next>

## Notes
<any important context, decisions, or blockers discovered along the way>
\`\`\`

### Updating the Journal

After completing meaningful work, update the journal:
- Check off completed steps
- Update the current status section
- Add any important notes or decisions

### Completion

When all steps are complete:
1. Update the journal with all steps checked off
2. Put any final summary or outcome notes above the terminal marker
3. Add \`${DEFAULT_COMPLETION_MARKER}\` as the final non-empty line of the journal file
4. Do not write any journal content after the terminal marker

### Needs a human

If you cannot proceed without a person — a question only they can answer, or an external blocker only they can clear:
1. Document what you need from them in the Notes section
2. Explain what needs to happen to unblock the task whenever possible above the terminal marker
3. Add \`${DEFAULT_NEEDS_HUMAN_CLOSED_MARKER}\` or \`${DEFAULT_NEEDS_HUMAN_REASON_MARKER}\` as the final non-empty line of the journal file
4. Do not write any journal content after the terminal marker
`;

function ensureSystemPromptFile(): string {
	const dir = path.join(
		os.homedir(),
		'.config',
		'athena',
		'builtins',
		'default',
	);
	const filePath = path.join(dir, 'system_prompt.md');

	if (
		!fs.existsSync(filePath) ||
		fs.readFileSync(filePath, 'utf-8') !== SYSTEM_PROMPT
	) {
		fs.mkdirSync(dir, {recursive: true});
		fs.writeFileSync(filePath, SYSTEM_PROMPT, 'utf-8');
	}

	return filePath;
}

/**
 * Resolve a built-in workflow by name.
 * Returns undefined if the name doesn't match a built-in.
 */
export function resolveBuiltinWorkflow(
	name: string,
): ResolvedWorkflowConfig | undefined {
	if (name !== 'default') {
		return undefined;
	}

	return {
		name: 'default',
		description:
			'General-purpose workflow for long-horizon tasks — breaks work into steps, tracks progress across sessions, and loops until complete',
		promptTemplate: '{input}',
		loop: {
			enabled: true,
			completionMarker: DEFAULT_COMPLETION_MARKER,
			needsHumanMarker: DEFAULT_NEEDS_HUMAN_MARKER,
			maxIterations: 20,
		},
		plugins: [],
		workflowFile: ensureSystemPromptFile(),
	};
}

/**
 * List all built-in workflow names.
 */
export function listBuiltinWorkflows(): string[] {
	return ['default'];
}
