# Issue tracker: GitHub (drisplabs/cli)

Issues and PRDs for this repo live as GitHub issues on **`drisplabs/cli`** — the canonical upstream, and the single place all work is tracked. Use the `gh` CLI for all operations.

This clone has two GitHub remotes: `origin` → `drisplabs/cli` (upstream — canonical for issues **and** code/PRs) and `lespaceman` → `lespaceman/athena-flow-cli` (a personal fork). `gh` is authenticated as the `lespaceman` account and, with two remotes, can guess the wrong repo — so **always pass `--repo drisplabs/cli` explicitly**.

> Some older feature epics were opened on the `lespaceman` fork. Going forward, everything is tracked on `drisplabs/cli`.

## Conventions

- **Create an issue**: `gh issue create --repo drisplabs/cli --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo drisplabs/cli --comments`
- **List issues**: `gh issue list --repo drisplabs/cli --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with `--label` / `--state` filters as needed.
- **Comment on an issue**: `gh issue comment <number> --repo drisplabs/cli --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo drisplabs/cli --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo drisplabs/cli --comment "..."`

## Closing via PRs

Code and PRs also land on `drisplabs/cli`, so a PR's `Closes #n` auto-closes the issue normally — same repo, no cross-repo manual step.

## When a skill says "publish to the issue tracker"

Create a GitHub issue on `drisplabs/cli`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo drisplabs/cli --comments`.
