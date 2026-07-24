/**
 * First-party `handoff` skill (ADR 0014).
 *
 * The Handover model needs an invocable skill that distills the live
 * conversation into a durable **Handoff file** on disk — runnable inside a
 * forked Agent Session at compaction time. This module owns that skill's
 * content and materializes it as a Claude Code plugin directory so it rides
 * the existing plugin-delivery path (`--plugin-dir`) into every Workflow
 * Run's Agent Session.
 *
 * Contrast `core/compaction/handoffInstructions.ts`, which only steers the
 * vendor's in-place compaction summary; this skill writes a file. It is
 * Athena-owned — no runtime dependency on the external third-party skill it
 * was originally inspired by.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Default Handoff file path, relative to the working directory, used when the
 * invocation does not name one. The Handover orchestrator always passes an
 * explicit absolute path; the default keeps ad-hoc invocations predictable.
 */
export const DEFAULT_HANDOFF_FILE_PATH = '.athena/handoff.md';

const PLUGIN_MANIFEST = `{
	"name": "athena-handoff",
	"description": "Athena's first-party handoff skill: distill the current conversation into a Handoff file",
	"version": "1.0.0"
}
`;

const SKILL_CONTENT = `---
name: handoff
description: Distill the current conversation into a Handoff file on disk so a fresh agent session can continue the work without re-reading the history. Use when asked to hand off, or before context is reset.
argument-hint: '[output-path] — where to write the Handoff file (default: ${DEFAULT_HANDOFF_FILE_PATH})'
user-invocable: false
---

# Handoff

Write a **Handoff file**: a distillation of this conversation that lets a fresh
agent session — with none of your context — continue the work seamlessly.

## Output path

Write the file to: \`$ARGUMENTS\`

If no path was provided above (it reads "(none provided)"), write to
\`${DEFAULT_HANDOFF_FILE_PATH}\` relative to the current working directory.
Create parent directories as needed. Overwrite an existing file at that path.

## What the file must contain

Structure the Handoff file with these sections, in this order:

1. **Task and status** — what we are trying to accomplish, and exactly where it
   stands right now: what is done and verified, what is in flight, what has not
   been started. Include the concrete state of any in-flight step (e.g. "test X
   written but failing on Y").
2. **Decisions and rationale** — every decision already made, each with the
   *why*. A fresh session that doesn't know why a decision was made will
   re-litigate it and may silently reverse it.
3. **Open questions** — anything unresolved, ambiguous, or awaiting an answer,
   including from whom or where the answer should come.
4. **Files touched** — every file read, written, or relevant, referenced **by
   path** (repo-relative where possible). Never paste file contents — the next
   session can read the files itself.
5. **Suggested next steps / skills** — what the next session should do first,
   and which skills, commands, or workflows to invoke for it.

## Rules

- **Reference, don't duplicate.** Point to existing artifacts — PRDs, plans,
  ADRs, issues, PRs, commits, diffs, trackers — by path or URL instead of
  copying their content into the Handoff file.
- **Redact secrets.** Never write API keys, passwords, tokens, credentials, or
  personally identifiable information into the file. Replace any such value
  with \`[REDACTED]\` and, if needed, name where the real value lives (e.g. an
  env var name).
- **Be selective, not exhaustive.** The file is a briefing, not a transcript.
  Everything the next session needs; nothing it can rediscover cheaply.
- After writing the file, reply with only the absolute path of the file you
  wrote — no other prose.
`;

function writeIfChanged(filePath: string, content: string): void {
	if (
		!fs.existsSync(filePath) ||
		fs.readFileSync(filePath, 'utf-8') !== content
	) {
		fs.mkdirSync(path.dirname(filePath), {recursive: true});
		fs.writeFileSync(filePath, content, 'utf-8');
	}
}

/**
 * Materialize the handoff-skill plugin on disk (idempotent) and return its
 * plugin directory, suitable for the plugin-delivery path (`--plugin-dir`).
 *
 * Layout: `<baseDir>/handoff/.claude-plugin/plugin.json` +
 * `<baseDir>/handoff/skills/handoff/SKILL.md`.
 */
export function ensureHandoffSkillPlugin(
	baseDir: string = path.join(os.homedir(), '.config', 'athena', 'builtins'),
): string {
	const pluginDir = path.join(baseDir, 'handoff');
	writeIfChanged(
		path.join(pluginDir, '.claude-plugin', 'plugin.json'),
		PLUGIN_MANIFEST,
	);
	writeIfChanged(
		path.join(pluginDir, 'skills', 'handoff', 'SKILL.md'),
		SKILL_CONTENT,
	);
	return pluginDir;
}
