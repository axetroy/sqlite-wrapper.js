/**
 * 生成一个唯一的 sentinel token。
 * 基于时间戳（36 进制）和随机数组合，用于标记 SQL 任务的输出边界。
 * @returns {string}
 */
export function generateToken() {
	return `__executor_end__${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
