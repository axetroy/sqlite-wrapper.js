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
		// Reuse the existing backing array (avoids allocation + GC pressure on hot paths
		// such as #restoreDeferred which calls clear() on every exclusive-zone exit).
		// #mask stays valid: it equals #items.length - 1 and the array length is unchanged.
		this.#items.fill(undefined);
		this.#head = 0;
		this.#tail = 0;
		this.#size = 0;
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

	/**
	 * Prepend all items from another Queue in front of this queue's existing items,
	 * preserving the donor queue's order. The donor queue is emptied in the process.
	 * This is more efficient than toArray() + clear() + repeated enqueue() because it
	 * avoids allocating an intermediate array and minimises enqueue call overhead.
	 * @param {Queue} other
	 */
	prependAll(other) {
		if (other.isEmpty()) return;

		// Fast path: this queue is empty — just swap internals.
		if (this.#size === 0) {
			const tmpItems = this.#items;
			const tmpMask = this.#mask;
			this.#items = other.#items;
			this.#head = other.#head;
			this.#tail = other.#tail;
			this.#size = other.#size;
			this.#mask = other.#mask;
			other.#items = tmpItems;
			other.#head = 0;
			other.#tail = 0;
			other.#size = 0;
			other.#mask = tmpMask;
			return;
		}

		// General path: merge both queues into a new array so the donor's items
		// come first, followed by this queue's existing items.
		const totalSize = this.#size + other.#size;
		let newCap = this.#items.length;
		while (newCap < totalSize) newCap *= 2;

		const newItems = new Array(newCap);
		let writeIdx = 0;

		for (let i = 0; i < other.#size; i++) {
			newItems[writeIdx++] = other.#items[(other.#head + i) & other.#mask];
		}
		for (let i = 0; i < this.#size; i++) {
			newItems[writeIdx++] = this.#items[(this.#head + i) & this.#mask];
		}

		this.#items = newItems;
		this.#head = 0;
		this.#tail = totalSize;
		this.#size = totalSize;
		this.#mask = newCap - 1;

		other.#items.fill(undefined);
		other.#head = 0;
		other.#tail = 0;
		other.#size = 0;
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
