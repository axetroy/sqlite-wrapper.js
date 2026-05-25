/**
 * 将任意值统一转为 Error 对象。
 * 如果已是 Error 实例则原样返回，否则将其字符串化后包装为新 Error。
 * @param {unknown} value
 * @returns {Error}
 */
export function toError(value) {
	return value instanceof Error ? value : new Error(String(value));
}

const CHAR_QUOTE = 34;
const CHAR_BACKSLASH = 92;
const CHAR_OPEN_BRACKET = 91;
const CHAR_CLOSE_BRACKET = 93;
const CHAR_OPEN_BRACE = 123;
const CHAR_CLOSE_BRACE = 125;
const CHAR_COMMA = 44;
const CHAR_SPACE = 32;
const CHAR_TAB = 9;
const CHAR_LF = 10;
const CHAR_CR = 13;

/**
 * 判断字符码是否为空白字符（空格、制表符、换行、回车）。
 * @param {number} code
 * @returns {boolean}
 */
function isWhitespaceCode(code) {
	return code === CHAR_SPACE || code === CHAR_TAB || code === CHAR_LF || code === CHAR_CR;
}

/**
 * 创建一个 JSON 值解析器，逐字符扫描流式数据，检测完整的顶层 JSON 值
 *（对象或数组），解析出完整的 JSON 文本后通过回调通知。
 *
 * 支持流式分块输入，通过 readPos 记录上次扫描位置，避免多次分块间重复扫描已处理数据。
 * 在字符串内正确处理转义。
 *
 * @param {(raw: string) => void} onValue - 每当解析出一个完整 JSON 值时被调用
 * @returns {{
 *   feed(chunk: string): void,
 *   reset(): void,
 *   buffer: string,
 *   start: number,
 *   readPos: number,
 *   nesting: number,
 *   inString: boolean,
 *   escaped: boolean,
 * }}
 */
export function createJsonValueParser(onValue) {
	return {
		buffer: "",
		start: -1,
		readPos: 0,
		nesting: 0,
		inString: false,
		escaped: false,
		feed(chunk) {
			this.buffer += chunk;
			let consumeUntil = 0;

			for (let index = this.readPos; index < this.buffer.length; index++) {
				const code = this.buffer.charCodeAt(index);

				if (this.start === -1) {
					if (isWhitespaceCode(code)) continue;
					if (code !== CHAR_OPEN_BRACKET && code !== CHAR_OPEN_BRACE) continue;
					this.start = index;
					this.nesting = 1;
					this.inString = false;
					this.escaped = false;
					continue;
				}

				if (this.inString) {
					if (this.escaped) {
						this.escaped = false;
					} else if (code === CHAR_BACKSLASH) {
						this.escaped = true;
					} else if (code === CHAR_QUOTE) {
						this.inString = false;
					}
					continue;
				}

				if (code === CHAR_QUOTE) {
					this.inString = true;
					continue;
				}

				if (code === CHAR_OPEN_BRACKET || code === CHAR_OPEN_BRACE) {
					this.nesting++;
					continue;
				}

				if (code === CHAR_CLOSE_BRACKET || code === CHAR_CLOSE_BRACE) {
					this.nesting--;
					if (this.nesting === 0) {
						const raw = this.buffer.slice(this.start, index + 1);
						this.start = -1;
						onValue(raw);
						consumeUntil = index + 1;
					}
				}
			}

			if (consumeUntil > 0) {
				this.buffer = this.buffer.slice(consumeUntil);
				this.readPos = 0;
			} else {
				this.readPos = this.buffer.length;
			}
		},
		reset() {
			this.buffer = "";
			this.start = -1;
			this.readPos = 0;
			this.nesting = 0;
			this.inString = false;
			this.escaped = false;
		},
	};
}

