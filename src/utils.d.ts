/**
 * Escape a single SQL value.
 * @param value
 */
export declare function escapeValue(value: any): string;

/**
 * Escape SQL values in the given SQL string with the provided parameters.
 * @param sql
 * @param params
 */
export declare function interpolateSQL(sql: string, params: any[]): string;
