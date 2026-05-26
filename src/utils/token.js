let _counter = 0;
const _PREFIX = "__executor_end__";
const _PID36 = process.pid.toString(36);

/**
 * 生成一个唯一的 sentinel token。
 * 使用递增计数器和进程 PID 组合，避免每次分配随机数字符串。
 * @returns {string}
 */
export function generateToken() {
	return `${_PREFIX}${(_counter++).toString(36)}_${_PID36}`;
}
