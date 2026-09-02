/**
 * Regenerate `schema/*.json` from the zod schemas.
 *
 *   npm run schema:generate            (from the repo root)
 *
 * `src/jsonSchema.test.ts` fails when the checked-in files differ from a fresh
 * generation, so run this after any change to the schemas and commit the
 * result.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildJsonSchemas} from '../src/jsonSchema';

const schemaDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../schema',
);

fs.mkdirSync(schemaDir, {recursive: true});
const docs = buildJsonSchemas();
const wanted = new Set(Object.keys(docs).map(name => `${name}.json`));

for (const stale of fs.readdirSync(schemaDir)) {
	if (stale.endsWith('.json') && !wanted.has(stale)) {
		fs.rmSync(path.join(schemaDir, stale));
		console.log(`removed schema/${stale}`);
	}
}

for (const [name, doc] of Object.entries(docs)) {
	const file = path.join(schemaDir, `${name}.json`);
	fs.writeFileSync(file, JSON.stringify(doc, null, '\t') + '\n');
	console.log(`wrote schema/${name}.json`);
}
