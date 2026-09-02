/**
 * The protocol version this package speaks. Carried on every `hello` frame so
 * a runner and the hub can detect a mismatch before exchanging anything else.
 *
 * Bump when a frame changes shape incompatibly (a required field added or
 * removed, a discriminator value renamed). Adding an optional field or a new
 * frame name is backward compatible and does not bump it (see
 * docs/protocol/runtime-dashboard-protocol.md §15).
 */
export const PROTOCOL_VERSION = 1 as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;
