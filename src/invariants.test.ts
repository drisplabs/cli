import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import {inspectSource, scanArchitecture} from '../scripts/architecture/check';

describe('architectural ownership', () => {
	it('checks the current source tree', () => {
		const root = fileURLToPath(new URL('..', import.meta.url));
		const result = scanArchitecture(root);
		expect(result.files.length).toBeGreaterThan(0);
		expect(result.violations).toEqual([]);
	});
	it('rejects imports and re-exports through normalized relative paths', () => {
		expect(
			inspectSource(
				'src/core/workflows/example.ts',
				`
   import {x} from '../../app/../app/exec/runner';
   export {y} from '../../harnesses/registry';
   const lazy = import('../../app/exec/runner');
   type T = import('../../app/exec/runner').T;
  `,
			),
		).toHaveLength(4);
		expect(
			inspectSource(
				'src/app/example.ts',
				`import {x} from '../core/workflows/types';`,
			),
		).toEqual([]);
	});
	it('rejects unauthorized FeedEvent production and workflow React imports', () => {
		expect(
			inspectSource(
				'src/app/rogue.ts',
				`const event = {event_id: 'e', seq: 1, kind: 'phase'};`,
			),
		).toHaveLength(1);
		expect(
			inspectSource(
				'src/core/workflows/rogue.ts',
				`import {useState} from 'react';`,
			),
		).toHaveLength(1);
		expect(
			inspectSource(
				'src/core/feed/phaseFeedEvent.ts',
				`const event = {event_id: 'e', seq: 1, kind: 'phase'};`,
			),
		).toEqual([]);
	});
	it('cannot pass on missing or empty input', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drisp-architecture-'));
		try {
			expect(() => scanArchitecture(root)).toThrow();
			fs.mkdirSync(path.join(root, 'src'));
			expect(() => scanArchitecture(root)).toThrow('no production source');
		} finally {
			fs.rmSync(root, {recursive: true, force: true});
		}
	});
	it('does not scan a nested checkout', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drisp-scope-'));
		try {
			fs.mkdirSync(path.join(root, 'src'));
			fs.writeFileSync(path.join(root, 'src', 'entry.ts'), 'export {};');
			const nested = path.join(
				root,
				'.claude',
				'worktrees',
				'other',
				'src',
				'core',
			);
			fs.mkdirSync(nested, {recursive: true});
			fs.writeFileSync(
				path.join(nested, 'bad.ts'),
				`import x from '../app/x';`,
			);
			expect(scanArchitecture(root).files).toHaveLength(1);
		} finally {
			fs.rmSync(root, {recursive: true, force: true});
		}
	});
});
