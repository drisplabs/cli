/**
 * Instance-socket frames — the control plane between a runner and the hub.
 *
 * Two name sets are accepted side by side. The **legacy** names are what the
 * CLI emits and consumes today; the **canonical** names are the target
 * vocabulary of the one-protocol migration. A frame body is defined once and
 * shared by both names, so the only difference between a legacy frame and its
 * canonical twin is `type` (and, for `event`, the added `stream`
 * discriminator). `normalize.ts` owns the mapping between them.
 */
import {z} from 'zod';
import {
	AssignmentRejectedReasonSchema,
	AttachmentSchema,
	InterruptionSchema,
	RunSpecSchema,
	RuntimeDecisionSchema,
} from './domain';
import {FeedEnvelopeSchema, RunStreamEventSchema} from './events';
import {PROTOCOL_VERSION} from './version';

// ── Shared bodies ─────────────────────────────────────────

const runStartBody = {
	runId: z.string(),
	runSpec: RunSpecSchema.optional(),
	/**
	 * The runner this assignment is bound to — top-level so the CLI can route
	 * to the right Attachment without inspecting `runSpec`. Absent from hubs
	 * that use single-runtime semantics.
	 */
	runnerId: z.string().optional(),
};

const answerBody = {
	athenaSessionId: z.string(),
	requestId: z.string(),
	decision: RuntimeDecisionSchema,
};

const stopBody = {
	runId: z.string(),
	runnerId: z.string().optional(),
};

// ── Frames whose name is unchanged ────────────────────────

export const PingFrameSchema = z.object({
	type: z.literal('ping'),
	ts: z.number(),
});
export const PongFrameSchema = z.object({
	type: z.literal('pong'),
	ts: z.number(),
});

export const AssignmentAcceptedFrameSchema = z.object({
	type: z.literal('assignment_accepted'),
	runId: z.string(),
});

export const AssignmentRejectedFrameSchema = z.object({
	type: z.literal('assignment_rejected'),
	runId: z.string(),
	reason: AssignmentRejectedReasonSchema,
	message: z.string().optional(),
});

export const DecisionAckFrameSchema = z.object({
	type: z.literal('decision_ack'),
	athenaSessionId: z.string(),
	requestId: z.string(),
});

export const FeedAckFrameSchema = z.object({
	type: z.literal('feed_ack'),
	deliverySeq: z.int().nonnegative().optional(),
	eventId: z.string().optional(),
});

/** Full-list replace of the runner's Attachment mirror (protocol §7). */
export const AttachmentsChangedFrameSchema = z.object({
	type: z.literal('attachments.changed'),
	attachments: z.array(AttachmentSchema),
});

export const ErrorFrameSchema = z.object({
	type: z.literal('error'),
	code: z.string(),
	message: z.string().optional(),
});

// ── Legacy names ──────────────────────────────────────────

export const JobAssignmentFrameSchema = z.object({
	type: z.literal('job_assignment'),
	...runStartBody,
});

export const DashboardDecisionFrameSchema = z.object({
	type: z.literal('dashboard_decision'),
	...answerBody,
});

export const CancelFrameSchema = z.object({
	type: z.literal('cancel'),
	...stopBody,
});

export const RunEventFrameSchema = z.object({
	type: z.literal('run_event'),
	...RunStreamEventSchema.shape,
});

export const FeedEventFrameSchema = z.object({
	type: z.literal('feed_event'),
	/** Runner-local outbox order, used only for delivery retry. */
	deliverySeq: z.int().nonnegative(),
	envelope: FeedEnvelopeSchema,
});

// ── Canonical names ───────────────────────────────────────

/**
 * First frame either side sends: the protocol version it speaks, its role,
 * and what it is. A receiver that sees a `protocolVersion` it does not speak
 * replies with an `error` and closes.
 */
export const HelloFrameSchema = z.object({
	type: z.literal('hello'),
	protocolVersion: z.int().positive(),
	role: z.enum(['runner', 'hub']).optional(),
	instanceId: z.string().optional(),
	agent: z
		.object({name: z.string(), version: z.string().optional()})
		.optional(),
	capabilities: z.array(z.string()).optional(),
});

export const RunStartFrameSchema = z.object({
	type: z.literal('run.start'),
	...runStartBody,
});

export const AnswerFrameSchema = z.object({
	type: z.literal('answer'),
	...answerBody,
});

export const StopFrameSchema = z.object({
	type: z.literal('stop'),
	...stopBody,
});

/**
 * A human turn text sent into a Run: wakes a Run parked in
 * `awaiting_attention` (resuming the intact Agent Session with the text) or
 * is carried into the next Turn of a running one.
 */
export const SteerFrameSchema = z.object({
	type: z.literal('steer'),
	runId: z.string(),
	athenaSessionId: z.string().optional(),
	text: z.string().min(1),
});

/** A Run parking in `awaiting_attention` with the Interruption that caused it. */
export const NeedsHumanFrameSchema = z.object({
	type: z.literal('needs_human'),
	runId: z.string(),
	athenaSessionId: z.string().optional(),
	interruption: InterruptionSchema,
});

