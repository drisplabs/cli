/** Own resources in acquisition order and release all of them in reverse order. */
export function createExecutionResources() {
	const releases: Array<() => void | Promise<void>> = [];
	let closing: Promise<void> | undefined;
	return {
		own(release: () => void | Promise<void>): void {
			if (closing)
				throw new Error('Cannot acquire resources after execution disposal');
			releases.push(release);
		},
		dispose(): Promise<void> {
			closing ??= Promise.resolve().then(async () => {
				const failures: unknown[] = [];
				for (const release of releases.reverse()) {
					try {
						await release();
					} catch (error) {
						failures.push(error);
					}
				}
				releases.length = 0;
				if (failures.length)
					throw new AggregateError(failures, 'Execution cleanup failed');
			});
			return closing;
		},
	};
}
