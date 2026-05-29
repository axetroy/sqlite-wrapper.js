import { LRUCache } from "../core/lruCache.js";
import {
	CC_SINGLE_QUOTE,
	CC_DOUBLE_QUOTE,
	CC_DASH,
	CC_SLASH,
	CC_STAR,
	CC_NEWLINE,
	CC_QUESTION,
	CC_SEMICOLON,
	CC_SPACE,
	STATE_NORMAL,
	STATE_SINGLE_QUOTE,
	STATE_DOUBLE_QUOTE,
	STATE_LINE_COMMENT,
	STATE_BLOCK_COMMENT,
} from "./constants.js";

const _normDecoder = new TextDecoder("utf-16le");

const _normCache = new LRUCache({ maxSize: 256, maxKeyLength: 4096 });

function _normalize(sql) {
	const len = sql.length;
	const needed = len + 1;
	const outCodes = new Uint16Array(needed);
	let writePos = 0;
	let pendingSpace = false;
	let state = STATE_NORMAL;
	const questionPositions = [];

	for (let i = 0; i < len; i++) {
		const code = sql.charCodeAt(i);
		const nextCode = sql.charCodeAt(i + 1);

		if (state === STATE_BLOCK_COMMENT) {
			if (code === CC_STAR && nextCode === CC_SLASH) {
				state = STATE_NORMAL;
				i++;
				if (writePos > 0) pendingSpace = true;
			}
			continue;
		}

		if (state === STATE_LINE_COMMENT) {
			if (code === CC_NEWLINE) {
				state = STATE_NORMAL;
				if (writePos > 0) pendingSpace = true;
			}
			continue;
		}

		if (state === STATE_NORMAL) {
			if (code === CC_DASH && nextCode === CC_DASH) {
				state = STATE_LINE_COMMENT;
				i++;
				continue;
			}
			if (code === CC_SLASH && nextCode === CC_STAR) {
				state = STATE_BLOCK_COMMENT;
				i++;
				continue;
			}
		}

		if (code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13) {
			if (writePos > 0) pendingSpace = true;
			continue;
		}

		if (pendingSpace && writePos > 0) {
			outCodes[writePos++] = CC_SPACE;
			pendingSpace = false;
		}

		if (code === CC_QUESTION && state === STATE_NORMAL) {
			questionPositions.push(writePos);
		}
		outCodes[writePos++] = code;

		if (state === STATE_NORMAL) {
			if (code === CC_SINGLE_QUOTE) state = STATE_SINGLE_QUOTE;
			else if (code === CC_DOUBLE_QUOTE) state = STATE_DOUBLE_QUOTE;
			continue;
		}

		if (state === STATE_SINGLE_QUOTE) {
			if (code === CC_SINGLE_QUOTE && nextCode === CC_SINGLE_QUOTE) {
				outCodes[writePos++] = nextCode;
				i++;
				continue;
			}

			if (code === CC_SINGLE_QUOTE) state = STATE_NORMAL;
			continue;
		}

		if (state === STATE_DOUBLE_QUOTE) {
			if (code === CC_DOUBLE_QUOTE && nextCode === CC_DOUBLE_QUOTE) {
				outCodes[writePos++] = nextCode;
				i++;
				continue;
			}

			if (code === CC_DOUBLE_QUOTE) state = STATE_NORMAL;
		}
	}

	let normalized;
	if (writePos === 0) {
		normalized = ";";
	} else {
		while (writePos > 0 && outCodes[writePos - 1] === CC_SEMICOLON) writePos--;
		outCodes[writePos++] = CC_SEMICOLON;
		normalized = _normDecoder.decode(outCodes.subarray(0, writePos));
	}

	const paramCount = questionPositions.length;
	if (paramCount === 0) {
		return { normalized, segments: [normalized], paramCount: 0 };
	}

	const segments = [];
	let segStart = 0;
	for (const pos of questionPositions) {
		segments.push(normalized.slice(segStart, pos));
		segStart = pos + 1;
	}
	segments.push(normalized.slice(segStart));
	return { normalized, segments, paramCount };
}

export function normalizeSQL(sql) {
	const cached = _normCache.get(sql);
	if (cached !== undefined) return cached.normalized;
	const result = _normalize(sql);
	_normCache.set(sql, result);
	return result.normalized;
}

export function normalizeSQLTemplate(sql) {
	const cached = _normCache.get(sql);
	if (cached !== undefined) return cached;
	const result = _normalize(sql);
	_normCache.set(sql, result);
	return result;
}
