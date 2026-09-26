/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CSV / TSV ビューアの読み取り部分（DOM にも workbench にも依存しない純粋なロジック）。
//
// 数十 MB・100 万行の CSV でもメモリを食い潰さないよう、全セルを文字列の配列に展開しない。
// 読み込み時は「各レコードが本文のどこから始まるか」だけを Uint32Array に記録し（1 行あたり 4 バイト）、
// セルの文字列は表示・検索・並べ替えで必要になったレコードだけをその場で切り出す。
// 構文は RFC 4180 に従う: 引用符で囲んだフィールドは区切り文字と改行を含められ、`""` は `"` 1 文字を表す。
// 区切り文字は `,` / タブ / `;` から自動判定する（.tsv は常にタブ）。

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';

export type ParadisCsvDelimiter = ',' | '\t' | ';';

/** 表示するレコード数（見出し行を含む）の上限。仮想スクロールの軸の上限（1,048,576）より小さく取る。 */
export const PARADIS_CSV_MAX_RECORDS = 1_000_001;
/** 表示する列数の上限（Excel と同じ）。 */
export const PARADIS_CSV_MAX_COLUMNS = 16_384;
/** 表として読み込むファイルの先頭バイト数の上限。これを超える部分は読まない。 */
export const PARADIS_CSV_MAX_BYTES = 64 * 1024 * 1024;
/** 検索で集める一致の上限（Office の検索ウィジェットの上限と同じ）。 */
export const PARADIS_CSV_SEARCH_LIMIT = 10_000;

const QUOTE = 0x22; // "
const LF = 0x0a;
const CR = 0x0d;
const DELIMITER_SNIFF_CODE_UNITS = 64 * 1024;
const DELIMITER_SNIFF_LINES = 20;
const RECORD_CACHE_SIZE = 4_096;
const DEFAULT_CHUNK_RECORDS = 20_000;

/** 先頭の BOM（U+FEFF）を飛ばした本文の開始位置。 */
export function paradisCsvContentStart(text: string): number {
	return text.charCodeAt(0) === 0xfeff ? 1 : 0;
}

/**
 * 区切り文字を推定する。先頭の最大 20 行（空行は除く）で候補ごとの出現数を数え、
 * 「どの行でも同じ数だけ出る」候補を最優先、次に 1 行目での出現数が多い候補を選ぶ。
 * 1 行目に 1 つも出ない候補は選ばない。どれも出なければ 1 列の CSV とみなして `,` を返す。
 */
export function detectParadisCsvDelimiter(text: string, start = paradisCsvContentStart(text)): ParadisCsvDelimiter {
	const candidates: readonly ParadisCsvDelimiter[] = [',', '\t', ';'];
	const counts = candidates.map(() => [] as number[]);
	const limit = Math.min(text.length, start + DELIMITER_SNIFF_CODE_UNITS);
	let inQuotes = false;
	let lineCounts = candidates.map(() => 0);
	let lineHasContent = false;
	let lines = 0;
	const flushLine = () => {
		if (lineHasContent) {
			lineCounts.forEach((count, index) => counts[index].push(count));
			lines++;
		}
		lineCounts = candidates.map(() => 0);
		lineHasContent = false;
	};
	for (let index = start; index < limit && lines < DELIMITER_SNIFF_LINES; index++) {
		const code = text.charCodeAt(index);
		if (code === QUOTE) {
			inQuotes = !inQuotes;
			lineHasContent = true;
			continue;
		}
		if (inQuotes) {
			continue;
		}
		if (code === LF || code === CR) {
			flushLine();
			continue;
		}
		lineHasContent = true;
		const candidate = candidates.indexOf(text[index] as ParadisCsvDelimiter);
		if (candidate !== -1) {
			lineCounts[candidate]++;
		}
	}
	if (lines < DELIMITER_SNIFF_LINES) {
		flushLine();
	}
	let best: ParadisCsvDelimiter = ',';
	let bestScore = -1;
	candidates.forEach((candidate, index) => {
		const perLine = counts[index];
		const first = perLine[0] ?? 0;
		if (first === 0) {
			return;
		}
		const consistent = perLine.every(count => count === first);
		const score = (consistent ? 1_000_000 : 0) + first;
		if (score > bestScore) {
			bestScore = score;
			best = candidate;
		}
	});
	return best;
}

