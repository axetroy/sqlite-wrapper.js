import { ChildProcess } from "node:child_process";

export declare class ProcessManager {
	constructor(options?: { binary?: string; database?: string });
	get binary(): string;
	get process(): ChildProcess | null;
	start(): ChildProcess;
	write(data: string): void;
	kill(): ChildProcess | null;
}
