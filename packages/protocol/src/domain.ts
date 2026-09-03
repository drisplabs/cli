/**
 * Workflow-execution domain shapes as the domain docs define them
 * (UBIQUITOUS_LANGUAGE.md, ADR 0014-0016): the Workflow Run, the Turn, and the
 * Interruption a Run parks on when it needs a human. These are the values the
 * frames in `frames.ts` carry; nothing here knows about the wire.
 */
import {z} from 'zod';

// ── Run ───────────────────────────────────────────────────

/**
 * The outcome of a Workflow Run. Terminal: `completed`, `failed`, `cancelled`.
 * Non-terminal: `running`, and `awaiting_attention` — suspended until a human
 * replies. `blocked` and `exhausted` are no longer emitted (both route to
 * `awaiting_attention`) but stay valid on historical rows.
 */
export const RunStatusSchema = z.enum([
	'running',
	'awaiting_attention',
	'completed',
	'blocked',
	'exhausted',
	'failed',
	'cancelled',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * One execution of a whole Workflow — the loop spanning every Turn from start
 * to a terminal Run Status. Many per Athena Session.
 */
export const RunSchema = z.object({
	runId: z.string(),
	/** The durable Athena Session this Run belongs to. */
	athenaSessionId: z.string(),
	workflowName: z.string().optional(),
	/** What the Run was asked to do — the `**Goal**` its Run section records. */
	goal: z.string().optional(),
	/** Index of the most recent Turn (0 before Turn 1). */
	iteration: z.int().nonnegative(),
	maxIterations: z.int().positive().optional(),
	status: RunStatusSchema,
	stopReason: z.string().optional(),
	/** Vendor session id of the Run's most recent Agent Session (ADR 0014). */
	adapterSessionId: z.string().optional(),
	startedAt: z.number(),
	endedAt: z.number().optional(),
});
export type Run = z.infer<typeof RunSchema>;

// ── Turn ──────────────────────────────────────────────────

/**
 * How a Turn relates to the Agent Session before it: a fresh spawn, a resume
 * of the prior Agent Session (Nudge / Retry / human reply), or reuse of the
 * one already running.
 */
export const TurnContinuationSchema = z.discriminatedUnion('mode', [
	z.object({mode: z.literal('fresh')}),
	z.object({mode: z.literal('resume'), handle: z.string()}),
	z.object({mode: z.literal('reuse-current')}),
]);
export type TurnContinuation = z.infer<typeof TurnContinuationSchema>;

/**
 * The Terminal Outcome after a Turn: continue looping, stop with a terminal
 * Run Status, or suspend in `awaiting_attention` (ADR 0004, ADR 0014 §7).
 */
export const TurnOutcomeSchema = z.discriminatedUnion('kind', [
	z.object({kind: z.literal('continue')}),
	z.object({
		kind: z.literal('stop'),
		status: RunStatusSchema,
		stopReason: z.string().optional(),
	}),
	z.object({
		kind: z.literal('suspend'),
		status: RunStatusSchema,
		stopReason: z.string(),
	}),
]);
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;

/**
 * One agent execution — a single `claude -p` invocation / one Codex
 * `thread.run` — numbered by its Iteration within the Run.
 */
export const TurnSchema = z.object({
	runId: z.string(),
	/** 1-based Iteration of this Turn within its Run. */
	iteration: z.int().positive(),
	continuation: TurnContinuationSchema,
	/** Vendor session id of the Agent Session this Turn ran in, once known. */
	adapterSessionId: z.string().optional(),
	startedAt: z.number(),
	endedAt: z.number().optional(),
	outcome: TurnOutcomeSchema.optional(),
});
export type Turn = z.infer<typeof TurnSchema>;

// ── Interruption ──────────────────────────────────────────

/** A hard (non-transient) Turn failure class — see `failureTaxonomy.ts`. */
export const HardFailureCodeSchema = z.enum([
	'auth',
	'billing',
	'invalid_request',
	'model_not_found',
	'unclassified',
]);
export type HardFailureCode = z.infer<typeof HardFailureCodeSchema>;

/** A Run budget that can be exhausted (ADR 0014 §3-§4, §7). */
export const ExhaustedCapSchema = z.enum(['retry', 'nudge', 'iterations']);
export type ExhaustedCap = z.infer<typeof ExhaustedCapSchema>;

const interruptionBase = {
	/** Human-readable summary of why the Run parked. */
	message: z.string(),
};

/**
 * Why a Run parked in `awaiting_attention` — the payload of a Needs-attention
 * escalation. One of: a declared `NEEDS_HUMAN` marker (spelled
 * `WORKFLOW_BLOCKED` before 0.6), an elicitation the agent raised
 * (`AskUserQuestion`), a hard failure, or an exhausted cap/ceiling.
 * Resolved by a human reply (`answer` for a question, `steer` otherwise),
 * which resumes the intact Agent Session.
 */
export const InterruptionSchema = z.discriminatedUnion('kind', [
	z.object({
		...interruptionBase,
		kind: z.literal('blocked'),
		/** The `: reason` suffix of `NEEDS_HUMAN[: reason]`, when given. */
		reason: z.string().optional(),
	}),
	z.object({
		...interruptionBase,
		kind: z.literal('question'),
		/**
		 * The pending request an `answer` frame must address. Absent when the
		 * runner interrupted the Turn instead of leaving the question waiting
		 * (an unattended Workflow Run kills the Agent Session on a question,
		 * so there is no request left to answer); such a Run is woken with a
		 * `steer` carrying the human's guidance.
		 */
		requestId: z.string().optional(),
		question: z.string().optional(),
	}),
	z.object({
		...interruptionBase,
		kind: z.literal('hard_failure'),
		code: HardFailureCodeSchema,
	}),
	z.object({
		...interruptionBase,
		kind: z.literal('cap_exhausted'),
		cap: ExhaustedCapSchema,
		limit: z.int().positive().optional(),
	}),
]);
export type Interruption = z.infer<typeof InterruptionSchema>;

// ── Run spec ──────────────────────────────────────────────

/**
 * The requested shape of a Run, owned by the hub; the runner owns its
 * realization. Every field is optional *on the wire* and unknown fields are
 * kept (protocol §15): the runner's admission gate — not frame parsing — is
 * where a missing `prompt` becomes a first-class `malformed_assignment`
 * rejection, and orthogonal readers (artifact capture) read the raw spec.
 */
export const RunSpecSchema = z.looseObject({
	prompt: z.string().optional(),
	athenaSessionId: z.string().optional(),
	adapterResumeSessionId: z.string().optional(),
	sessionId: z.string().optional(),
	projectDir: z.string().optional(),
	workflow: z
		.looseObject({
			source: z.string().optional(),
			ref: z.string().optional(),
			version: z.string().optional(),
		})
		.optional(),
	harness: z.string().optional(),
	env: z.record(z.string(), z.string()).optional(),
	timeoutSec: z.number().optional(),
	/** Per-run callback channel minted by the hub; both or neither. */
	callbackWsUrl: z.string().optional(),
	callbackToken: z.string().optional(),
});
export type RunSpec = z.infer<typeof RunSpecSchema>;

// ── Runtime decision ──────────────────────────────────────

/** Typed semantic intent of a decision — the adapter maps it to hook output. */
export const RuntimeIntentSchema = z.discriminatedUnion('kind', [
	z.object({kind: z.literal('permission_allow')}),
	z.object({kind: z.literal('permission_deny'), reason: z.string()}),
	z.object({
		kind: z.literal('question_answer'),
		answers: z.record(z.string(), z.string()),
	}),
	z.object({kind: z.literal('pre_tool_allow')}),
	z.object({kind: z.literal('pre_tool_deny'), reason: z.string()}),
	z.object({kind: z.literal('stop_block'), reason: z.string()}),
	z.object({kind: z.literal('compact_block'), reason: z.string()}),
]);
export type RuntimeIntent = z.infer<typeof RuntimeIntentSchema>;

/**
 * A delayed answer that resolves a prior runtime event needing user input
 * (a permission request, a question). Correlated by `requestId` on the frame.
 */
export const RuntimeDecisionSchema = z.object({
	type: z.enum(['passthrough', 'block', 'json']),
	source: z.enum(['user', 'timeout', 'rule']),
	intent: RuntimeIntentSchema.optional(),
	reason: z.string().optional(),
	data: z.unknown().optional(),
});
export type RuntimeDecision = z.infer<typeof RuntimeDecisionSchema>;

// ── Attachments ───────────────────────────────────────────

/**
 * The binding between a paired runner instance and one hub-side runner.
 * Owned by the hub; the runner only mirrors it.
 */
export const AttachmentSchema = z.object({
	runnerId: z.string(),
	name: z.string().optional(),
	slug: z.string().optional(),
	executionTarget: z.string().optional(),
	remoteInstanceId: z.string().optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/** Why a runner declined a delivered assignment (protocol §10). */
export const AssignmentRejectedReasonSchema = z.enum([
	'local_capacity',
	'duplicate',
	'malformed_assignment',
	'workspace_unresolved',
	'workspace_invalid',
]);
export type AssignmentRejectedReason = z.infer<
	typeof AssignmentRejectedReasonSchema
>;