export interface ParadisCsvIndexOptions {
	/** 記録するレコード数の上限（見出し行を含む）。 */
	readonly maxRecords?: number;
	/** 列数の上限。 */
	readonly maxColumns?: number;
	/**
	 * 本文がファイルの途中で切れている（先頭の一部だけ読んだ）場合は true。最後のレコードは
	 * 途中で切れている可能性があるので捨てる（ただしレコードが 1 つしか無いときは残す）。
	 */
	readonly contentTruncated?: boolean;
}

/**
 * レコードの開始位置を少しずつ数える索引作成器。巨大なファイルでも UI を止めないよう、
 * {@link step} を「今回はここまで」という文字数の予算付きで繰り返し呼ぶ。
 */
export class ParadisCsvIndexer {
	private position: number;
	private starts: Uint32Array;
	private count = 0;
	private columns = 0;
	private fieldsInRecord = 1;
	private atFieldStart = true;
	private inQuotes = false;
	private finished = false;
	private truncatedRecords = false;
	private readonly delimiterCode: number;
	private readonly maxRecords: number;
	private readonly maxColumns: number;

	constructor(
		private readonly text: string,
		private readonly delimiter: ParadisCsvDelimiter,
		private readonly options: ParadisCsvIndexOptions = {},
	) {
		this.position = paradisCsvContentStart(text);
		this.delimiterCode = delimiter.charCodeAt(0);
		this.maxRecords = Math.max(1, options.maxRecords ?? PARADIS_CSV_MAX_RECORDS);
		this.maxColumns = Math.max(1, options.maxColumns ?? PARADIS_CSV_MAX_COLUMNS);
		this.starts = new Uint32Array(Math.min(1024, this.maxRecords + 1));
		if (this.position < text.length) {
			this.pushStart(this.position);
		} else {
			this.finished = true;
		}
	}

	get isDone(): boolean {
		return this.finished;
	}

	/** 本文全体に対する進み具合（0〜1）。 */
	get progress(): number {
		return this.text.length === 0 ? 1 : Math.min(1, this.position / this.text.length);
	}

	/** 最大 `budget` 文字だけ読み進める。読み終えたら true。 */
	step(budget: number): boolean {
		if (this.finished) {
			return true;
		}
		const text = this.text;
		const length = text.length;
		const stop = Math.min(length, this.position + Math.max(1, budget));
		let position = this.position;
		while (position < stop) {
			const code = text.charCodeAt(position);
			if (this.inQuotes) {
				if (code === QUOTE) {
					if (text.charCodeAt(position + 1) === QUOTE) {
						position += 2;
						continue;
					}
					this.inQuotes = false;
				}
				position++;
				continue;
			}
			if (code === QUOTE && this.atFieldStart) {
				this.inQuotes = true;
				this.atFieldStart = false;
				position++;
				continue;
			}
			if (code === this.delimiterCode) {
				this.fieldsInRecord++;
				this.atFieldStart = true;
				position++;
				continue;
			}
			if (code === LF || code === CR) {
				position += code === CR && text.charCodeAt(position + 1) === LF ? 2 : 1;
				this.endRecord();
				if (position < length) {
					if (this.count >= this.maxRecords) {
						this.truncatedRecords = true;
						this.finished = true;
						this.position = position;
						return true;
					}
					this.pushStart(position);
				}
				continue;
			}
			this.atFieldStart = false;
			position++;
		}
		this.position = position;
		if (position >= length) {
			if (this.count > 0 && !this.recordEnded()) {
				this.endRecord();
			}
			this.finished = true;
		}
		return this.finished;
	}

