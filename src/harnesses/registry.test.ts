import {describe, expect, it, vi} from 'vitest';
import {
	listHarnessAdapters,
	listHarnessCapabilities,
	resolveHarnessAdapter,
} from './registry';

describe('harness registry', () => {
	it('resolves the concrete adapter for supported harnesses', () => {
		expect(resolveHarnessAdapter('claude-code').id).toBe('claude-code');
		expect(resolveHarnessAdapter('openai-codex').id).toBe('openai-codex');
	});

	it('falls back to the claude adapter for unknown harness ids', () => {
		expect(resolveHarnessAdapter('unknown-harness' as never).id).toBe(
			'claude-code',
		);
	});

	it('exposes harness capabilities from the adapter registry', () => {
		expect(listHarnessAdapters().map(adapter => adapter.id)).toEqual([
			'claude-code',
			'openai-codex',
			'opencode',
		]);
		expect(listHarnessCapabilities()).toEqual([
			expect.objectContaining({
				id: 'claude-code',
				label: 'Claude Code',
				enabled: true,
			}),
			expect.objectContaining({
				id: 'openai-codex',
				label: 'OpenAI Codex',
				enabled: true,
			}),
			expect.objectContaining({
				id: 'opencode',
				label: 'OpenCode (coming soon)',
				enabled: false,
			}),
		]);
	});

	it('declares semantic capabilities per adapter', () => {
		const claude = resolveHarnessAdapter('claude-code');
		expect(claude.capabilities).toEqual({
			conversationModel: 'fresh_per_turn',
			killWaitsForTurnSettlement: true,
			supportsEphemeralSessions: false,
			supportsConfigurableIsolation: true,
		});

		const codex = resolveHarnessAdapter('openai-codex');
		expect(codex.capabilities).toEqual({
			conversationModel: 'persistent_thread',
			killWaitsForTurnSettlement: true,
			supportsEphemeralSessions: true,
			supportsConfigurableIsolation: true,
		});
	});
});

describe('harness model catalog', () => {
	it('exposes the built-in Claude model options through the claude adapter', async () => {
		await expect(
			resolveHarnessAdapter('claude-code').listModels(),
		).resolves.toEqual([
			expect.objectContaining({value: 'sonnet', label: 'Sonnet'}),
			expect.objectContaining({value: 'opus', label: 'Opus'}),
			expect.objectContaining({value: 'haiku', label: 'Haiku'}),
			expect.objectContaining({value: 'opusplan', label: 'OpusPlan'}),
		]);
	});

	it('maps the active Codex runtime models through the codex adapter', async () => {
		const runtime = {
			listModels: vi.fn().mockResolvedValue([
				{
					id: 'm1',
					model: 'gpt-5.4',
					displayName: 'GPT-5.4',
					description: 'Latest frontier agentic coding model.',
					hidden: false,
					isDefault: true,
				},
			]),
		};

		await expect(
			resolveHarnessAdapter('openai-codex').listModels(runtime as never),
		).resolves.toEqual([
			{
				value: 'gpt-5.4',
				label: 'GPT-5.4',
				description: 'Latest frontier agentic coding model.',
				isDefault: true,
			},
		]);
		expect(runtime.listModels).toHaveBeenCalledTimes(1);
	});

	it('rejects when the codex adapter has no live runtime to query', async () => {
		await expect(
			resolveHarnessAdapter('openai-codex').listModels(),
		).rejects.toThrow('Codex runtime is not available');
	});

	it('exposes no models for the opencode adapter', async () => {
		await expect(
			resolveHarnessAdapter('opencode').listModels(),
		).resolves.toEqual([]);
	});
});
