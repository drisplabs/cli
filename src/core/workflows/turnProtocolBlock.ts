/**
 * The Turn Protocol block — the one machine-readable line of the Journal that
 * says which workflow step the Run is on (ADR 0015 §7: Athena reads the
 * Dossier, never writes it; a parse miss degrades to no projection).
 *
 * A Turn keeps this block current in the Journal, revised in place:
 *
 *     <!-- TURN_PROTOCOL
 *     step: Build
 *     step_index: 3
 *     step_total: 5
 *     -->
 *
 * `step` is required; `step_index` / `step_total` are optional positive
 * integers (index ≤ total when both are given). Unknown keys are ignored so
 * the block can grow without breaking an older runner; when a Journal carries
 * more than one block the last one wins. The Runner reads it after each Turn
 * (`parseTurnProtocolBlock`) and turns a *change* of step into exactly one
 * phase event (`createPhaseTracker`) — a Turn still on the same step emits
 * nothing, and a malformed block is reported once and otherwise ignored.
 */

/** The step a Turn Protocol block names. */
export type TurnProtocolStep = {
	name: string;
	index?: number;
	total?: number;
};

export type TurnProtocolBlockParse =
	| {kind: 'missing'}
	| {kind: 'malformed'; reason: string}
	| {kind: 'ok'; step: TurnProtocolStep};

const BLOCK_OPEN = /^\s*<!--\s*TURN_PROTOCOL\s*$/;
const BLOCK_CLOSE = /^\s*-->\s*$/;
const TRAILING_CLOSE = /\s*-->\s*$/;
const KEY_VALUE = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/;

/**
 * Parse the Turn Protocol block out of Journal text. Pure; never throws.
 * Only the block's own lines are read, so a Journal that never carries one
 * costs nothing beyond a line scan.
 */
export function parseTurnProtocolBlock(
	content: string,
): TurnProtocolBlockParse {
	const lines = content.split('\n');
	let last: string[] | null = null;
	let open: string[] | null = null;

	for (const raw of lines) {
		const line = raw.replace(/\r$/, '');
		if (open === null) {
			if (BLOCK_OPEN.test(line)) open = [];
			continue;
		}
		if (BLOCK_CLOSE.test(line)) {
			last = open;
			open = null;
			continue;
		}
		if (TRAILING_CLOSE.test(line)) {
			open.push(line.replace(TRAILING_CLOSE, ''));
			last = open;
			open = null;
			continue;
		}
		open.push(line);
	}

	if (open !== null) {
		return {
			kind: 'malformed',
			reason: 'the TURN_PROTOCOL block is never closed with -->',
		};
	}
	if (last === null) return {kind: 'missing'};
	return parseBlockLines(last);
}

function parseBlockLines(lines: string[]): TurnProtocolBlockParse {
	const fields = new Map<string, string>();
	for (const line of lines) {
		const match = KEY_VALUE.exec(line.trim());
		if (!match) continue;
		fields.set(match[1]!, match[2]!.trim());
	}

	const name = fields.get('step');
	if (name === undefined) {
		return {kind: 'malformed', reason: 'the block has no `step:` line'};
	}
	if (name.length === 0) {
		return {kind: 'malformed', reason: 'the `step:` line names no step'};
	}

	const index = parsePositiveInt(fields.get('step_index'));
	if (index.kind === 'invalid') {
		return {
			kind: 'malformed',
			reason: `\`step_index\` must be a positive integer, got "${index.raw}"`,
		};
	}
	const total = parsePositiveInt(fields.get('step_total'));
	if (total.kind === 'invalid') {
		return {
			kind: 'malformed',
			reason: `\`step_total\` must be a positive integer, got "${total.raw}"`,
		};
	}
	if (
		index.kind === 'value' &&
		total.kind === 'value' &&
		index.value > total.value
	) {
		return {
			kind: 'malformed',
			reason: `\`step_index\` (${index.value}) is past \`step_total\` (${total.value})`,
		};
	}

	return {
		kind: 'ok',
		step: {
			name,
			...(index.kind === 'value' ? {index: index.value} : {}),
			...(total.kind === 'value' ? {total: total.value} : {}),
		},
	};
}

function parsePositiveInt(
	raw: string | undefined,
):
	| {kind: 'absent'}
	| {kind: 'value'; value: number}
	| {kind: 'invalid'; raw: string} {
	if (raw === undefined || raw.length === 0) return {kind: 'absent'};
	if (!/^\d+$/.test(raw)) return {kind: 'invalid', raw};
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 1) return {kind: 'invalid', raw};
	return {kind: 'value', value};
}

/** What one Journal read means for the Run's phase. */
export type PhaseObservation =
	| {kind: 'new_step'; step: TurnProtocolStep}
	| {kind: 'same_step'}
	| {kind: 'no_block'}
	| {
			kind: 'malformed';
			reason: string;
			/** The notice to log, or `null` when this defect was already reported. */
			warning: string | null;
	  };

export type PhaseTracker = {
	observe(journalContent: string): PhaseObservation;
};

/** Two steps are the same phase when they agree on name and index. */
function sameStep(a: TurnProtocolStep, b: TurnProtocolStep): boolean {
	return a.name === b.name && a.index === b.index;
}

/**
 * Per-Run memory of the last step named, so the Runner emits one phase event
 * per change of step rather than one per Turn. A malformed block warns once
 * per distinct defect and leaves the last good step in place, so repairing
 * the block back to that step is not reported as a new phase.
 */
export function createPhaseTracker(): PhaseTracker {
	let lastStep: TurnProtocolStep | null = null;
	let lastMalformedReason: string | null = null;

	return {
		observe(journalContent) {
			const parsed = parseTurnProtocolBlock(journalContent);
			if (parsed.kind === 'missing') {
				lastMalformedReason = null;
				return {kind: 'no_block'};
			}
			if (parsed.kind === 'malformed') {
				const warning =
					parsed.reason === lastMalformedReason
						? null
						: `ignoring the journal's TURN_PROTOCOL block: ${parsed.reason}`;
				lastMalformedReason = parsed.reason;
				return {kind: 'malformed', reason: parsed.reason, warning};
			}
			lastMalformedReason = null;
			if (lastStep && sameStep(lastStep, parsed.step)) {
				lastStep = parsed.step;
				return {kind: 'same_step'};
			}
			lastStep = parsed.step;
			return {kind: 'new_step', step: parsed.step};
		},
	};
}
