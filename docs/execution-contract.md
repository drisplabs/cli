# Execution and maintenance contract

Updated 14 September 2026 for the cleanup branch based on Drisp 0.6.0.

A **Workflow Run** is the work being supervised. A **Turn** is one attempt to let an agent work. A **Feed Run** groups events for display. These are separate identities. The knowledge-base documents describe planned work; no knowledge-base runtime is introduced here.

## Behavior by mode

The workflow reducer decides outcomes in every mode. The terminal hosts a long-lived runtime; `run` creates one for its execution; dashboard assignments use `run` with delivery sinks. The event loop and workflow admission/restoration code are shared. Terminal dialogs, unattended permission handling, and transport connections have different owners.

| Behavior                          | Terminal, Claude                                                            | Terminal, Codex                       | Headless / dashboard, Claude                                                                    | Headless / dashboard, Codex                     |
| --------------------------------- | --------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Fresh start                       | New conversation                                                            | New thread                            | New conversation                                                                                | New thread                                      |
| Normal completion                 | Structured `completed` outcome                                              | Same                                  | `completed`; exit 0                                                                             | Same                                            |
| Premature stop and retry          | Shared reducer; resume known conversation, preserve budgets                 | Same, using thread handle             | Same                                                                                            | Same                                            |
| Human or limit marker             | `awaiting_attention`; notification includes reason                          | Same                                  | `run.suspended`; exit 0 means execution returned, not completed work                            | Same                                            |
| Parked wake                       | Validate identity, restore saved counters, then continue                    | Same                                  | Original workflow selected before bootstrap; same validation and restoration                    | Same                                            |
| Permission / question             | Live terminal dialog                                                        | Live terminal dialog                  | Ask rules and unattended hold/park/replay; hub or stored answer can respond                     | Same policy, translated through Codex approvals |
| Stop                              | Stop child and await settlement                                             | Interrupt thread and await settlement | Cancellation outcome; process failure exit 4 for external abort                                 | Same                                            |
| Command timeout                   | No terminal `--timeout-ms` behavior                                         | Same                                  | Stop, exit 6                                                                                    | Same                                            |
| Usage / turn budgets              | Shared workflow limits park the Run                                         | Same                                  | Same                                                                                            | Same                                            |
| Context-bound restart             | Vendor compaction; visible warning that managed restart is unavailable here | Vendor-managed context behavior       | `compact.pre` interrupts Claude; validates `## Restart`, then starts fresh within saved budgets | No Claude hook boundary; no managed restart     |
| Workflow checkpoint write failure | Failed outcome; no further turn is started                                  | Same                                  | Failed outcome and runtime failure exit                                                         | Same                                            |

`exec.completed` and the programmatic execution result include `workflowOutcome`. A parked result is not a completed Workflow Run. Historical `blocked` and `exhausted` database values remain readable. Numeric exit slots 5, 8, and 9 are retained for compatibility but are not current workflow outcomes.

Behavior evidence lives in `app/execution/startWorkflowExecution.test.ts`, the terminal hook tests beside it, `app/exec/runner.test.ts`, `core/workflows/workflowRunner.test.ts`, the reducer tests, and each harness's session/runtime tests. These use fake vendors; they do not prove the behavior of every installed external agent version.

## Continuing saved work

Session database schema 11 adds `execution_identity_json`. It stores a versioned digest and the workflow/harness names, not copied credentials. The digest checks workflow settings, instruction content, selected model/effort/isolation/tool grants, plugin references and installed plugin content. Resolved workflow plugins are checked for both harnesses. Environment values, MCP headers and endpoint overrides may refresh without changing the saved identity.

A workflow with changed instructions or capabilities must be restored to its original settings, or started as a new Run. An explicit workflow override does not silently migrate an existing Run. Unreadable saved memory is rejected so a corrupt record cannot reset lifetime budgets. Historical records without an identity warn that their original instructions and capabilities cannot be verified.

This is validation, not an archive of old workflow packages. It does not make unavailable old packages downloadable. Model aliases and external tool services can still change independently of this repository.

## Configuration and assets

Source acquisition remains in bootstrap: read settings, resolve workflow/plugin caches, then assemble the harness plan. `resolveExecutionSettings` is a pure function: the same explicit inputs produce the same settings and source labels without reading files or changing registration. `run --dry-run` includes model and permission-grace provenance without printing credential values.

| Setting                       | Precedence                                                                 |
| ----------------------------- | -------------------------------------------------------------------------- |
| Workflow selection            | Explicit flag; parked workflow when continuing; configured active workflow |
| Harness                       | Explicit flag, then existing project/global selection                      |
| Model                         | Project, global, workflow, harness default                                 |
| Effort                        | Workflow, otherwise harness default                                        |
| Isolation                     | CLI preset, raised to the workflow's required preset when applicable       |
| Extra directories             | Global followed by project                                                 |
| Permission grace              | CLI override, project, global, default; zero is valid                      |
| Plugin directories            | Workflow, global, project, CLI; duplicates removed                         |
| Personal capability collision | Workflow plugin wins; report the shadowed personal capability              |

