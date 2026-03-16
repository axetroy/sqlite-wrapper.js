class QueueNode {
	constructor(value) {
		this.value = value;
		this.next = null;
	}
}

export class Queue {
	#head = null;
	#tail = null;
	#size = 0;

	enqueue(value) {
		const node = new QueueNode(value);

		if (this.#tail) {
			this.#tail.next = node;
		} else {
			this.#head = node;
		}

		this.#tail = node;
		this.#size++;
	}

	dequeue() {
		if (!this.#head) return null;

		const node = this.#head;
		this.#head = node.next;

		if (!this.#head) {
			this.#tail = null;
		}

		this.#size--;
		return node.value;
	}

	clear() {
		this.#head = null;
		this.#tail = null;
		this.#size = 0;
	}

	get size() {
		return this.#size;
	}

	isEmpty() {
		return this.#size === 0;
	}
}
