import {describe, it, expect, vi, beforeEach} from 'vitest';

const resolveMarketplacePluginMock = vi.fn();

// Real isMarketplaceRef regex (marketplaceShared.ts) so branch selection is
// authentic; resolveMarketplacePlugin is mocked so the seam never spawns git.
vi.mock('../marketplace', () => ({
	isMarketplaceRef: (entry: string) =>
		/^[a-zA-Z0-9_-]+@[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(entry),
	resolveMarketplacePlugin: (ref: string) => resolveMarketplacePluginMock(ref),
}));

const {resolvePluginDirs} = await import('../pluginRefResolution');

beforeEach(() => {
	resolveMarketplacePluginMock.mockReset();
});

describe('resolvePluginDirs', () => {
	it('passes through non-marketplace entries unchanged (already resolved paths)', () => {
		const result = resolvePluginDirs([
			'/absolute/plugin',
			'/project/relative/one',
		]);

		expect(result).toEqual({
			dirs: ['/absolute/plugin', '/project/relative/one'],
			warnings: [],
		});
		expect(resolveMarketplacePluginMock).not.toHaveBeenCalled();
	});

	it('resolves marketplace refs via resolveMarketplacePlugin', () => {
		resolveMarketplacePluginMock.mockReturnValue(
			'/resolved/marketplace/plugin',
		);

		const result = resolvePluginDirs(['my-plugin@owner/repo']);

		expect(resolveMarketplacePluginMock).toHaveBeenCalledWith(
			'my-plugin@owner/repo',
		);
		expect(result).toEqual({
			dirs: ['/resolved/marketplace/plugin'],
			warnings: [],
		});
	});

	it('skips refs that fail to resolve, collecting a warning instead of writing stderr', () => {
		resolveMarketplacePluginMock.mockImplementation(() => {
			throw new Error('Plugin "bad-plugin" not found in marketplace');
		});
		const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = resolvePluginDirs([
			'/absolute/plugin',
			'bad-plugin@owner/repo',
			'/project/relative/plugin',
		]);

		expect(result.dirs).toEqual([
			'/absolute/plugin',
			'/project/relative/plugin',
		]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain('bad-plugin@owner/repo');
		expect(stderrSpy).not.toHaveBeenCalled();

		stderrSpy.mockRestore();
	});

	it('preserves input order across mixed entries', () => {
		resolveMarketplacePluginMock.mockReturnValue(
			'/resolved/marketplace/plugin',
		);

		const result = resolvePluginDirs([
			'/absolute/plugin',
			'my-plugin@owner/repo',
			'/project/relative/plugin',
		]);

		expect(result.dirs).toEqual([
			'/absolute/plugin',
			'/resolved/marketplace/plugin',
			'/project/relative/plugin',
		]);
		expect(result.warnings).toEqual([]);
	});
});