Plugin loading returns definitions. Application bootstrap owns command registration. Replacing the plugin command scope is atomic: a failed load leaves the previous set usable, and loading an empty set removes old plugin commands. The CLI still has one application command registry; it is not an execution-wide global dependency injected into workflow control.

Generated prompts live under the project's `.athena/execution-assets/`, named by content digest. Publication is atomic, and another preparation never truncates an active prompt. They are retained for durable continuation; there is no automatic age-based deletion. Generated MCP files live in private temporary directories with mode 0600, are released by execution/session cleanup, and have process-exit cleanup as a fallback. Caller-owned MCP files are never deleted. Abrupt process termination can leave temporary assets for the operating system to reclaim.

## Ownership and failure policy

`app/execution/startWorkflowExecution` owns workflow admission, memory restoration, adapter identity observation, abort observation, and subscription disposal. Observers are installed before the first Turn; `stop()` waits for settlement and `dispose()` is idempotent. The workflow runner remains the interpreter of the pure reducer.

The headless host owns its runtime, session writer, child controller, timers, decision drain, and output sinks. Its resource scope releases all resources in reverse order even if an earlier release fails. The terminal provider owns its longer-lived runtime and session writer; changing only the runtime does not close the still-active writer. A failed runtime start is shown instead of marking that runtime ready.

Both Claude hosts use one child-termination implementation. It sends the normal termination signal, escalates after three seconds, and still waits for the Turn to settle. Codex retains its thread-interruption implementation because its app-server is a persistent process. Protocol translation and launch settings remain vendor-owned; generated protocol files remain generated.

Losing a workflow checkpoint stops the run and reports failure. Best-effort feed/UI projection can warn and continue; that warning does not promise the missing observation is durable. A failed database migration closes the just-opened handle. Transport failure belongs to delivery/reconnect handling, not to the workflow's business-state reducer.

## Compatibility and delivery

This section supplements ADR 0017: the instance socket is the default control connection, but it is not the only retained outbound path.

| Path                                                 | Guarantee / owner                                                                                   | Removal condition                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Feed outbox in `runner.db`                           | Durable retry and acknowledgement; receiving code must deduplicate                                  | Keep; this is the current delivery path               |
| Incoming answers                                     | Durable inbox; execution consumes matching answers, including parked-call replay                    | Keep                                                  |
| Stop / steer                                         | Commands handled by the runner/execution; not a promise of exactly-once external side effects       | Keep                                                  |
| Per-run callback socket                              | Supported when assignment supplies URL and token; fallback to instance socket on connection failure | Hub rollout agreement before removal                  |
| Compatibility run events over instance socket        | Process-local sequence and best-effort connection delivery, distinct from durable feed outbox       | Coordinated with protocol migration                   |
| Legacy wire frame names                              | Normalized in `packages/protocol`; send spelling negotiated at the transport edge                   | Issue #186 and deployed hub support                   |
| Artifact uploads                                     | Explicit assignment configuration; upload to GCS and report manifest                                | Keep while hub assignments request it                 |
| `athena`, `athena-flow`, `exec`, old isolation names | Existing command compatibility with notices where implemented                                       | Explicit release policy and consumer migration        |
| `drisp-dashboard-daemon` binary                      | Alias for the runner service entry                                                                  | Planned removal in 0.7.0 after service-unit refresh   |
| Athena disk paths / `tracker.md`                     | Existing persisted data and historical journal lookup                                               | Separate tested migration, outside structural cleanup |

Callback connection and drain deadlines now clear their timers on early completion. Failed callback candidates are closed; publisher close is idempotent. Existing fake-hub suites cover socket negotiation, acknowledgements, duplicate delivery and recovery; the publisher tests cover callback fallback and timer cleanup. Nothing here makes paid agent calls or external tool side effects exactly-once.

## Contributor checks

Run `npm run lint`, `npm run typecheck`, `npm run lint:dead`, `npm test`, `npm run build`, and `npm run smoke:package`. Socket integration tests need permission to bind local sockets. CI runs on Node 20 and 22; local checks in this cleanup use Node 24.

Vitest collects only the application and protocol package. Nested checkouts and generated output are excluded consistently from the relevant tools. Architecture checks resolve relative imports, reject forbidden layer dependencies and workflow React imports, and check explicit FeedEvent producers. The delivery-only artifact manifest and live transport diagnostic fixture are documented producer exceptions. Missing or empty source cannot pass.

Test typechecking is deliberately incremental in `tsconfig.tests.json`: execution identity/resource/lifecycle tests, configuration/UI tests, and real schema identity tests are included. The older test tree has existing typing debt and is still executed by Vitest; production typechecking alone must not be described as checking every test's types.
