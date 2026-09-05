import {describe, expect, it} from 'vitest';
import {ExhaustedCapSchema, InterruptionSchema} from './domain';

describe('ExhaustedCapSchema', () => {
	it.each(['retry', 'nudge', 'iterations', 'handover'])(
		'accepts the %s cap',
		cap => {
			expect(ExhaustedCapSchema.safeParse(cap).success).toBe(true);
			expect(
				InterruptionSchema.safeParse({
					kind: 'cap_exhausted',
					message: `${cap} reached`,
					cap,
					limit: 3,
				}).success,
			).toBe(true);
		},
	);

	it('rejects a cap it does not know', () => {
		expect(ExhaustedCapSchema.safeParse('patience').success).toBe(false);
	});
});
