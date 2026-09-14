import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {executionIdentity, validateResumeIdentity} from './executionIdentity';
import type {PersistedWorkflowRun} from '../../core/workflows/runState';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		fs.rmSync(dir, {recursive: true, force: true});
});
const run: PersistedWorkflowRun = {
	id: 'run',
	sessionId: 'session',
	workflowName: 'fix',
	startedAt: 0,
	iteration: 2,
	maxIterations: 10,
	status: 'awaiting_attention',
};
describe('execution identity', () => {
	it('rejects changed instructions even when the workflow name is unchanged', () => {
		const projectDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'drisp-identity-'),
		);
		dirs.push(projectDir);
		const workflowFile = path.join(projectDir, 'workflow.md');
		fs.writeFileSync(workflowFile, 'original');
		const input = {
			projectDir,
			harness: 'claude-code',
			workflow: {
				name: 'fix',
				plugins: [],
				promptTemplate: '{input}',
				workflowFile,
			},
		};
		const original = executionIdentity(input);
		expect(
			validateResumeIdentity(
				{...run, executionIdentityJson: original},
				original,
				'fix',
			),
		).toBeUndefined();
		fs.writeFileSync(workflowFile, 'changed');
		expect(() =>
			validateResumeIdentity(
				{...run, executionIdentityJson: original},
				executionIdentity(input),
				'fix',
			),
		).toThrow('changed');
	});
	it('rejects switching workflows and visibly degrades historical runs', () => {
		const identity = executionIdentity({
			projectDir: '.',
			harness: 'claude-code',
		});
		expect(() => validateResumeIdentity(run, identity, 'other')).toThrow(
			'Cannot continue',
		);
		expect(validateResumeIdentity(run, identity, 'fix')).toContain(
			'historical',
		);
	});
	it('does not save environment values and rejects malformed identities', () => {
		const identity = executionIdentity({
			projectDir: '.',
			harness: 'claude-code',
			workflow: {
				name: 'fix',
				plugins: [],
				promptTemplate: '{input}',
				env: {TOKEN: 'secret-value'},
			},
		});
		expect(identity).not.toContain('secret-value');
		for (const value of ['null', 'bad', '{}', '{"version":99}']) {
			expect(() =>
				validateResumeIdentity(
					{...run, executionIdentityJson: value},
					identity,
					'fix',
				),
			).toThrow();
		}
	});
});

it('pins installed plugin contents, tool grants, and effort but permits credential refresh', () => {
	const projectDir = fs.mkdtempSync(
		path.join(os.tmpdir(), 'drisp-plugin-identity-'),
	);
	dirs.push(projectDir);
	fs.writeFileSync(path.join(projectDir, 'SKILL.md'), 'original instructions');
	fs.writeFileSync(
		path.join(projectDir, '.mcp.json'),
		JSON.stringify({
			mcpServers: {tool: {command: 'tool', env: {TOKEN: 'first'}}},
		}),
	);
	const input = {
		projectDir,
		harness: 'claude-code',
		isolationConfig: {
			pluginDirs: [projectDir],
			allowedTools: ['Read'],
			effort: 'high',
		},
	};
	const identity = executionIdentity(input);
	fs.writeFileSync(
		path.join(projectDir, '.mcp.json'),
		JSON.stringify({
			mcpServers: {tool: {command: 'tool', env: {TOKEN: 'second'}}},
		}),
	);
	expect(executionIdentity(input)).toBe(identity);
	expect(
		executionIdentity({
			...input,
			isolationConfig: {...input.isolationConfig, allowedTools: ['Bash']},
		}),
	).not.toBe(identity);
	expect(
		executionIdentity({
			...input,
			isolationConfig: {...input.isolationConfig, effort: 'low'},
		}),
	).not.toBe(identity);
	fs.writeFileSync(path.join(projectDir, 'SKILL.md'), 'changed instructions');
	expect(executionIdentity(input)).not.toBe(identity);
});

it.each(['personal', 'workflow'] as const)(
	'pins effective %s MCP launch settings while allowing credential refresh',
	source => {
		const projectDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'drisp-effective-mcp-'),
		);
		dirs.push(projectDir);
		const mcpConfig = path.join(projectDir, 'effective.json');
		const workflow = {name: 'fix', plugins: [], promptTemplate: '{input}'};
		const input = {
			projectDir,
			harness: 'claude-code',
			workflow,
			...(source === 'personal'
				? {pluginMcpConfig: mcpConfig}
				: {
						workflowPlan: {
							workflow,
							resolvedPlugins: [],
							localPlugins: [],
							agentRoots: [],
							codexPlugins: [],
							pluginMcpConfig: mcpConfig,
						},
					}),
		};
		const write = (config: Record<string, unknown>) =>
			fs.writeFileSync(mcpConfig, JSON.stringify({mcpServers: config}));
		write({
			tool: {
				command: 'original',
				args: ['serve'],
				env: {TOKEN: 'secret-one'},
				headers: {Authorization: 'old'},
				url: 'https://old.example',
			},
		});
		const original = executionIdentity(input);
		write({
			tool: {
				url: 'https://new.example',
				headers: {Authorization: 'new'},
				env: {TOKEN: 'secret-two'},
				args: ['serve'],
				command: 'original',
			},
		});
		expect(executionIdentity(input)).toBe(original);
		for (const changed of [
			{tool: {command: 'replacement', args: ['serve']}},
			{tool: {command: 'original', args: ['different']}},
			{},
		]) {
			write(changed);
			expect(() =>
				validateResumeIdentity(
					{...run, executionIdentityJson: original},
					executionIdentity(input),
					'fix',
				),
			).toThrow('changed');
		}
	},
);
