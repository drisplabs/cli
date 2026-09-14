import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {it, expect} from 'vitest';
import {writeMcpAsset, releaseMcpAsset} from './executionAssets';

it('keeps concurrent preparations private and releases only generated assets', () => {
	const first = writeMcpAsset('{"server":"one"}');
	const second = writeMcpAsset('{"server":"two"}');
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'drisp-user-mcp-'));
	const userFile = path.join(directory, 'config.json');
	fs.writeFileSync(userFile, 'user-owned');
	try {
		expect(first).not.toBe(second);
		expect(fs.readFileSync(first, 'utf8')).toContain('one');
		expect(fs.statSync(first).mode & 0o777).toBe(0o600);
		releaseMcpAsset(first);
		releaseMcpAsset(first);
		expect(fs.existsSync(first)).toBe(false);
		expect(fs.readFileSync(second, 'utf8')).toContain('two');
		releaseMcpAsset(userFile);
		expect(fs.readFileSync(userFile, 'utf8')).toBe('user-owned');
	} finally {
		releaseMcpAsset(first);
		releaseMcpAsset(second);
		fs.rmSync(directory, {recursive: true, force: true});
	}
});
