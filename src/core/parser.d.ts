export interface JsonValueParser {
	feed(chunk: string): void;
	reset(): void;
	buffer: string;
	start: number;
	readPos: number;
	nesting: number;
	inString: boolean;
	escaped: boolean;
}

export interface RowStreamParser {
	feed(chunk: string): string;
	reset(): void;
	buffer: string;
	started: boolean;
	finished: boolean;
	inString: boolean;
	escaped: boolean;
	elementStart: number;
	elementEnd: number;
	nesting: number;
	readPos: number;
}

export function toError(value: unknown): Error;
export function createJsonValueParser(onValue: (raw: string) => void): JsonValueParser;
export function createRowStreamParser(onRow: (rawRow: string) => void): RowStreamParser;