	/** 索引を作り終えた文書を返す。{@link step} が true を返した後に呼ぶ。 */
	finish(): ParadisCsvDocument {
		if (!this.finished) {
			throw new Error('CSV indexing has not finished.');
		}
		let count = this.count;
		// 上限で打ち切ったときの position は「記録しなかった次のレコードの先頭」＝最後のレコードの終わり。
		let end = this.truncatedRecords ? this.position : this.text.length;
		if (this.options.contentTruncated && !this.truncatedRecords && count > 1) {
			// 読み込みの途中で切れた最後のレコードは不完全かもしれないので捨てる。
			count--;
			end = this.starts[count];
		}
		return new ParadisCsvDocument(this.text, this.delimiter, this.starts.subarray(0, count), end, Math.min(this.columns, this.maxColumns), {
			truncatedRecords: this.truncatedRecords || !!this.options.contentTruncated,
			truncatedColumns: this.columns > this.maxColumns,
		});
	}

	private lastEndedCount = 0;

	private recordEnded(): boolean {
		return this.lastEndedCount === this.count;
	}

	private endRecord(): void {
		if (this.fieldsInRecord > this.columns) {
			this.columns = this.fieldsInRecord;
		}
		this.fieldsInRecord = 1;
		this.atFieldStart = true;
		this.lastEndedCount = this.count;
	}

	private pushStart(position: number): void {
		if (this.count >= this.starts.length) {
			const grown = new Uint32Array(Math.min(this.maxRecords + 1, Math.max(this.starts.length * 2, 1024)));
			grown.set(this.starts);
			this.starts = grown;
		}
		this.starts[this.count++] = position;
	}
}

export interface ParadisCsvDocumentFlags {
	/** ファイルの行が多すぎる・大きすぎるため、先頭の一部だけを表示している。 */
	readonly truncatedRecords: boolean;
	/** 列が多すぎるため、先頭の列だけを表示している。 */
	readonly truncatedColumns: boolean;
}

/**
 * 索引付きの CSV 本文。レコード 0 が見出し行、1 以降がデータ行。
 * セルの文字列は必要になったレコードだけ解析し、直近のものを少数キャッシュする。
 */
export class ParadisCsvDocument {
	private readonly cache = new Map<number, readonly string[]>();

	constructor(
		readonly text: string,
		readonly delimiter: ParadisCsvDelimiter,
		private readonly starts: Uint32Array,
		private readonly end: number,
		readonly columnCount: number,
		readonly flags: ParadisCsvDocumentFlags,
	) { }

	/** レコード数（見出し行を含む）。 */
	get recordCount(): number {
		return this.starts.length;
	}

	/** データ行の数（見出し行を除く）。 */
	get dataRowCount(): number {
		return Math.max(0, this.starts.length - 1);
	}

	/** レコード `index` の本文上の範囲 [start, end)。行末の改行を含み得る。 */
	recordRange(index: number): readonly [number, number] {
		const start = this.starts[index];
		const end = index + 1 < this.starts.length ? this.starts[index + 1] : this.end;
		return [start, end];
	}

	/** レコード `index` の全フィールド（列数の上限まで）。 */
	getRecord(index: number): readonly string[] {
		if (index < 0 || index >= this.starts.length) {
			return [];
		}
		const cached = this.cache.get(index);
		if (cached) {
			return cached;
		}
		const [start, end] = this.recordRange(index);
		const record = parseParadisCsvRecord(this.text, start, end, this.delimiter, this.columnCount);
		if (this.cache.size >= RECORD_CACHE_SIZE) {
			this.cache.clear();
		}
		this.cache.set(index, record);
		return record;
	}

	getField(record: number, column: number): string {
		return this.getRecord(record)[column] ?? '';
	}
}

