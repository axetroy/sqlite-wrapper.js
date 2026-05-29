/** 基于 Map 插入顺序的 LRU 缓存。 */
export declare class LRUCache<T> {
	/**
	 * 创建 LRUCache 实例。
	 * @param options 可选项。
	 * @param options.maxSize 最大缓存条目数，默认为 100。
	 * @param options.maxKeyLength 超长 key 的最大长度，默认为 100。超过该长度的 key 不会被缓存。
	 * @param options.maxValueLength 超长 value 的最大长度，默认为 Infinity。超过该长度的 value 不会被缓存。
	 */
	constructor(options?: { maxSize?: number; maxKeyLength?: number, maxValueLength?: number });

	/** 获取缓存值，命中时提升到末尾。未命中或 key 不合法时返回 undefined。 */
	get(key: string): T | undefined;

	/** 设置缓存值。达到容量上限时淘汰最旧条目。超长 key 不缓存。 */
	set(key: string, value: T): void;

	/** 当前缓存条目数。 */
	get size(): number;

	/** 清空缓存。 */
	clear(): void;
}
