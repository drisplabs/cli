# @drisp/protocol

The wire contract between a drisp **runner** (the CLI's runtime daemon) and the
**hub** (the dashboard): zod schemas and inferred types for every
instance-socket frame, the Workflow **Run**, the **Turn**, the **Interruption**
a Run parks on, and the event stream — plus a JSON Schema export of the same.

Vocabulary follows the repo's domain docs (`UBIQUITOUS_LANGUAGE.md`,
`CONTEXT.md`, ADR 0014–0016); this package does not define a second one.

```ts
import {
	PROTOCOL_VERSION,
	hello,
	normalizeFrame,
	toLegacyFrame,
	FrameSchema,
} from '@drisp/protocol';

// First frame either side sends.
socket.send(JSON.stringify(hello({role: 'runner', instanceId})));

// Any inbound frame, under either name set, becomes one canonical value.
const frame = normalizeFrame(JSON.parse(raw));
if (frame.type === 'run.start') admit(frame.runId, frame.runSpec);

// A runner that still speaks the old names on the wire.
socket.send(JSON.stringify(toLegacyFrame(frame)));
```

## Frame names: old → new

Both name sets parse. `normalizeFrame()` returns the canonical (new-name) form;
`toLegacyFrame()` is its inverse for frames that have an old name. Each old name
maps to exactly one new name (`FRAME_NAME_MAP`).

| Old name (CLI emits/consumes today) | New name                   | Direction    | Notes                                                                |
| ----------------------------------- | -------------------------- | ------------ | -------------------------------------------------------------------- |
| `job_assignment`                    | `run.start`                | hub → runner | `{runId, runSpec?, runnerId?}`                                       |
| `dashboard_decision`                | `answer`                   | hub → runner | `{athenaSessionId, requestId, decision}`                             |
| `cancel`                            | `stop`                     | hub → runner | `{runId, runnerId?}`                                                 |
| `run_event`                         | `event` + `stream: 'run'`  | runner → hub | compatibility per-Run stream (`seq`, `kind`, `payload`)              |
| `feed_event`                        | `event` + `stream: 'feed'` | runner → hub | canonical FeedEvent channel (`deliverySeq`, `envelope`)              |
| `ping`                              | `ping`                     | runner → hub | unchanged                                                            |
| `pong`                              | `pong`                     | hub → runner | unchanged                                                            |
| `assignment_accepted`               | `assignment_accepted`      | runner → hub | unchanged                                                            |
| `assignment_rejected`               | `assignment_rejected`      | runner → hub | unchanged                                                            |
| `decision_ack`                      | `decision_ack`             | runner → hub | unchanged                                                            |
| `feed_ack`                          | `feed_ack`                 | hub → runner | unchanged                                                            |
| `attachments.changed`               | `attachments.changed`      | hub → runner | unchanged                                                            |
| `error`                             | `error`                    | either       | unchanged                                                            |
| —                                   | `hello`                    | either       | **new** — carries `protocolVersion` (`PROTOCOL_VERSION`)             |
| —                                   | `steer`                    | hub → runner | **new** — a human turn text for a Run                                |
| —                                   | `needs_human`              | runner → hub | **new** — a Run parking in `awaiting_attention` with an Interruption |

The `event` frame folds two old names into one, told apart by `stream`. Every
other mapping is a pure rename of `type`; bodies are shared.

The runner (the CLI's dashboard daemon) is wired to this package: it parses
every inbound frame with `safeNormalizeFrame()`, sends a versioned `hello`
first, and builds every outbound frame under its canonical name. Which name set
actually reaches the wire is decided per connection by the hub's `hello` — see
`docs/protocol/runtime-dashboard-protocol.md` §17 for the rule.

## Versioning

`PROTOCOL_VERSION` is the version this package speaks and is carried on every
`hello`. It bumps only on an incompatible frame change; adding an optional
field or a new frame name does not bump it.

## JSON Schema

`schema/*.json` (draft 2020-12) is generated from the zod schemas:

```sh
npm run schema:generate   # from the repo root
```

`src/jsonSchema.test.ts` fails when the checked-in files differ from a fresh
generation, so they cannot drift.

| File                           | Zod export              |
| ------------------------------ | ----------------------- |
| `schema/frame.json`            | `FrameSchema`           |
| `schema/canonical-frame.json`  | `CanonicalFrameSchema`  |
| `schema/legacy-frame.json`     | `LegacyFrameSchema`     |
| `schema/hello.json`            | `HelloFrameSchema`      |
| `schema/run.json`              | `RunSchema`             |
| `schema/turn.json`             | `TurnSchema`            |
| `schema/interruption.json`     | `InterruptionSchema`    |
| `schema/run-spec.json`         | `RunSpecSchema`         |
| `schema/runtime-decision.json` | `RuntimeDecisionSchema` |
| `schema/run-stream-event.json` | `RunStreamEventSchema`  |
| `schema/feed-event.json`       | `FeedEventSchema`       |
| `schema/feed-envelope.json`    | `FeedEnvelopeSchema`    |

## Layout

```
src/version.ts     PROTOCOL_VERSION
src/domain.ts      Run, Turn, Interruption, RunSpec, RuntimeDecision, Attachment
src/events.ts      RunStreamEvent, FeedEvent, FeedEnvelope
src/frames.ts      every frame under its old and new name; hello()
src/normalize.ts   FRAME_NAME_MAP, normalizeFrame(), toLegacyFrame()
src/jsonSchema.ts  buildJsonSchemas()
scripts/           schema generator
schema/            generated JSON Schema (checked in)
```

Released independently of `@drisp/cli` via release-please (component
`protocol`, tag `protocol-vX.Y.Z`). The CLI inlines this package into its
bundle, so a published CLI has no registry dependency on it.
