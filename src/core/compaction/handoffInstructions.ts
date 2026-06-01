/**
 * Handoff-style compact instructions.
 *
 * Athena spawns coding agents headlessly; when a long session compacts, the
 * default summary is generic. These instructions steer compaction toward a
 * handoff document so a fresh agent (or the same one, post-compaction) can pick
 * up the work cleanly.
 *
 * The text is adapted from the matt-pocock-skills `handoff` skill. The original
 * skill writes a handoff *file*; for in-context compaction we drop the
 * "save to a temp directory" step — the summary itself is the handoff.
 *
 * Two shapes, because the two harnesses consume them differently:
 *   - Claude Code's PreCompact hook *augments* the built-in summarizer, so it
 *     wants an instruction snippet (HANDOFF_COMPACT_INSTRUCTIONS).
 *   - Codex's `compact_prompt` *replaces* the summarization prompt, so it wants
 *     a complete standalone prompt (HANDOFF_COMPACT_PROMPT).
 */

/**
 * Augmenting instructions for Claude Code's PreCompact hook. The hook's stdout
 * (on exit 0) is appended to Claude's built-in compaction instructions.
 */
export const HANDOFF_COMPACT_INSTRUCTIONS = `Compact this conversation into a handoff summary so a fresh agent can continue the work without re-reading the history. Preserve:
- The current task and goal, and where it stands right now.
- Decisions already made (and why) and any open questions still to resolve.
- Files and locations touched, referenced by path — do not paste file contents.
- A "Suggested next steps / skills" section naming what to do or invoke next.

Reference existing artifacts (PRDs, plans, ADRs, issues, commits, diffs) by path or URL instead of duplicating their content. Redact secrets — API keys, passwords, tokens, or personally identifiable information.`;

/**
 * Standalone prompt for Codex's `compact_prompt` config key, which replaces the
 * summarization prompt entirely (so this restates the summarization task in
 * full rather than appending to it).
 */
export const HANDOFF_COMPACT_PROMPT = `Summarize the conversation so far as a handoff document that lets a fresh agent continue the work without re-reading the history.

Include:
- The current task and goal, and its present status.
- Decisions already made (with rationale) and any open questions still to resolve.
- Files and locations touched, referenced by path — do not reproduce file contents.
- A "Suggested next steps / skills" section naming what to do or invoke next.

Reference existing artifacts (PRDs, plans, ADRs, issues, commits, diffs) by path or URL rather than duplicating them. Redact any sensitive information such as API keys, passwords, tokens, or personally identifiable information.`;
