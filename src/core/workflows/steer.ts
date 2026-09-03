/**
 * Steer (#191) — a human turn text sent *into* a Workflow Run.
 *
 * A Steer arrives from the hub (`steer` frame) or locally (`drisp run
 * --steer`). It is never injected into a running Turn: the Runner queues it
 * and delivers every queued Steer, in arrival order, as one delimited block at
 * the head of the next Turn's prompt so the Turn Protocol block sees it before
 * it plans. This module owns the pure pieces — the queued shape, the prompt
 * block, the Journal entry — and the small buffered queue the exec runner and
 * the dashboard daemon hand Steers through.
 */

export type SteerOrigin = 'hub' | 'local';

export type QueuedSteer = {
	text: string;
	origin: SteerOrigin;
	/** Unix ms when the Runner side received it — arrival order, not delivery. */
	receivedAt: number;
};

/** A Steer the Runner delivered, and the Turn (1-based) it was delivered into. */
export type DeliveredSteer = QueuedSteer & {iteration: number};

/** The first characters of a prompt that carries a Steer block. */
export const STEER_BLOCK_OPEN = '=== HUMAN STEER';
export const STEER_BLOCK_END = '=== END HUMAN STEER ===';

function steerHeading(
	steer: QueuedSteer,
	index: number,
	total: number,
): string {
	const position = total > 1 ? `${index + 1} of ${total}, ` : '';
	return `${STEER_BLOCK_OPEN} (${position}via ${steer.origin}, received ${new Date(
		steer.receivedAt,
	).toISOString()}) ===`;
}

/**
 * The delimited block that carries queued Steers into a prompt: each Steer
 * under its own labelled heading, in arrival order, followed by one closing
 * sentinel and the instruction to act on it before planning.
 */
export function buildSteerBlock(steers: readonly QueuedSteer[]): string {
	const entries = steers.map(
		(steer, index) =>
			`${steerHeading(steer, index, steers.length)}\n${steer.text.trim()}`,
	);
	const noun = steers.length > 1 ? 'steers' : 'steer';
	return (
		`${entries.join('\n')}\n${STEER_BLOCK_END}\n\n` +
		`A human steered this run. Read the ${noun} above before you plan: where it conflicts with the journal's planned next action, the steer wins. ` +
		`Apply it, note it in the journal, and continue the workflow.`
	);
}

/** `prompt` with the Steer block at its head; unchanged when nothing is queued. */
export function prependSteerBlock(
	prompt: string,
	steers: readonly QueuedSteer[],
): string {
	if (steers.length === 0) return prompt;
	return `${buildSteerBlock(steers)}\n\n---\n\n${prompt}`;
}

/**
 * The Journal entry recording one delivered Steer: its origin, when it
 * arrived, and the Turn it was delivered into, with the text quoted so a
 * marker-like line inside it can never read as a Terminal Marker.
 */
export function formatSteerJournalEntry(
	steer: QueuedSteer,
	iteration: number,
): string {
	const quoted = steer.text
		.trim()
		.split('\n')
		.map(line => `> ${line}`)
		.join('\n');
	return (
		`\n\n---\n\n## Human steer (via ${steer.origin})\n\n` +
		`_Received ${new Date(steer.receivedAt).toISOString()}; delivered into Turn ${iteration}._\n\n` +
		`${quoted}\n`
	);
}

export type SteerListener = (steer: QueuedSteer) => void;

/**
 * A single-subscriber queue that hands Steers to whoever is running the Run.
 * Steers pushed before a subscriber exists (or after it unsubscribes) are
 * buffered and flushed, in order, to the next subscriber — so a Steer that
 * arrives before the Runner is wired up is held, never dropped.
 */
export type SteerQueue = {
	push(steer: QueuedSteer): void;
	subscribe(listener: SteerListener): () => void;
};

export function createSteerQueue(): SteerQueue {
	const buffered: QueuedSteer[] = [];
	let listener: SteerListener | null = null;
	return {
		push(steer) {
			if (listener) {
				listener(steer);
				return;
			}
			buffered.push(steer);
		},
		subscribe(next) {
			listener = next;
			for (const steer of buffered.splice(0)) next(steer);
			return () => {
				if (listener === next) listener = null;
			};
		},
	};
}
