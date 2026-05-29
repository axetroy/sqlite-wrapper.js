/**
 * 将任意值统一转为 Error 对象。
 * 如果已是 Error 实例则原样返回，否则将其字符串化后包装为新 Error。
 * @param {unknown} value
 * @returns {Error}
 */
export function toError(value) {
	return value instanceof Error ? value : new Error(String(value));
}

const CHAR_QUOTE = 34; // "
const CHAR_BACKSLASH = 92; // \
const CHAR_OPEN_BRACKET = 91; // [
const CHAR_CLOSE_BRACKET = 93; // ]
const CHAR_OPEN_BRACE = 123; // {
const CHAR_CLOSE_BRACE = 125; // }
const CHAR_COMMA = 44; // ,
const CHAR_SPACE = 32; //
const CHAR_TAB = 9; // \t
const CHAR_LF = 10; // \n
const CHAR_CR = 13; // \r

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
 * 核心逻辑是一个状态机，维护以下状态：
 *   start    — 当前正在累积的顶层 JSON 值在 buffer 中的起始位置，-1 表示未开始
 *   nesting  — 当前嵌套深度（遇到 [ 或 { 递增，遇到 ] 或 } 递减）
 *   inString — 是否在字符串内部（字符串内的括号不计入嵌套深度）
 *   escaped  — 前一个字符是否为反斜杠（用于处理字符串内的转义 \" \\ 等）
 *
 * 支持流式分块输入，通过 readPos 记录上次扫描位置，避免多次分块间重复扫描已处理数据。
 *
 * 关键优化：空数组 [] 走 fast path，直接跳过 slice 和 onValue 回调。
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
		// 累积的未解析原始数据
		buffer: "",
		// 当前顶层 JSON 值在 buffer 中的起始索引，-1 表示未开始扫描顶层值
		start: -1,
		// 上次扫描到的位置，下次 feed 从这继续，避免重复扫描
		readPos: 0,
		// 嵌套深度：遇到 [ 或 { 递增，遇到 ] 或 } 递减；归零表示一个完整值结束
		nesting: 0,
		// 是否在一对双引号内部（字符串内的括号不参与 nesting 计数）
		inString: false,
		// 前一个字符是否为反斜杠（处理字符串中的转义序列 \" \\ \/ \b \f \n \r \t \uXXXX）
		escaped: false,
		// 已累积消费的字节数，用于延迟 buffer 物理裁剪，减少 String 分配和 GC 压力
		_consumed: 0,
		feed(chunk) {
			// 1. 将新数据追加到 buffer 尾部
			this.buffer += chunk;
			let consumeUntil = 0;

			// 2. 从上次处理到的位置继续扫描
			for (let index = this.readPos; index < this.buffer.length; index++) {
				const code = this.buffer.charCodeAt(index);

				// === 状态 A：未开始解析顶层值，跳过空白，寻找 [ 或 { ===
				if (this.start === -1) {
					if (isWhitespaceCode(code)) continue;
					if (code !== CHAR_OPEN_BRACKET && code !== CHAR_OPEN_BRACE) continue;
					// 找到顶层值的起始位置，初始化嵌套计数
					this.start = index;
					this.nesting = 1;
					this.inString = false;
					this.escaped = false;
					continue;
				}

				// === 状态 B：在字符串内部，处理转义序列 ===
				if (this.inString) {
					if (this.escaped) {
						// 前一个字符是反斜杠，当前字符被转义，重置 escaped
						this.escaped = false;
					} else if (code === CHAR_BACKSLASH) {
						// 遇到反斜杠，标记下一个字符为转义状态
						this.escaped = true;
					} else if (code === CHAR_QUOTE) {
						// 遇到未转义的双引号，字符串结束
						this.inString = false;
					}
					continue;
				}

				// === 状态 C：不在字符串内，遇到双引号则进入字符串 ===
				if (code === CHAR_QUOTE) {
					this.inString = true;
					continue;
				}

				// === 状态 D：不在字符串内，处理嵌套结构 ===
				if (code === CHAR_OPEN_BRACKET || code === CHAR_OPEN_BRACE) {
					// 进入一层嵌套
					this.nesting++;
					continue;
				}

				if (code === CHAR_CLOSE_BRACKET || code === CHAR_CLOSE_BRACE) {
					// 退出一层嵌套
					this.nesting--;
					if (this.nesting === 0) {
						// 嵌套归零 → 一个完整的顶层 JSON 值解析完成
						// Fast path: 空数组 []，index === start + 1，无需 slice 和回调
						if (index === this.start + 1) {
							this.start = -1;
							consumeUntil = index + 1;
							continue;
						}
						// 正常路径：切片出完整 JSON 文本，通过回调通知
						const raw = this.buffer.slice(this.start, index + 1);
						this.start = -1;
						onValue(raw);
						consumeUntil = index + 1;
					}
				}
			}

			// 3. 清理已消费部分：用 _consumed 记录已消费位置而非每次都物理裁剪 buffer。
			//    避免每个完整值都产生一次 String 分配（buffer.slice），
			//    仅在累积超过 64KB 时一次性物理裁剪，减少 GC 压力。
			//    注意：consumeUntil 是相对 buffer 起始的绝对位置，直接赋值即可。
			if (consumeUntil > 0) {
				this._consumed = consumeUntil;
				// 当有未完成的部分值（start !== -1）时，readPos 跳到 buffer 末尾
				// 避免下次 feed 重扫已计入 nesting 的 [/{ 字符，
				// 同时保留 nested/inString/escaped 状态供继续解析。
				this.readPos = this.start !== -1 ? this.buffer.length : this._consumed;
				if (this._consumed > 65536) {
					if (this.start !== -1) this.start -= this._consumed;
					this.buffer = this.buffer.slice(this._consumed);
					this.readPos = this.buffer.length;
					this._consumed = 0;
				}
			} else {
				// 没有完整值被消费，记录当前位置，下次 feed 从此继续
				this.readPos = this.buffer.length;
			}
		},
		reset() {
			this.buffer = "";
			this._consumed = 0;
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
 * 核心状态机比 createJsonValueParser 更复杂，因为需要在数组上下文中
 * 逐个识别元素边界（逗号分隔，] 结束），而不是只匹配顶层括号匹配。
 *
 * 解析流程概览：
 *   1. 跳过空白，等待 [ → 标记 started
 *   2. 跳过空白和逗号，等待元素起始 → 记录 elementStart
 *   3. 扫描元素内容，跟踪 nesting 深度直到归零 → 记录 elementEnd
 *   4. 向前 look-ahead 确认后面是逗号或 ]（即元素完全结束）→ 回调 onRow 并截断已处理部分
 *   5. 遇到 ] → 标记 finished，返回剩余数据
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
		// 是否已遇到数组开始的 [
		started: false,
		// 是否已遇到数组结束的 ]，之后 feed 直接返回输入
		finished: false,
		// 是否在字符串内部
		inString: false,
		// 前一个字符是否为反斜杠
		escaped: false,
		// 当前元素在 buffer 中的起始位置
		elementStart: -1,
		// 当前元素在 buffer 中的结束位置（exclusive）
		elementEnd: -1,
		// 当前元素的嵌套深度（用于处理元素内部的嵌套结构）
		nesting: 0,
		// 上次扫描位置
		readPos: 0,
		// 已累积消费的字节数，用于延迟 buffer 物理裁剪
		_consumed: 0,
		feed(chunk) {
			// 如果数组已结束，直接返回新数据
			if (this.finished) return chunk;

			// 1. 追加新数据到 buffer
			this.buffer += chunk;
			let index = this.readPos;

			while (index < this.buffer.length) {
				const code = this.buffer.charCodeAt(index);

				// === 阶段 1：等待数组开始 [ ===
				if (!this.started) {
					if (isWhitespaceCode(code)) {
						index++;
						continue;
					}
					if (code !== CHAR_OPEN_BRACKET) {
						// 非 [ 的字符（非空白）直接跳过
						index++;
						continue;
					}
					this.started = true;
					index++;
					continue;
				}

				// === 阶段 2：在字符串内部，处理转义 ===
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

				// === 阶段 3：不在任何元素内，等待元素起始 ===
				if (this.elementStart === -1) {
					if (isWhitespaceCode(code) || code === CHAR_COMMA) {
						// 跳过空白和元素间逗号
						index++;
						continue;
					}
					if (code === CHAR_CLOSE_BRACKET) {
						// 数组结束，标记 finished 并返回剩余数据
						this.finished = true;
						const leftover = this.buffer.slice(index + 1);
						this.buffer = "";
						this.readPos = 0;
						return leftover;
					}
					// 记录元素起始位置，初始化嵌套计数
					this.elementStart = index;
					this.elementEnd = -1;
					this.nesting = code === CHAR_OPEN_BRACE || code === CHAR_OPEN_BRACKET ? 1 : 0;
					this.inString = code === CHAR_QUOTE;
					index++;
					continue;
				}

				// === 阶段 4：在元素内，处理字符串、嵌套结构 ===
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
						// 嵌套归零，标记元素结束位置
						this.elementEnd = index + 1;
					}
				}

				// === 阶段 5：确认元素后面是逗号或 ]，保证元素完整结束 ===
				if (this.elementEnd !== -1) {
					// 向前 look-ahead，跳过元素后的空白
					let lookAhead = index + 1;
					while (lookAhead < this.buffer.length && isWhitespaceCode(this.buffer.charCodeAt(lookAhead))) {
						lookAhead++;
					}
					if (lookAhead < this.buffer.length) {
						const delimiter = this.buffer.charCodeAt(lookAhead);
						if (delimiter === CHAR_COMMA || delimiter === CHAR_CLOSE_BRACKET) {
							// 元素完整：切片出元素文本并回调
							onRow(this.buffer.slice(this.elementStart, this.elementEnd));
							// 不直接物理裁剪 buffer，改用 _consumed 记录已消费位置
							this._consumed = lookAhead + 1;
							this.elementStart = -1;
							this.elementEnd = -1;
							this.nesting = 0;
							if (delimiter === CHAR_CLOSE_BRACKET) {
								// 数组结束，从 _consumed 处切片剩余数据返回
								this.finished = true;
								const tail = this.buffer.slice(this._consumed);
								this.buffer = "";
								this._consumed = 0;
								this.readPos = 0;
								return tail;
							}
							index = this._consumed;
							// 累积消费超过 64KB 时一次物理裁剪，避免 buffer 膨胀和过多 String 分配
							if (this._consumed > 65536) {
								this.buffer = this.buffer.slice(this._consumed);
								index = 0;
								this._consumed = 0;
							}
							continue;
						}
					}
					// look-ahead 没有看到逗号或 ]，说明元素可能被分块截断了，暂不处理
				}

				index++;
			}

			// 6. buffer 裁剪：用 _consumed 取代逐个元素的 buffer.slice，
			//    每消费一个元素就 slice 一次在高吞吐下会大量分配临时 String。
			//    改为累积消费偏移，仅在本轮末尾做一次物理裁剪。
			if (this._consumed > 0) {
				if (this.elementStart !== -1) {
					this.elementStart -= this._consumed;
					if (this.elementEnd !== -1) this.elementEnd -= this._consumed;
				}
				this.buffer = this.buffer.slice(this._consumed);
				this._consumed = 0;
			}
			// 保留原始逻辑：若 elementStart > 0 则将未完成元素对齐到 buffer 头部
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
			this._consumed = 0;
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
