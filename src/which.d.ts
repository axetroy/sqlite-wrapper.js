/**
 * 在系统 PATH 环境变量中查找可执行文件。
 * 类似 Unix `which` 命令。
 *
 * @param command - 要查找的命令名称
 * @returns 可执行文件的完整路径，未找到时返回 null
 */
export function which(command: string): string | null;
