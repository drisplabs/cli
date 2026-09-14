import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const forbidden: Record<string, readonly string[]> = {
	core: ['app', 'harnesses', 'ui'],
	infra: ['app', 'ui'],
	harnesses: ['app', 'ui'],
	shared: ['app', 'core', 'harnesses', 'infra', 'ui'],
	ui: ['harnesses', 'infra'],
};

/** Resolve relative imports before checking ownership: ../ depth is irrelevant. */
export function inspectSource(file: string, text: string): string[] {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const violations: string[] = [];
	const layer = file.split('/')[1]!;
	function visit(node: ts.Node): void {
		let specifier: string | undefined;
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		)
			specifier = node.moduleSpecifier.text;
		else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments[0] &&
			ts.isStringLiteral(node.arguments[0])
		)
			specifier = node.arguments[0].text;
		else if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument) &&
			ts.isStringLiteral(node.argument.literal)
		)
			specifier = node.argument.literal.text;
		if (specifier !== undefined) {
			const target = specifier.startsWith('.')
				? path.posix.normalize(
						path.posix.join(path.posix.dirname(file), specifier),
					)
				: specifier;
			const targetLayer = target.split('/')[1];
			if (
				target === 'src/runtime/types' ||
				(file.startsWith('src/core/workflows/') &&
					(specifier === 'react' || specifier.startsWith('react/')))
			)
				violations.push(`${file}: obsolete or UI dependency ${target}`);
			if (
				target.startsWith('src/') &&
				forbidden[layer]?.includes(targetLayer!)
			) {
				violations.push(`${file}: forbidden dependency on ${target}`);
			}
		}
		if (ts.isObjectLiteralExpression(node)) {
			const keys = new Set(
				node.properties.flatMap(prop =>
					prop.name &&
					(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
						? [prop.name.text]
						: [],
				),
			);
			if (
				keys.has('event_id') &&
				keys.has('seq') &&
				keys.has('kind') &&
				!file.startsWith('src/core/feed/') &&
				![
					'src/app/dashboard/liveTransportHarness.ts',
					'src/app/dashboard/artifactCapture.ts',
				].includes(file)
			) {
				violations.push(
					`${file}: FeedEvent production belongs to core/feed projections`,
				);
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	return violations;
}

export function scanArchitecture(root: string): {
	files: string[];
	violations: string[];
} {
	const sourceRoot = path.join(root, 'src');
	if (!fs.statSync(sourceRoot).isDirectory())
		throw new Error('Missing src directory');
	const files = ts.sys.readDirectory(
		sourceRoot,
		['.ts', '.tsx'],
		[
			'**/generated/**',
			'**/.claude/**',
			'**/.worktrees/**',
			'**/*.test.*',
			'**/__tests__/**',
			'**/__sentinels__/**',
		],
		['**/*'],
	);
	if (files.length === 0)
		throw new Error('Architecture scan found no production source');
	return {
		files,
		violations: files.flatMap(file =>
			inspectSource(
				path.relative(root, file).split(path.sep).join('/'),
				fs.readFileSync(file, 'utf8'),
			),
		),
	};
}