/**
 * 创建一个行流解析器，用于解析 sqlite3 `-json` 模式下输出的 JSON 数组。
 * 它不是一次性解析整个数组，而是在元素到达时逐行回调 `onRow`，
 * 支持分块输入、嵌套对象/数组、转义字符串。
 *
 * 数组元素必须是对象 `{...}` 或嵌套数组 `[...]` 才支持正确的嵌套计数。
 * feed() 返回剩余未处理的数据（即数组结束 `]` 之后的内容）。
 *
 * @param {(rawRow: string) => void} onRow - 每当解析出一个数组元素时被调用，传入元素的原始 JSON 文本
 * @returns {{
 *   feed(chunk: string): string,
 *   reset(): void,
 *   buffer: string,
 *   started: boolean,
 *   finished: boolean,
 *   inString: boolean,
 *   escaped: boolean,
 *   elementStart: number,
 *   elementEnd: number,
 *   nesting: number,
 *   readPos: number,
 * }}
 */
export function createRowStreamParser(onRow) {
	return {
		buffer: "",
		started: false,
		finished: false,
		inString: false,
		escaped: false,
		elementStart: -1,
		elementEnd: -1,
		nesting: 0,
		readPos: 0,
		feed(chunk) {
			if (this.finished) return chunk;

			this.buffer += chunk;
			let index = this.readPos;

			while (index < this.buffer.length) {
				const code = this.buffer.charCodeAt(index);

				if (!this.started) {
					if (isWhitespaceCode(code)) {
						index++;
						continue;
					}
					if (code !== CHAR_OPEN_BRACKET) {
						index++;
						continue;
					}
					this.started = true;
					index++;
					continue;
				}

				if (this.inString) {
					if (this.escaped) {
						this.escaped = false;
					} else if (code === CHAR_BACKSLASH) {
						this.escaped = true;
					} else if (code === CHAR_QUOTE) {
						this.inString = false;
					}
					index++;
					continue;
				}

				if (this.elementStart === -1) {
					if (isWhitespaceCode(code) || code === CHAR_COMMA) {
						index++;
						continue;
					}
					if (code === CHAR_CLOSE_BRACKET) {
						this.finished = true;
						const leftover = this.buffer.slice(index + 1);
						this.buffer = "";
						this.readPos = 0;
						return leftover;
					}
					this.elementStart = index;
					this.elementEnd = -1;
					this.nesting = code === CHAR_OPEN_BRACE || code === CHAR_OPEN_BRACKET ? 1 : 0;
					this.inString = code === CHAR_QUOTE;
					index++;
					continue;
				}

				if (code === CHAR_QUOTE) {
					this.inString = true;
					index++;
					continue;
				}

				if (code === CHAR_OPEN_BRACE || code === CHAR_OPEN_BRACKET) {
					this.nesting++;
					index++;
					continue;
				}

				if (code === CHAR_CLOSE_BRACE || code === CHAR_CLOSE_BRACKET) {
					this.nesting--;
					if (this.nesting === 0) {
						this.elementEnd = index + 1;
					}
				}

				if (this.elementEnd !== -1) {
					let lookAhead = index + 1;
					while (lookAhead < this.buffer.length && isWhitespaceCode(this.buffer.charCodeAt(lookAhead))) {
						lookAhead++;
					}
					if (lookAhead < this.buffer.length) {
						const delimiter = this.buffer.charCodeAt(lookAhead);
						if (delimiter === CHAR_COMMA || delimiter === CHAR_CLOSE_BRACKET) {
							onRow(this.buffer.slice(this.elementStart, this.elementEnd));
							this.buffer = this.buffer.slice(lookAhead + 1);
							this.elementStart = -1;
							this.elementEnd = -1;
							this.nesting = 0;
							if (delimiter === CHAR_CLOSE_BRACKET) {
								this.finished = true;
								const tail = this.buffer;
								this.buffer = "";
								this.readPos = 0;
								return tail;
							}
							index = 0;
							continue;
						}
					}
				}

				index++;
			}

			if (this.elementStart > 0) {
				this.buffer = this.buffer.slice(this.elementStart);
				if (this.elementEnd !== -1) this.elementEnd -= this.elementStart;
				this.elementStart = 0;
			}

			this.readPos = this.elementStart === 0 ? this.buffer.length : 0;

			return "";
		},
		reset() {
			this.buffer = "";
			this.started = false;
			this.finished = false;
			this.inString = false;
			this.escaped = false;
			this.elementStart = -1;
			this.elementEnd = -1;
			this.nesting = 0;
			this.readPos = 0;
		},
	};
}
