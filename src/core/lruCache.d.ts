/** 基于 Map 插入顺序的 LRU 缓存。 */
export declare class LRUCache<T> {
	constructor(options?: { maxSize?: number; maxKeyLength?: number });

	/** 获取缓存值，命中时提升到末尾。未命中或 key 不合法时返回 undefined。 */
	get(key: string): T | undefined;

	/** 设置缓存值。达到容量上限时淘汰最旧条目。超长 key 不缓存。 */
	set(key: string, value: T): void;

	/** 当前缓存条目数。 */
	get size(): number;

	/** 清空缓存。 */
	clear(): void;
}