export const RunStreamEventFrameSchema = z.object({
	type: z.literal('event'),
	stream: z.literal('run'),
	...RunStreamEventSchema.shape,
});

export const FeedStreamEventFrameSchema = z.object({
	type: z.literal('event'),
	stream: z.literal('feed'),
	deliverySeq: z.int().nonnegative(),
	envelope: FeedEnvelopeSchema,
});

/** `run_event` and `feed_event` under one name, discriminated by `stream`. */
export const EventFrameSchema = z.discriminatedUnion('stream', [
	RunStreamEventFrameSchema,
	FeedStreamEventFrameSchema,
]);

// ── Unions ────────────────────────────────────────────────

const unchangedFrames = [
	PingFrameSchema,
	PongFrameSchema,
	AssignmentAcceptedFrameSchema,
	AssignmentRejectedFrameSchema,
	DecisionAckFrameSchema,
	FeedAckFrameSchema,
	AttachmentsChangedFrameSchema,
	ErrorFrameSchema,
] as const;

/** Every frame under its legacy name — what the CLI emits and consumes today. */
export const LegacyFrameSchema = z.discriminatedUnion('type', [
	JobAssignmentFrameSchema,
	DashboardDecisionFrameSchema,
	CancelFrameSchema,
	RunEventFrameSchema,
	FeedEventFrameSchema,
	...unchangedFrames,
]);
export type LegacyFrame = z.infer<typeof LegacyFrameSchema>;
export type LegacyFrameType = LegacyFrame['type'];

/** Every frame under its canonical name — the one typed value both name sets normalise to. */
export const CanonicalFrameSchema = z.discriminatedUnion('type', [
	HelloFrameSchema,
	RunStartFrameSchema,
	AnswerFrameSchema,
	StopFrameSchema,
	SteerFrameSchema,
	NeedsHumanFrameSchema,
	EventFrameSchema,
	...unchangedFrames,
]);
export type CanonicalFrame = z.infer<typeof CanonicalFrameSchema>;
export type CanonicalFrameType = CanonicalFrame['type'];

/** Any frame, under either name set. */
export const FrameSchema = z.discriminatedUnion('type', [
	JobAssignmentFrameSchema,
	DashboardDecisionFrameSchema,
	CancelFrameSchema,
	RunEventFrameSchema,
	FeedEventFrameSchema,
	HelloFrameSchema,
	RunStartFrameSchema,
	AnswerFrameSchema,
	StopFrameSchema,
	SteerFrameSchema,
	NeedsHumanFrameSchema,
	EventFrameSchema,
	...unchangedFrames,
]);
export type Frame = z.infer<typeof FrameSchema>;
export type FrameType = Frame['type'];

export type HelloFrame = z.infer<typeof HelloFrameSchema>;
export type RunStartFrame = z.infer<typeof RunStartFrameSchema>;
export type AnswerFrame = z.infer<typeof AnswerFrameSchema>;
export type StopFrame = z.infer<typeof StopFrameSchema>;
export type SteerFrame = z.infer<typeof SteerFrameSchema>;
export type NeedsHumanFrame = z.infer<typeof NeedsHumanFrameSchema>;
export type EventFrame = z.infer<typeof EventFrameSchema>;
export type RunStreamEventFrame = z.infer<typeof RunStreamEventFrameSchema>;
export type FeedStreamEventFrame = z.infer<typeof FeedStreamEventFrameSchema>;
export type JobAssignmentFrame = z.infer<typeof JobAssignmentFrameSchema>;
export type DashboardDecisionFrame = z.infer<
	typeof DashboardDecisionFrameSchema
>;
export type CancelFrame = z.infer<typeof CancelFrameSchema>;
export type RunEventFrame = z.infer<typeof RunEventFrameSchema>;
export type FeedEventFrame = z.infer<typeof FeedEventFrameSchema>;
export type PingFrame = z.infer<typeof PingFrameSchema>;
export type PongFrame = z.infer<typeof PongFrameSchema>;
export type AssignmentAcceptedFrame = z.infer<
	typeof AssignmentAcceptedFrameSchema
>;
export type AssignmentRejectedFrame = z.infer<
	typeof AssignmentRejectedFrameSchema
>;
export type DecisionAckFrame = z.infer<typeof DecisionAckFrameSchema>;
export type FeedAckFrame = z.infer<typeof FeedAckFrameSchema>;
export type AttachmentsChangedFrame = z.infer<
	typeof AttachmentsChangedFrameSchema
>;
export type ErrorFrame = z.infer<typeof ErrorFrameSchema>;

/** Build the `hello` this package sends: it always speaks `PROTOCOL_VERSION`. */
export function hello(
	input: Omit<HelloFrame, 'type' | 'protocolVersion'> = {},
): HelloFrame {
	return {type: 'hello', protocolVersion: PROTOCOL_VERSION, ...input};
}
