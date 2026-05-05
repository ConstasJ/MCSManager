export interface IQueueItem<T> {
	key: string;
	item: T;
}

export class ConsumerQueue<T> {
	private items: IQueueItem<T>[] = [];

	constructor(private readonly maxSize: number) {}

	push(item: IQueueItem<T>) {
		if (this.items.length >= this.maxSize) {
			this.items.shift();
		}
		// Remove existing item with same key to avoid duplicates
		const existingIndex = this.items.findIndex((v) => v.key === item.key);
		if (existingIndex >= 0) {
			this.items.splice(existingIndex, 1);
		}
		this.items.push(item);
	}

	pop() {
		const v = this.items.shift();
		if (v) {
			return v.item;
		}
		return undefined;
	}

	size() {
		return this.items.length;
	}

	clear() {
		this.items = [];
	}

	isEmpty() {
		return this.items.length === 0;
	}
}
