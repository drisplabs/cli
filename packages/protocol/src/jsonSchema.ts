/**
 * JSON Schema export. `buildJsonSchemas()` is the single source the checked-in
 * `schema/*.json` files are generated from (`npm run schema:generate`) and
 * that `jsonSchema.test.ts` diffs them against, so they cannot drift.
 */
import {z} from 'zod';
import {
	InterruptionSchema,
	RunSchema,
	RunSpecSchema,
	RuntimeDecisionSchema,
	TurnSchema,
} from './domain';
import {
	FeedEnvelopeSchema,
	FeedEventSchema,
	RunStreamEventSchema,
} from './events';
import {
	CanonicalFrameSchema,
	FrameSchema,
	HelloFrameSchema,
	LegacyFrameSchema,
} from './frames';
import {PROTOCOL_VERSION} from './version';

/** File stem → zod schema. One `schema/<stem>.json` per entry. */
export const JSON_SCHEMA_SOURCES = {
	frame: FrameSchema,
	'canonical-frame': CanonicalFrameSchema,
	'legacy-frame': LegacyFrameSchema,
	hello: HelloFrameSchema,
	run: RunSchema,
	turn: TurnSchema,
	interruption: InterruptionSchema,
	'run-spec': RunSpecSchema,
	'runtime-decision': RuntimeDecisionSchema,
	'run-stream-event': RunStreamEventSchema,
	'feed-event': FeedEventSchema,
	'feed-envelope': FeedEnvelopeSchema,
} as const;

export type JsonSchemaName = keyof typeof JSON_SCHEMA_SOURCES;

export type JsonSchemaDocument = Record<string, unknown>;

export function jsonSchemaId(name: JsonSchemaName): string {
	return `https://raw.githubusercontent.com/drisplabs/cli/main/packages/protocol/schema/${name}.json`;
}

/** Generate every JSON Schema document, keyed by file stem. */
export function buildJsonSchemas(): Record<JsonSchemaName, JsonSchemaDocument> {
	const out = {} as Record<JsonSchemaName, JsonSchemaDocument>;
	for (const name of Object.keys(JSON_SCHEMA_SOURCES) as JsonSchemaName[]) {
		const generated = z.toJSONSchema(JSON_SCHEMA_SOURCES[name], {
			target: 'draft-2020-12',
			unrepresentable: 'any',
		});
		out[name] = {
			$schema: generated.$schema,
			$id: jsonSchemaId(name),
			title: name,
			'x-protocol-version': PROTOCOL_VERSION,
			...generated,
		};
	}
	return out;
}
