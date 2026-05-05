# Drisp CLI

[![npm version](https://img.shields.io/npm/v/@drisp/cli)](https://www.npmjs.com/package/@drisp/cli)
[![license](https://img.shields.io/npm/l/@drisp/cli)](https://github.com/drisplabs/cli/blob/main/LICENSE)
[![CI](https://github.com/drisplabs/cli/actions/workflows/ci.yml/badge.svg)](https://github.com/drisplabs/cli/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@drisp/cli)](https://nodejs.org)

**Deterministic orchestration for non-deterministic agents.**

AI coding agents are getting better at reasoning -- but long-horizon tasks still break. Prompts drift, results vary between runs, and there's no good way to package what worked into something your whole team can reuse. The agent isn't the bottleneck anymore. The harness is.

Athenaflow is a **workflow runtime** for [Claude Code](https://claude.com/product/claude-code) and [OpenAI Codex](https://chatgpt.com/codex). It adds structured workflows, real-time observability, session persistence, and a plugin system -- so agent-driven tasks produce consistent results across runs, teams, and models.

```
npm install -g @drisp/cli && drisp
```

<p align="center">
  <img src="assets/demo.gif" alt="Drisp terminal UI" width="960" />
</p>

> **[Read the docs](https://athenaflow.in/docs)** -- guides, workflow authoring, plugin API, and more.

<br>

## Why Athenaflow?

Coding agents work well for one-off tasks. The moment you need **repeatable, multi-step execution** -- e2e test generation, migration plans, release workflows -- things fall apart:

| Pain point                  | What goes wrong                                                   |
| --------------------------- | ----------------------------------------------------------------- |
| **No reproducibility**      | Same prompt, same model, different output every time              |
| **Long-horizon drift**      | Without checkpoints, agents compound small mistakes into big ones |
| **Prompts aren't portable** | What one developer got working doesn't transfer to the team       |
| **Black-box execution**     | You see the final output, not the 40 tool calls that got there    |
| **CI as an afterthought**   | Most harnesses are built for interactive use, not pipelines       |

Athenaflow introduces a **workflow layer** between you and the underlying harness.
Workflows are declarative, versioned, and shareable -- they define prompt templates,
multi-session loops with completion tracking, plugin bundles, isolation policies,
and model preferences. The runtime handles the rest.

**Workflows encode what works** -- not just a prompt, but the loop logic, progress tracking, and tool config that make it reliable. Define once, run anywhere.

**A marketplace for agent workflows** -- browse, install, and update community-built workflows like packages.

**Real-time observability** -- a live terminal feed of every tool call, permission decision, and result as it happens.

**Sessions persist and resume** -- every run is saved to SQLite. Pick up where you left off with full state.

**Harness-agnostic** -- same workflows, same UI, same session model across Claude Code and Codex.

**CI-native** -- `drisp exec` runs headlessly with safe defaults, JSONL output, and structured exit codes.

<br>

## Get Started

**1. Install** -- requires Node.js 20+ and at least one harness (`claude` or `codex`) on your PATH.

```bash
npm install -g @drisp/cli
```

**2. Run** -- the setup wizard handles theme, harness verification, and your first workflow.

```bash
drisp
```

**3. Explore**

```bash
drisp resume                              # Pick up where you left off
drisp sessions                            # Browse past sessions
drisp workflow install e2e-test-builder   # Install a workflow from the marketplace
```

> **[Full walkthrough](https://athenaflow.in/docs)**

<br>

## Harnesses

| Harness                                   | Status    | Integration                                    |
| ----------------------------------------- | --------- | ---------------------------------------------- |
| Claude Code                               | Supported | Hook events forwarded over a local Unix socket |
| [OpenAI Codex](https://chatgpt.com/codex) | Supported | Integrated via `codex app-server` protocol     |
| opencode                                  | Planned   | Adapter placeholder; not yet enabled           |

<br>

## Workflows

Workflows package prompt templates, loop strategies, plugin dependencies, isolation policies, and model config into a single portable unit. Anyone can author and share them.

```bash
drisp workflow list                        # See what's installed
drisp workflow search                      # Browse available workflows
drisp workflow install e2e-test-builder    # Install from the marketplace
drisp workflow use e2e-test-builder        # Set as the active workflow
drisp workflow upgrade                     # Re-sync all from source
```

Manage marketplace sources:

```bash
drisp marketplace add owner/repo           # Add a marketplace source
drisp marketplace add ./local/path         # Add a local marketplace
drisp marketplace list                     # List configured sources
drisp marketplace remove owner/repo        # Remove a source
```

Install from a local file or a specific marketplace ref:

```bash
drisp workflow install ./path/to/workflow.json
drisp workflow install e2e-test-builder@lespaceman/athena-workflow-marketplace
```

> **[Author your own workflows](https://athenaflow.in/docs)**

<br>

## CI / Automation

`drisp exec` is built for pipelines. Safe by default -- permission and question hooks fail unless you opt in.

```bash
drisp exec "summarize risk in this PR"                                        # plain text
drisp exec "run checks" --json --on-permission=deny --on-question=empty       # JSONL
drisp exec "write release notes" --output-last-message release-notes.md       # artifact
```

<details>
<summary>GitHub Actions</summary>

```yaml
name: drisp-exec
on: [pull_request]
jobs:
  drisp:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npx @drisp/cli exec "summarize risk in this PR" \
          --json --on-permission=deny --on-question=empty \
          --output-last-message drisp-summary.md
      - uses: actions/upload-artifact@v4
        with:
          name: drisp-summary
          path: drisp-summary.md
```

</details>

<details>
<summary>GitLab CI</summary>

```yaml
drisp_exec:
  image: node:20
  script:
    - npm ci
    - npx @drisp/cli exec "summarize pipeline status" \
      --json --on-permission=deny --on-question=empty \
      --output-last-message drisp-summary.md
  artifacts:
    paths:
      - drisp-summary.md
```

</details>

<details>
<summary>Exit codes</summary>

| Code | Meaning                           |
| ---- | --------------------------------- |
| `0`  | Success                           |
| `2`  | Usage / validation error          |
| `3`  | Bootstrap / configuration failure |
| `4`  | Runtime / process failure         |
| `5`  | Non-interactive policy failure    |
| `6`  | Timeout exceeded                  |
| `7`  | Output write failure              |

</details>

<br>

## Configuration

Config merges in order: **global &rarr; project &rarr; CLI flags**.

```
~/.config/athena/config.json        # Global defaults
{projectDir}/.athena/config.json    # Project overrides
```

```json
{
	"harness": "claude-code",
	"model": "sonnet",
	"plugins": ["/path/to/plugin"],
	"activeWorkflow": "e2e-test-builder"
}
```

<details>
<summary>CLI flags</summary>

| Flag            | Description                                   |
| --------------- | --------------------------------------------- |
| `--project-dir` | Project directory (default: cwd)              |
| `--plugin`      | Path to a plugin directory (repeatable)       |
| `--isolation`   | `strict` (default) · `minimal` · `permissive` |
| `--theme`       | `dark` (default) · `light` · `high-contrast`  |
| `--ascii`       | ASCII-only UI glyphs                          |
| `--verbose`     | Extra rendering detail                        |

**exec-only:**

| Flag                    | Description                                            |
| ----------------------- | ------------------------------------------------------ |
| `--continue`            | Resume most recent exec session (or `--continue=<id>`) |
| `--json`                | JSONL lifecycle events on stdout                       |
| `--output-last-message` | Write final assistant message to a file                |
| `--ephemeral`           | Disable session persistence for this run               |
| `--on-permission`       | `allow` · `deny` · `fail` (default)                    |
| `--on-question`         | `empty` · `fail` (default)                             |
| `--timeout-ms`          | Hard timeout for the run                               |

</details>

<details>
<summary>Commands</summary>

| Command             | Description                                                  |
| ------------------- | ------------------------------------------------------------ |
| _(default)_         | Start interactive session in cwd                             |
| `setup`             | Re-run setup wizard                                          |
| `sessions`          | Interactive session picker                                   |
| `resume [id]`       | Resume most recent or specific session                       |
| `exec "<prompt>"`   | Headless run for CI / scripting                              |
| `workflow <sub>`    | `install` · `list` · `search` · `remove` · `upgrade` · `use` |
| `marketplace <sub>` | `add` · `remove` · `list`                                    |

</details>

<br>

## Development

```bash
npm install && npm run build    # Build
npm test                        # Test
npm run typecheck               # Type-check
npm run lint                    # Lint
npm run dev                     # Watch mode
```

<details>
<summary>Codex protocol bindings</summary>

Files in `src/harnesses/codex/protocol/generated` are auto-generated from the `codex app-server` schema -- do not edit by hand. Refresh with:

```bash
scripts/update-codex-protocol-snapshot.mjs
```

Commit the output so others can build without the generator.

</details>

<br>

## License

[MIT](LICENSE)
