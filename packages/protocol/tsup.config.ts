import {defineConfig} from 'tsup';

export default defineConfig({
	entry: {index: 'src/index.ts'},
	format: ['esm'],
	target: 'node18',
	outDir: 'dist',
	clean: true,
	dts: true,
	sourcemap: true,
	external: ['zod'],
});
