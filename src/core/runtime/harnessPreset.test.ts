import {describe, expect, it} from 'vitest';
import {
	HARNESS_PROCESS_PRESETS,
	LEGACY_HARNESS_PROCESS_PRESETS,
	resolveHarnessProcessPreset,
} from './process';

describe('resolveHarnessProcessPreset (#185)', () => {
	it('lists exactly the three presets, guarded first as the default', () => {
		expect(HARNESS_PROCESS_PRESETS).toEqual([
			'guarded',
			'standard',
			'autonomous',
		]);
	});

	it.each(HARNESS_PROCESS_PRESETS)(
		'resolves the current name %s to itself with no deprecation',
		name => {
			expect(resolveHarnessProcessPreset(name)).toEqual({preset: name});
		},
	);

	it('maps every old preset name 1:1 onto a new one', () => {
		expect(LEGACY_HARNESS_PROCESS_PRESETS).toEqual({
			strict: 'guarded',
			minimal: 'standard',
			permissive: 'autonomous',
		});
	});

	it.each([
		['strict', 'guarded'],
		['minimal', 'standard'],
		['permissive', 'autonomous'],
	])(
		'resolves the old name %s to %s and explains the deprecation',
		(from, to) => {
			const resolved = resolveHarnessProcessPreset(from);
			expect(resolved?.preset).toBe(to);
			expect(resolved?.deprecation).toContain(`'${from}'`);
			expect(resolved?.deprecation).toContain(`'${to}'`);
			expect(resolved?.deprecation).toContain('0.7.0');
		},
	);

	it('returns null for a name it does not know', () => {
		expect(resolveHarnessProcessPreset('bogus')).toBeNull();
		expect(resolveHarnessProcessPreset('')).toBeNull();
	});
});
