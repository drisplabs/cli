# Issue tracker: GitHub (drisplabs/cli)

Issues and PRDs for this repo live as GitHub issues on **`drisplabs/cli`** (the upstream remote). Use the `gh` CLI for all operations.

This clone has two GitHub remotes — `drisplabs` (upstream, canonical for issues) and `origin` (lespaceman/athena-flow-cli fork). **Always pass `--repo drisplabs/cli` explicitly** so `gh` doesn't fall back to the fork.

## Conventions

- **Create an issue**: `gh issue create --repo drisplabs/cli --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo drisplabs/cli --comments`
- **List issues**: `gh issue list --repo drisplabs/cli --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --repo drisplabs/cli --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo drisplabs/cli --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo drisplabs/cli --comment "..."`

## When a skill says "publish to the issue tracker"

Create a GitHub issue on `drisplabs/cli`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo drisplabs/cli --comments`.
