/**
 * @drisp/protocol — the wire contract between a drisp runner and the hub.
 *
 * - `frames`: every instance-socket frame, under its legacy name and its
 *   canonical name, as zod schemas with inferred types.
 * - `normalize`: the legacy → canonical name map and `normalizeFrame()`.
 * - `domain`: Run, Turn, Interruption, RunSpec, RuntimeDecision.
 * - `events`: the run stream and the canonical FeedEvent envelope.
 * - `version`: `PROTOCOL_VERSION`, carried on the `hello` frame.
 * - `jsonSchema`: the JSON Schema export checked in under `schema/`.
 */
export * from './version';
export * from './domain';
export * from './events';
export * from './frames';
export * from './normalize';
export * from './jsonSchema';
