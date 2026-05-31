/**
 * 基于 Map 插入顺序的 LRU 缓存。
 *
 * 使用 `get()` 命中时自动将条目提升到末尾；
 * `set()` 在达到容量上限时淘汰最久未访问的条目（首个 key）。
 * 仅缓存字符串 key，长度超过 `maxKeyLength` 的 key 不会被缓存。
 *
 * @template T
 */
export class LRUCache {
	#maxSize;
	#maxKeyLength;
	#maxValueLength;
	/** @type {Map<string, T>} */
	#map = new Map();

	/**
	 * @param {{ maxSize?: number, maxKeyLength?: number, maxValueLength?: number }} [options]
	 *   maxSize - 最大缓存条目数（默认 256，自动提升到至少 1）
	 *   maxKeyLength - key 最大长度，超长 key 不缓存（默认 4096）
	 *   maxValueLength - value 字符串/数组的最大长度，超长不缓存（默认 Infinity）
	 */
	constructor({ maxSize = 256, maxKeyLength = 4096, maxValueLength = Infinity } = {}) {
		this.#maxSize = Math.max(1, maxSize);
		this.#maxKeyLength = maxKeyLength;
		this.#maxValueLength = maxValueLength;
	}

	/**
	 * 获取缓存值。命中时将条目提升到末尾；未命中或 key 不合法时返回 undefined。
	 * @param {string} key - 缓存键
	 * @returns {T | undefined}
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
	 * 对字符串/数组类型检查 maxValueLength；其他类型不做长度过滤（如对象）。
	 * @param {string} key - 缓存键
	 * @param {T} value - 缓存值
	 */
	set(key, value) {
		if (typeof key !== "string" || key.length > this.#maxKeyLength) return;
		if (typeof value === "string" && value.length > this.#maxValueLength) return;
		if (Array.isArray(value) && value.length > this.#maxValueLength) return;
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
