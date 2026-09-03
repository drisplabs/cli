import {describe, expect, it} from 'vitest';
import {PhaseFeedEventSchema} from '@drisp/protocol';
import {buildPhaseFeedEvent} from './phaseFeedEvent';
import {eventOperation, eventLabel, eventSummary} from './timeline';

const phase = {
	runId: 'run_42',
	turn: 3,
	step: 'Build',
	stepIndex: 2,
	stepTotal: 5,
};

describe('buildPhaseFeedEvent', () => {
	it('projects a phase change into a FeedEvent of kind "phase"', () => {
		const event = buildPhaseFeedEvent({
			phase,
			sessionId: 'adapter-1',
			runId: 'adapter-1:R1',
			seq: 12,
			ts: 1_700_000_000_000,
		});
		expect(event).toEqual({
			event_id: 'run_42:phase:3',
			seq: 12,
			ts: 1_700_000_000_000,
			session_id: 'adapter-1',
			run_id: 'adapter-1:R1',
			kind: 'phase',
			level: 'info',
			actor_id: 'system',
			title: 'Step 2/5: Build',
			data: phase,
		});
	});

	it('titles a step without an index by name alone', () => {
		const event = buildPhaseFeedEvent({
			phase: {runId: 'run_42', turn: 1, step: 'Orient'},
			sessionId: 'adapter-1',
			runId: 'adapter-1:R1',
			seq: 1,
			ts: 1,
		});
		expect(event.title).toBe('Step: Orient');
		expect(event.data).toEqual({runId: 'run_42', turn: 1, step: 'Orient'});
	});

	it('is the shape @drisp/protocol publishes to the hub', () => {
		const event = buildPhaseFeedEvent({
			phase,
			sessionId: 'adapter-1',
			runId: 'adapter-1:R1',
			seq: 12,
			ts: 1,
		});
		expect(PhaseFeedEventSchema.safeParse(event).success).toBe(true);
	});

	it('renders as a step line in the timeline', () => {
		const event = buildPhaseFeedEvent({
			phase,
			sessionId: 'adapter-1',
			runId: 'adapter-1:R1',
			seq: 12,
			ts: 1,
		});
		expect(eventOperation(event)).toBe('phase');
		expect(eventLabel(event)).toBe('Step');
		expect(eventSummary(event).text).toBe('Build (2/5)');
	});
});