/**
 * `start` から始まる 1 レコードを解析する（引用符の外の改行か `end` で終わる）。
 * 閉じ引用符の後ろに区切り文字以外が続く不正な形は、Excel と同様にそのまま連結して読む。
 */
export function parseParadisCsvRecord(text: string, start: number, end: number, delimiter: ParadisCsvDelimiter, maxFields = PARADIS_CSV_MAX_COLUMNS): string[] {
	const fields: string[] = [];
	const delimiterCode = delimiter.charCodeAt(0);
	let position = start;
	const limit = Math.min(end, text.length);
	while (true) {
		let value = '';
		if (position < limit && text.charCodeAt(position) === QUOTE) {
			position++;
			let segmentStart = position;
			while (position < limit) {
				if (text.charCodeAt(position) === QUOTE) {
					value += text.substring(segmentStart, position);
					if (text.charCodeAt(position + 1) === QUOTE && position + 1 < limit) {
						value += '"';
						position += 2;
						segmentStart = position;
						continue;
					}
					position++;
					segmentStart = -1;
					break;
				}
				position++;
			}
			if (segmentStart !== -1) {
				// 閉じ引用符が無いまま終わった。残りを値とする。
				value += text.substring(segmentStart, position);
			}
		}
		const tailStart = position;
		while (position < limit) {
			const code = text.charCodeAt(position);
			if (code === delimiterCode || code === LF || code === CR) {
				break;
			}
			position++;
		}
		value += text.substring(tailStart, position);
		if (fields.length < maxFields) {
			fields.push(value);
		}
		if (position < limit && text.charCodeAt(position) === delimiterCode) {
			position++;
			continue;
		}
		return fields;
	}
}

