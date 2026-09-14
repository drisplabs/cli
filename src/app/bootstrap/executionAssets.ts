import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const owned = new Map<string, string>();
let cleanupInstalled = false;

/** Each preparation has a private directory; another execution never rewrites it. */
export function writeMcpAsset(contents: string): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'drisp-mcp-'));
	const file = path.join(directory, 'config.json');
	owned.set(file, directory);
	if (!cleanupInstalled) {
		cleanupInstalled = true;
		process.once('exit', () => {
			for (const file of owned.keys()) {
				try {
					releaseMcpAsset(file);
				} catch {
					/* Process exit cannot await recovery. */
				}
			}
		});
	}
	try {
		fs.writeFileSync(file, contents, {mode: 0o600});
		return file;
	} catch (error) {
		releaseMcpAsset(file);
		throw error;
	}
}

/** Only deletes assets created here, never a caller's own configuration file. */
export function releaseMcpAsset(file?: string): void {
	if (!file) return;
	const directory = owned.get(file);
	if (!directory) return;
	fs.rmSync(directory, {recursive: true, force: true});
	owned.delete(file);
}
