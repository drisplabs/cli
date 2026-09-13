import {estimateTokenCount} from './journalReader';
import {DEFAULT_RESTART_TOKENS} from './continuationPolicy';

/** A bounded, agent-authored section; the Runner never truncates its prose. */
export type RestartContract = {text: string; tokens: number};
const fields = [
	'Objective',
	'Next action',
	'Constraints',
	'Changes',
	'Open questions',
	'References',
];

export function readRestartContract(
	content: string,
	limit = DEFAULT_RESTART_TOKENS,
	expectedRunId?: string,
): RestartContract | null {
	if ((content.match(/^## Restart[ \t]*$/gm) ?? []).length !== 1) return null;
	const match = /^## Restart\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(content);
	if (!match) return null;
	const text = match[1]!.trim();
	if (!fields.every(field => new RegExp(`^${field}:[ \t]*\\S`, 'm').test(text)))
		return null;
	if (
		expectedRunId &&
		!text.split('\n').some(line => line.trim() === `Run: ${expectedRunId}`)
	)
		return null;
	const tokens = estimateTokenCount(text);
	return tokens <= limit ? {text, tokens} : null;
}

/** Small instruction supplied once to each fresh Agent Session. */
export function restartInstructions(
	journalPath: string,
	runId: string,
	limit = DEFAULT_RESTART_TOKENS,
): string {
	return `Maintain one ## Restart section in the Journal at ${journalPath} during this Workflow Run. Include Run: ${runId}, followed by these nonempty fields: ${fields.join(', ')}. Use none where appropriate. Update it after orientation and each meaningful work checkpoint, before large reads or risky operations; keep it within ${limit} estimated tokens. Preserve essential constraints and reference supporting evidence. Write changes atomically so interruption cannot leave a partial checkpoint. The Runner may replace your Agent Session at its context bound using only this section. Do not stop to request a Handover; continue working and declare the normal terminal marker when done.`;
}

export function seedFromRestart(
	contract: RestartContract,
	checkpointPath: string,
	journalPath?: string,
): string {
	return `Continue this Workflow Run from its validated restart contract:\n\n${contract.text}\n\nThe checkpoint is in ${checkpointPath}${journalPath ? `; the Journal is at ${journalPath}` : ''}. Read additional sections selectively when the next action requires them. Update durable state only when it changes. Do not append checkpoint-processed notes or repeat completed work. Essential constraints above remain in force.`;
}
