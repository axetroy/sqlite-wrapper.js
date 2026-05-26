/**
 * 基于 Map 插入顺序的 LRU 缓存。
 *
 * 使用 `get()` 命中时自动将条目提升到末尾；
 * `set()` 在达到容量上限时淘汰最久未访问的条目（首个 key）。
 * 仅缓存字符串 key，长度超过 `maxKeyLength` 的 key 不会被缓存。
 */
export class LRUCache {
	#maxSize;
	#maxKeyLength;
	#map = new Map();

	/**
	 * @param {{ maxSize?: number, maxKeyLength?: number }} [options]
	 */
	constructor({ maxSize = 256, maxKeyLength = 4096 } = {}) {
		this.#maxSize = Math.max(1, maxSize);
		this.#maxKeyLength = maxKeyLength;
	}

	/**
	 * 获取缓存值。命中时将条目提升到末尾；未命中或 key 不合法时返回 undefined。
	 * @param {string} key
	 * @returns {string | undefined}
	 */
	get(key) {
		if (typeof key !== "string" || key.length > this.#maxKeyLength) return undefined;
		const value = this.#map.get(key);
		if (value === undefined) return undefined;
		this.#map.delete(key);
		this.#map.set(key, value);
		return value;
	}

	/**
	 * 设置缓存值。达到容量上限时淘汰最旧条目。超长 key 不缓存。
	 * @param {string} key
	 * @param {string} value
	 */
	set(key, value) {
		if (typeof key !== "string" || key.length > this.#maxKeyLength) return;
		if (this.#map.size >= this.#maxSize) {
			const firstKey = this.#map.keys().next().value;
			this.#map.delete(firstKey);
		}
		this.#map.set(key, value);
	}

	/** 当前缓存条目数。 */
	get size() {
		return this.#map.size;
	}

	/** 清空缓存。 */
	clear() {
		this.#map.clear();
	}
}