const NUMERIC_PATTERN = /^\s*[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?\s*$/;

/** 数値として読めるフィールドか（右寄せと並べ替えに使う）。桁区切りのカンマを許す。 */
export function isParadisCsvNumeric(value: string): boolean {
	return value.length > 0 && value.length < 64 && /\d/.test(value) && NUMERIC_PATTERN.test(value);
}

function numericValue(value: string): number {
	return Number(value.replace(/,/g, '').trim());
}

export type ParadisCsvSortDirection = 'asc' | 'desc';

/** 非同期処理の合間に UI へ制御を返すための関数。 */
export type ParadisCsvYield = () => Promise<void>;

/**
 * データ行を列 `column` で並べ替えた表示順（データ行の番号 0..n-1 の並び）を返す。
 * 数値は数値として比べ、数値は文字列より先に並べる。空欄は向きに関係なく末尾に置く。同じ値は元の順を保つ。
 */
export async function sortParadisCsvRows(document: ParadisCsvDocument, column: number, direction: ParadisCsvSortDirection, yieldToHost: ParadisCsvYield, token: CancellationToken): Promise<Uint32Array> {
	const count = document.dataRowCount;
	const numbers = new Float64Array(count);
	const strings: string[] = new Array(count);
	// 0 = 空欄, 1 = 数値, 2 = 文字列
	const kinds = new Uint8Array(count);
	for (let row = 0; row < count; row++) {
		if (row % DEFAULT_CHUNK_RECORDS === 0 && row > 0) {
			await yieldToHost();
			throwIfCancelled(token);
		}
		const value = document.getField(row + 1, column);
		if (value.trim().length === 0) {
			kinds[row] = 0;
		} else if (isParadisCsvNumeric(value)) {
			kinds[row] = 1;
			numbers[row] = numericValue(value);
		} else {
			kinds[row] = 2;
			strings[row] = value;
		}
	}
	throwIfCancelled(token);
	const sign = direction === 'asc' ? 1 : -1;
	const order = new Uint32Array(count);
	for (let row = 0; row < count; row++) {
		order[row] = row;
	}
	order.sort((left, right) => {
		const leftKind = kinds[left];
		const rightKind = kinds[right];
		if (leftKind === 0 || rightKind === 0) {
			return leftKind === rightKind ? left - right : leftKind === 0 ? 1 : -1;
		}
		let result: number;
		if (leftKind !== rightKind) {
			result = leftKind - rightKind;
		} else if (leftKind === 1) {
			result = numbers[left] - numbers[right];
		} else {
			const a = strings[left];
			const b = strings[right];
			result = a < b ? -1 : a > b ? 1 : 0;
		}
		return result !== 0 ? result * sign : left - right;
	});
	return order;
}

export interface ParadisCsvMatch {
	/** 表示上の行（0 = 見出し行、1 以降はデータ行の表示順）。 */
	readonly row: number;
	/** 列（0 始まり）。 */
	readonly column: number;
	/** 一致を含むフィールドの値。 */
	readonly value: string;
	/** フィールド内での一致の開始位置。 */
	readonly offset: number;
}

export interface ParadisCsvSearchResult {
	readonly matches: readonly ParadisCsvMatch[];
	/** 上限に達して打ち切った。 */
	readonly capped: boolean;
}

/**
 * 表示順（見出し行 → データ行を `order` の順）にセルを検索する。
 * 引用符を含まない検索語は、まずレコードの生の本文で当たりを付けてから解析するので速い。
 */
export async function searchParadisCsv(
	document: ParadisCsvDocument,
	order: Uint32Array | undefined,
	query: string,
	matchCase: boolean,
	yieldToHost: ParadisCsvYield,
	token: CancellationToken,
	limit = PARADIS_CSV_SEARCH_LIMIT,
): Promise<ParadisCsvSearchResult> {
	const needle = matchCase ? query : query.toLowerCase();
	const matches: ParadisCsvMatch[] = [];
	if (!needle) {
		return { matches, capped: false };
	}
	const canPrefilter = !query.includes('"');
	for (let row = 0; row < document.recordCount; row++) {
		if (row % DEFAULT_CHUNK_RECORDS === 0 && row > 0) {
			await yieldToHost();
			throwIfCancelled(token);
		}
		const record = row === 0 ? 0 : 1 + (order ? order[row - 1] : row - 1);
		if (canPrefilter) {
			const [start, end] = document.recordRange(record);
			const raw = document.text.substring(start, end);
			if (!(matchCase ? raw : raw.toLowerCase()).includes(needle)) {
				continue;
			}
		}
		const fields = document.getRecord(record);
		for (let column = 0; column < fields.length; column++) {
			const value = fields[column];
			const offset = (matchCase ? value : value.toLowerCase()).indexOf(needle);
			if (offset !== -1) {
				if (matches.length >= limit) {
					return { matches, capped: true };
				}
				matches.push({ row, column, value, offset });
			}
		}
	}
	return { matches, capped: false };
}

/**
 * 表の範囲をタブ区切りテキストにする（Excel に貼り付けられる形）。
 * タブ・改行・引用符を含む値だけを引用符で囲み、中の `"` は `""` にする。
 */
export function formatParadisCsvAsTsv(rows: readonly (readonly string[])[]): string {
	return rows.map(row => row.map(quoteTsvField).join('\t')).join('\n');
}

function quoteTsvField(value: string): string {
	return /[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** 見出しと先頭数十行から列の初期幅（px）を見積もる。全角文字は半角の約 2 倍で数える。 */
export function estimateParadisCsvColumnWidth(samples: readonly string[], characterWidth = 7, padding = 18, minimum = 48, maximum = 320): number {
	let widest = 0;
	for (const sample of samples) {
		let width = 0;
		const text = sample.length > 200 ? sample.slice(0, 200) : sample;
		for (let index = 0; index < text.length; index++) {
			const code = text.charCodeAt(index);
			if (code === LF || code === CR) {
				break;
			}
			width += code >= 0x1100 ? characterWidth * 2 : characterWidth;
		}
		widest = Math.max(widest, width);
	}
	return Math.max(minimum, Math.min(maximum, Math.ceil(widest + padding)));
}

function throwIfCancelled(token: CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
}
