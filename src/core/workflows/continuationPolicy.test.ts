import {describe, expect, it} from 'vitest';
import {admitContinuation, resourceInterruption} from './continuationPolicy';
import {readRestartContract, seedFromRestart} from './restartContract';
import {InterruptionSchema} from '@drisp/protocol';
const admission = {
	loop: {enabled: true, maxIterations: 20, maxRunTokens: 1000},
	iteration: 2,
	tokens: 100,
};
const text =
	'## Restart\nRun: current\nObjective: ship\nNext action: run verification\nConstraints: preserve data\nChanges: implementation complete\nOpen questions: none\nReferences: results.md\n\n## Detail\nCold history';
describe('continuation admission', () => {
	it('enforces lifetime spend and iteration bounds', () => {
		expect(admitContinuation({...admission, tokens: 1000})).toMatchObject({
			cause: 'tokens',
		});
		expect(admitContinuation({...admission, iteration: 21})).toMatchObject({
			cause: 'iterations',
		});
		expect(admitContinuation(admission)).toBeNull();
	});
	it('reserves room for work after loading a restart', () => {
		const context = {
			opening: 91000,
			required: 2000,
			ceiling: 100000,
			source: 'observed occupancy',
		};
		const stop = admitContinuation({...admission, context})!;
		expect(stop).toMatchObject({cause: 'context', used: 101000});
		expect(InterruptionSchema.parse(resourceInterruption(stop))).toMatchObject({
			resource: {cause: 'context'},
		});
		expect(
			admitContinuation({...admission, context: {...context, opening: 70000}}),
		).toBeNull();
	});
});
describe('restart contract', () => {
	it('extracts only bounded current-run state and retains constraints', () => {
		const contract = readRestartContract(text, 2000, 'current')!;
		expect(contract.text).toContain('Constraints: preserve data');
		expect(contract.text).not.toContain('Cold history');
		expect(seedFromRestart(contract, '/journal.md')).toContain(
			'Read additional sections selectively',
		);
	});
	it.each([
		text.replace('Constraints: preserve data', 'Constraints:'),
		text.replace('## Restart', '# Restart'),
		text.replace('Run: current', 'Run: previous'),
	])('rejects invalid or wrong-run state', content => {
		expect(readRestartContract(content, 2000, 'current')).toBeNull();
	});
	it('rejects oversized state without truncating constraints', () => {
		expect(readRestartContract(text, 1, 'current')).toBeNull();
	});
});
