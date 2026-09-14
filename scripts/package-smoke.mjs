import assert from 'node:assert/strict';
import fs from 'node:fs';
import process from 'node:process';
import {spawnSync} from 'node:child_process';
import {URL, fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(
	fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
for (const entry of new Set(Object.values(pkg.bin))) {
	assert.ok(
		fs.existsSync(new URL('../' + entry, import.meta.url)),
		`Missing packaged entry: ${entry}`,
	);
}
function run(entry, args, input = '') {
	const result = spawnSync(process.execPath, [entry, ...args], {
		cwd: root,
		input,
		encoding: 'utf8',
		timeout: 15000,
		env: {...process.env, ATHENA_TELEMETRY_DISABLED: '1'},
	});
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}
assert.equal(run('dist/cli.js', ['--version']).trim(), pkg.version);
assert.match(run('dist/cli.js', ['--help']), /Usage/);
assert.match(run('dist/runner.js', ['--help']), /paired runner service/);
assert.match(
	run('dist/dashboard-daemon.js', ['--help']),
	/paired runner service/,
);
run('dist/hook-forwarder.js', [], 'invalid hook input');
const protocol = await import('@drisp/protocol');
assert.equal(typeof protocol.PROTOCOL_VERSION, 'number');
assert.equal(typeof protocol.normalizeFrame, 'function');
assert.equal(typeof protocol.FrameSchema.safeParse, 'function');
assert.equal(
	protocol.FrameSchema.safeParse({type: 'not-a-frame'}).success,
	false,
);
process.stdout.write(
	'CLI, runner, compatibility entry, hook forwarder, and protocol smoke checks passed.\n',
);
