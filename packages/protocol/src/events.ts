/**
 * The event stream shapes (protocol §11): the canonical FeedEvent channel and
 * the compatibility run-event channel. Both ride the `event` frame,
 * discriminated by `stream`.
 */
import {z} from 'zod';

// ── Run stream (compatibility channel) ───────────────────

/**
 * One event on the compatibility per-Run stream: `kind` is the runner's
 * coarse progress vocabulary (`progress`, `warning`, `error`, `stderr`,
 * `completion`, or a headless exec event type) and `payload` is free-form.
 * Not the canonical session feed; see `FeedEnvelopeSchema`.
 */
export const RunStreamEventSchema = z.object({
	runId: z.string(),
	/** Runner-local order within the Run. */
	seq: z.int().nonnegative(),
	ts: z.number(),
	kind: z.string(),
	payload: z.unknown().optional(),
});
export type RunStreamEvent = z.infer<typeof RunStreamEventSchema>;

// ── Feed stream (canonical channel) ──────────────────────

export const FeedEventLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type FeedEventLevel = z.infer<typeof FeedEventLevelSchema>;

export const FeedEventCauseSchema = z.object({
	parent_event_id: z.string().optional(),
	hook_request_id: z.string().optional(),
	tool_use_id: z.string().optional(),
	transcript_path: z.string().optional(),
});
export type FeedEventCause = z.infer<typeof FeedEventCauseSchema>;

/**
 * A timeline-ready FeedEvent as the feed-pipeline context defines it
 * (CONTEXT.md): stable `event_id`, canonical `seq`, a Feed Run `run_id`, an
 * `actor_id`, a `kind`, and kind-specific `data`. The per-kind `data` shapes
 * are owned by the feed pipeline and carried opaquely here; extra fields are
 * kept so a newer runner's events survive an older hub's parse.
 */
export const FeedEventSchema = z.looseObject({
	event_id: z.string(),
	seq: z.int().nonnegative(),
	ts: z.number(),
	session_id: z.string(),
	/** A Feed Run id (`{session_id}:R{n}`) — unrelated to a Workflow Run id. */
	run_id: z.string(),
	prompt_id: z.string().optional(),
	effort_level: z.string().optional(),
	kind: z.string(),
	level: FeedEventLevelSchema,
	actor_id: z.string(),
	cause: FeedEventCauseSchema.optional(),
	title: z.string(),
	body: z.string().optional(),
	ui: z
		.object({
			collapsed_default: z.boolean().optional(),
			pin: z.boolean().optional(),
			badge: z.string().optional(),
		})
		.optional(),
	display: z.object({title: z.string().optional()}).optional(),
	data: z.unknown(),
	raw: z.unknown().optional(),
});
export type FeedEvent = z.infer<typeof FeedEventSchema>;

export const FeedOriginSchema = z.enum(['local', 'dashboard']);
export type FeedOrigin = z.infer<typeof FeedOriginSchema>;

/**
 * A FeedEvent addressed for the hub: who emitted it, which Athena Session and
 * Workflow Run it belongs to, and the identity the hub dedupes on
 * (`instanceId`, `eventId`). `feedSeq` is the canonical display order.
 */
export const FeedEnvelopeSchema = z.object({
	instanceId: z.string(),
	athenaSessionId: z.string(),
	runId: z.string(),
	origin: FeedOriginSchema,
	eventId: z.string(),
	feedSeq: z.int().nonnegative(),
	emittedAt: z.number(),
	feedEvent: FeedEventSchema,
});
export type FeedEnvelope = z.infer<typeof FeedEnvelopeSchema>;
