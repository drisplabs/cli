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

**CI-native** -- `drisp run` runs headlessly with safe defaults, JSONL output, and structured exit codes.

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
drisp marketplace refresh                  # Refresh configured remote sources
drisp marketplace refresh owner/repo       # Refresh one remote source
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

`drisp run` is built for pipelines. Safe by default -- permission and question hooks fail unless you opt in.

### Permissions with no hub attached

drisp has a single door. A permission request or a question is answered by whoever is attached to the Run: the interactive terminal, or a paired dashboard delivering decisions. With no hub attached (a headless `drisp run` with no dashboard paired) there is nobody to ask, so under `guarded` and `standard` the request **waits**: the Run holds on the pending decision, and nothing is auto-approved or auto-denied on its behalf. The hold ends one of two ways. If you set `--timeout-ms`, the run exits with the timeout exit code when it expires. If the Run belongs to a workflow, the request is **held, then parked, then replayed**:

- **Hold.** A permission request no rule answers is held for the **grace window** — `permissionGraceMs` in `~/.config/athena/config.json` or `.athena/config.json` (project wins), `--permission-grace-ms` per run, default 60 000 ms — so an attached hub can answer it. With no hub attached there is nobody to wait for, and the request is deferred at once.
- **Park.** When the window elapses unanswered, the tool call is refused with a _deferred_ result, the Turn ends, and the Run parks in `awaiting_attention` with the request recorded — its id, the tool, and a one-line input summary — in the Journal and on the run record. `drisp runs` shows the pending question and the hub receives it as a `needs_human` frame.
- **Replay.** `drisp run --continue=<session> --answer=allow|deny "<reply>"` (or an `answer` the hub sends while the Run is parked) stores the answer against that request. On continue the agent re-issues the same call and the stored answer is replayed into it without a prompt; without one, the request is held again. See [human resume](docs/guides/human-resume.md).

**`--isolation autonomous` runs with nobody watching.** A permission prompt that no **ask rule** claims is answered _allow_ by the preset's policy, within the tool surface the preset already grants, and the workflow runs to `WORKFLOW_COMPLETE`. Exactly two things park the Run as needs-human: an ask rule that fires, or a Turn that ends on `<!-- NEEDS_HUMAN: reason -->`. Ask rules are a provisional, per-workflow list of tool-name patterns in `workflow.json` whose prompts must always reach a person — `"askRules": ["Bash", "mcp__github__*"]` — and a parked Run shows in `drisp runs` as **Parked** with the rule that fired (or the marker's reason); `drisp run --continue` wakes it.

```bash
drisp run "summarize risk in this PR"                                        # plain text
drisp run "run checks" --json --on-permission=deny --on-question=empty       # JSONL
drisp run "write release notes" --output-last-message release-notes.md       # artifact
```

<details>
<summary>GitHub Actions</summary>

```yaml
name: drisp-run
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
      - run: npx @drisp/cli run "summarize risk in this PR" \
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
drisp_run:
  image: node:20
  script:
    - npm ci
    - npx @drisp/cli run "summarize pipeline status" \
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

## Runner

`drisp runner` is the one long-lived process that pairs a machine with the hub, receives its Runs over the instance socket, and executes them. Events leave the machine only over that socket.

```bash
drisp runner pair <token> --url https://hub.example.com   # pair, then start the runner in the background
drisp runner                                              # run it in the foreground (Ctrl-C stops it)
drisp runner --detach                                     # start it in the background
drisp runner status                                       # pairing, process, socket, token — non-zero on any unhealthy axis
drisp runner runs --active                                # the Runs it has handled
drisp runner logs --follow                                # tail its log
drisp runner stop                                         # SIGTERM to the pid in runner.pid
drisp runner install                                      # launchd / systemd unit so it starts on login
```

A second `drisp runner` on the same machine exits non-zero with `already running (pid N)`. Its state lives in `~/.local/state/drisp/`:

| File                 | What it is                                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runner.pid`         | Liveness and the single-instance lock.                                                                                                                                              |
| `runner.status.json` | The runner's snapshot (socket, wire mode, active and recent Runs), rewritten on change; what `status` and `runs` read. Removed on a clean stop.                                     |
| `runner.db`          | One SQLite database: the feed outbox the runner drains to the hub and the decision inbox the hub's answers wait in. A runner killed mid-Run drains and re-delivers both on restart. |
| `runner.log`         | The rotating log.                                                                                                                                                                   |

`drisp dashboard <sub>` is a deprecated alias of `drisp runner` for one release (`dashboard daemon start` is `runner --detach`; `daemon foreground` / `connect` is bare `runner`). The pre-0.6 `dashboard-feed-outbox.db` and `dashboard-decision-inbox.db` are imported into `runner.db` on the first start and removed.

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

| Flag            | Description                                     |
| --------------- | ----------------------------------------------- |
| `--project-dir` | Project directory (default: cwd)                |
| `--plugin`      | Path to a plugin directory (repeatable)         |
| `--isolation`   | `guarded` (default) · `standard` · `autonomous` |
| `--theme`       | `dark` (default) · `light` · `high-contrast`    |
| `--ascii`       | ASCII-only UI glyphs                            |
| `--verbose`     | Extra rendering detail                          |

**run-only:**

| Flag                    | Description                                           |
| ----------------------- | ----------------------------------------------------- |
| `--continue`            | Resume most recent run session (or `--continue=<id>`) |
| `--steer`               | Queue a human steer for the next Turn (repeatable)    |
| `--json`                | JSONL lifecycle events on stdout                      |
| `--output-last-message` | Write final assistant message to a file               |
| `--ephemeral`           | Disable session persistence for this run              |
| `--on-permission`       | `allow` · `deny` · `fail` (default)                   |
| `--on-question`         | `empty` · `fail` (default)                            |
| `--timeout-ms`          | Hard timeout for the run                              |

</details>

<details>
<summary>Commands</summary>

| Command             | Description                                                    |
| ------------------- | -------------------------------------------------------------- |
| _(default)_         | Start interactive session in cwd                               |
| `setup`             | Re-run setup wizard                                            |
| `sessions`          | Interactive session picker                                     |
| `resume [id]`       | Resume most recent or specific session                         |
| `run "<prompt>"`    | Headless run for CI / scripting (`exec` is a deprecated alias) |
| `workflow <sub>`    | `install` · `list` · `search` · `remove` · `upgrade` · `use`   |
| `marketplace <sub>` | `add` · `refresh` · `remove` · `list`                          |

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
