import { createRowStreamParser, RowStreamParser } from "../core/parser.js";

export { createRowStreamParser };

export function setupStreamParser(task: { kind: string; onRow?: Function; consumerError?: Error | null }): RowStreamParser | null;
