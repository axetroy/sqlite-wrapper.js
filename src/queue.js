const COMPACT_THRESHOLD = 1024;

export class Queue {
	#items = [];
	#head = 0;

	enqueue(value) {
		this.#items.push(value);
	}

	dequeue() {
		if (this.#head >= this.#items.length) return null;

		const value = this.#items[this.#head++];

		if (this.#head >= COMPACT_THRESHOLD && this.#head * 2 >= this.#items.length) {
			this.#items = this.#items.slice(this.#head);
			this.#head = 0;
		}

		return value;
	}

	clear() {
		this.#items = [];
		this.#head = 0;
	}

	find(predicate) {
		for (let i = this.#head; i < this.#items.length; i++) {
			const value = this.#items[i];
			if (predicate(value)) return value;
		}

		return null;
	}

	toArray() {
		if (this.#head === 0) return [...this.#items];
		return this.#items.slice(this.#head);
	}

	*values() {
		for (let i = this.#head; i < this.#items.length; i++) {
			yield this.#items[i];
		}
	}

	peek() {
		return this.#head < this.#items.length ? this.#items[this.#head] : null;
	}

	[Symbol.iterator]() {
		return this.values();
	}

	get size() {
		return this.#items.length - this.#head;
	}

	isEmpty() {
		return this.#head >= this.#items.length;
	}
}
