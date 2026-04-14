const INITIAL_CAPACITY = 16;

export class Queue {
	#items = new Array(INITIAL_CAPACITY);
	#head = 0;
	#tail = 0;
	#size = 0;
	#mask = INITIAL_CAPACITY - 1;

	enqueue(value) {
		if (this.#size === this.#items.length) {
			this.#grow();
		}
		this.#items[this.#tail] = value;
		this.#tail = (this.#tail + 1) & this.#mask;
		this.#size++;
	}

	#grow() {
		const oldMask = this.#mask;
		const newCap = this.#items.length * 2;
		this.#mask = newCap - 1;
		if (this.#head === 0) {
			// Items are contiguous from index 0; extend in-place without copying.
			this.#items.length = newCap;
			this.#tail = this.#size;
		} else {
			const newItems = new Array(newCap);
			for (let i = 0; i < this.#size; i++) {
				newItems[i] = this.#items[(this.#head + i) & oldMask];
			}
			this.#items = newItems;
			this.#head = 0;
			this.#tail = this.#size;
		}
	}

	dequeue() {
		if (this.#size === 0) return null;
		const value = this.#items[this.#head];
		this.#items[this.#head] = undefined;
		this.#head = (this.#head + 1) & this.#mask;
		this.#size--;
		return value;
	}

	clear() {
		this.#items = new Array(INITIAL_CAPACITY);
		this.#head = 0;
		this.#tail = 0;
		this.#size = 0;
		this.#mask = INITIAL_CAPACITY - 1;
	}

	remove(value) {
		for (let i = 0; i < this.#size; i++) {
			const idx = (this.#head + i) & this.#mask;
			if (this.#items[idx] === value) {
				for (let j = i; j < this.#size - 1; j++) {
					const curr = (this.#head + j) & this.#mask;
					const next = (this.#head + j + 1) & this.#mask;
					this.#items[curr] = this.#items[next];
				}
				this.#tail = (this.#tail - 1) & this.#mask;
				this.#items[this.#tail] = undefined;
				this.#size--;
				return true;
			}
		}
		return false;
	}

	find(predicate) {
		for (let i = 0; i < this.#size; i++) {
			const value = this.#items[(this.#head + i) & this.#mask];
			if (predicate(value)) return value;
		}
		return null;
	}

	toArray() {
		const result = new Array(this.#size);
		for (let i = 0; i < this.#size; i++) {
			result[i] = this.#items[(this.#head + i) & this.#mask];
		}
		return result;
	}

	*values() {
		for (let i = 0; i < this.#size; i++) {
			yield this.#items[(this.#head + i) & this.#mask];
		}
	}

	peek() {
		return this.#size > 0 ? this.#items[this.#head] : null;
	}

	[Symbol.iterator]() {
		return this.values();
	}

	get size() {
		return this.#size;
	}

	isEmpty() {
		return this.#size === 0;
	}
}
