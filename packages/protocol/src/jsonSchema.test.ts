import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {
	FrameSchema,
	InterruptionSchema,
	JSON_SCHEMA_SOURCES,
	PROTOCOL_VERSION,
	buildJsonSchemas,
} from './index';

const schemaDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../schema',
);

function readCheckedIn(name: string): unknown {
	return JSON.parse(
		fs.readFileSync(path.join(schemaDir, `${name}.json`), 'utf8'),
	);
}

describe('JSON Schema export', () => {
	it('checks in exactly one file per exported schema', () => {
		const files = fs
			.readdirSync(schemaDir)
			.filter(f => f.endsWith('.json'))
			.map(f => f.replace(/\.json$/, ''))
			.sort();
		expect(files).toEqual(Object.keys(JSON_SCHEMA_SOURCES).sort());
	});

	it.each(Object.keys(JSON_SCHEMA_SOURCES))(
		'schema/%s.json matches a fresh generation (run `npm run schema:generate` if not)',
		name => {
			const fresh =
				buildJsonSchemas()[name as keyof typeof JSON_SCHEMA_SOURCES];
			expect(readCheckedIn(name)).toEqual(fresh);
		},
	);

	it('stamps every document with the protocol version and a draft 2020-12 $schema', () => {
		for (const doc of Object.values(buildJsonSchemas())) {
			expect(doc['x-protocol-version']).toBe(PROTOCOL_VERSION);
			expect(doc['$schema']).toBe(
				'https://json-schema.org/draft/2020-12/schema',
			);
			expect(String(doc['$id'])).toMatch(
				/\/packages\/protocol\/schema\/[a-z-]+\.json$/,
			);
		}
	});

	it('the frame document enumerates every frame name the zod union accepts', () => {
		const doc = buildJsonSchemas().frame as {
			anyOf?: Array<Record<string, unknown>>;
			oneOf?: Array<Record<string, unknown>>;
		};
		const variants = doc.anyOf ?? doc.oneOf ?? [];
		const names = new Set<string>();
		const collect = (variant: Record<string, unknown>): void => {
			const nested = (variant['anyOf'] ?? variant['oneOf']) as
				| Array<Record<string, unknown>>
				| undefined;
			if (nested) {
				for (const v of nested) collect(v);
				return;
			}
			const props = variant['properties'] as
				| Record<string, {const?: string}>
				| undefined;
			const type = props?.['type']?.const;
			if (type) names.add(type);
		};
		for (const v of variants) collect(v);
		expect([...names].sort()).toEqual(
			[
				...new Set(
					FrameSchema.options.flatMap(o => [
						...(o._zod.propValues['type'] ?? []),
					]),
				),
			].sort(),
		);
	});

	it('does not emit unrepresentable placeholders for typed domain values', () => {
		const doc = JSON.stringify(buildJsonSchemas().interruption);
		for (const kind of InterruptionSchema.options.map(
			o => o.shape.kind.value,
		)) {
			expect(doc).toContain(`"const":"${kind}"`);
		}
	});
});
