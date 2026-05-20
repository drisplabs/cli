import type {TodoItem} from '../todo';

export type TaskLifecycleTracker = {
	current(): TodoItem[];
	upsertCreated(input: {
		taskId: string;
		subject: string;
		description?: string;
		activeForm?: string;
	}): void;
	markCompleted(input: {taskId: string; subject?: string}): void;
	updateStatus(input: {taskId: string; status: TodoItem['status']}): void;
};

export function coerceTaskStatus(status: unknown): TodoItem['status'] | null {
	switch (status) {
		case 'pending':
		case 'in_progress':
		case 'completed':
		case 'failed':
			return status;
		default:
			return null;
	}
}

export function createTaskLifecycleTracker(): TaskLifecycleTracker {
	let items: TodoItem[] = [];

	return {
		current() {
			return items;
		},
		upsertCreated({taskId, subject, description, activeForm}) {
			const task: TodoItem = {
				taskId,
				content: subject,
				status: 'pending',
				activeForm: activeForm ?? description,
			};
			const existingIndex = items.findIndex(item => item.taskId === taskId);
			if (existingIndex === -1) {
				items = [...items, task];
				return;
			}
			items = items.map((item, index) =>
				index === existingIndex
					? {
							...item,
							taskId,
							content: subject,
							activeForm: task.activeForm ?? item.activeForm,
						}
					: item,
			);
		},
		markCompleted({taskId, subject}) {
			const existingIndex = items.findIndex(item => item.taskId === taskId);
			if (existingIndex === -1) {
				if (!subject) return;
				items = [...items, {taskId, content: subject, status: 'completed'}];
				return;
			}
			items = items.map((item, index) =>
				index === existingIndex ? {...item, status: 'completed'} : item,
			);
		},
		updateStatus({taskId, status}) {
			items = items.map(item =>
				item.taskId === taskId ? {...item, status} : item,
			);
		},
	};
}
