import {describe, it, expect} from 'vitest';
import {deriveAppMode} from './deriveAppMode';

const fakeEvent = {event_id: 'test'};

describe('deriveAppMode', () => {
	it('derives app mode from runtime state with correct priority', () => {
		// Idle when Claude is not running
		expect(deriveAppMode(false, null, null)).toEqual({type: 'idle'});

		// Idle even with stale requests (Claude not running)
		expect(deriveAppMode(false, fakeEvent, fakeEvent)).toEqual({type: 'idle'});

		// Startup failures take precedence over all other states
		expect(
			deriveAppMode(true, fakeEvent, fakeEvent, 'Socket path too long'),
		).toEqual({
			type: 'startup_failed',
			message: 'Socket path too long',
		});

		// Working when Claude is running, no dialogs
		expect(deriveAppMode(true, null, null)).toEqual({type: 'working'});

		// Permission takes precedence over question
		expect(deriveAppMode(true, fakeEvent, fakeEvent)).toEqual({
			type: 'permission',
		});

		// Permission when only permission request exists
		expect(deriveAppMode(true, fakeEvent, null)).toEqual({type: 'permission'});

		// Question when only question request exists
		expect(deriveAppMode(true, null, fakeEvent)).toEqual({type: 'question'});
	});
});
