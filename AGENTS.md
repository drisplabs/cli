# Agent instructions

Repo-level guidance for AI coding agents (Claude Code, Codex, …). `CLAUDE.md` is a symlink to this file, so Claude Code auto-loads it.

## Agent skills

### Issue tracker

Issues and PRDs live as GitHub issues on `drisplabs/cli` (always pass `--repo drisplabs/cli`). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles map 1:1 to same-named labels on `drisplabs/cli`. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context: `CONTEXT-MAP.md` → `CONTEXT.md` (feed-pipeline) / `UBIQUITOUS_LANGUAGE.md` (workflow-execution) / `KNOWLEDGE_BASE.md` (knowledge-base). See `docs/agents/domain.md`.
