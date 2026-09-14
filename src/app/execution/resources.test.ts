import {expect, it, vi} from 'vitest';
import {createExecutionResources} from './resources';
it('releases every resource once, in reverse order, even after failure', async () => {
	const resources = createExecutionResources();
	const order: number[] = [];
	resources.own(() => {
		order.push(1);
	});
	resources.own(() => {
		order.push(2);
		throw new Error('close failed');
	});
	resources.own(async () => {
		order.push(3);
	});
	const first = resources.dispose();
	expect(resources.dispose()).toBe(first);
	await expect(first).rejects.toThrow('cleanup failed');
	expect(order).toEqual([3, 2, 1]);
	expect(() => resources.own(vi.fn())).toThrow('after execution disposal');
});
