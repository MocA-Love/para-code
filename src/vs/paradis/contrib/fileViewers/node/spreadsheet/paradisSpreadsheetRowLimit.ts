/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 表示に使わない行を exceljs に読ませないための前処理。
//
// ビューアは各シートの先頭 MAX_ROWS 行しか表示しないが、exceljs は全行を Cell のオブジェクトにする。10 万行の
// ブックでは解析の 8 割以上がこの使わない行に使われていた。大きなシートだけ、表示に要る行より下のセルを
// 落としたシートの XML に差し替えてから exceljs に渡す。表示の結果が変わらないよう、次のものは残す。
//  - `</sheetData>` の後ろ（結合・条件付き書式・入力規則・ハイパーリンク・用紙設定など）はそのまま
//  - 表示の最後の行の 1 行下（罫線を隣のセルと突き合わせるため）と、表示の行にかかる結合の最後の行の 1 行下まで
//  - 落とす行の高さと非表示（図形の外枠の計算が使う）は、中身の無い `<row .../>` として残す
//  - 使っている範囲（exceljs の dimensions）が変わらないよう、落としたセルの値のある範囲の右端・左端・下端に
//    目印のセルを 1 行だけ置く（表示の行より下なので画面には出ない）
// 同じにできない形（行番号の無い行、印刷範囲の指定、親が残らない共有数式など）を見つけたら、ブックを
// そのまま返す（今までどおり全行を読む）。

import type JSZip from 'jszip';
import type { IParadisOfficeArchive } from '../../common/office/paradisOfficeArchive.js';
import { createParadisOfficeNodeArchive } from '../office/paradisOfficeNodeArchive.js';

/** これより小さいシート（展開後のバイト数）は手を入れない。小さいシートは全部読んでも速く、挙動を変えないため。 */
export const PARADIS_SPREADSHEET_ROW_LIMIT_MIN_SHEET_BYTES = 2 * 1024 * 1024;

const WORKSHEET_PART = /^xl\/worksheets\/[^/]+\.xml$/;

/** 同じにできない形を見つけた（ブックをそのまま使う）。 */
class RowLimitUnsupported extends Error { }

/**
 * 各シートの、表示に使わない行のセルを落としたブックを返す。手を入れるシートが無い・同じにできない形のときは
 * `buffer` をそのまま（同じオブジェクトを）返す。
 *
 * @param maxRows 表示する行の上限（`MAX_ROWS`）。表示は使っている範囲の先頭の行からこの行数まで。
 */
export async function limitWorkbookRowsForExcelJs(buffer: Buffer, maxRows: number, JSZipRuntime: typeof JSZip, minSheetBytes = PARADIS_SPREADSHEET_ROW_LIMIT_MIN_SHEET_BYTES): Promise<Buffer> {
	const names = await listLargeWorksheets(buffer, minSheetBytes);
	if (!names || names.large.length === 0) {
		return buffer;
	}
	const parts = await readAllParts(buffer);
	if (!parts) {
		return buffer;
	}
	try {
		const workbookXml = parts.get('xl/workbook.xml')?.toString('utf8') ?? '';
		// 印刷範囲があると、表示の範囲はセルではなく印刷範囲で決まる。印刷タイトルが上限より下の行を指すときも、
		// 落とした行を使うことになるので、どちらもそのまま読む。
		if (/_xlnm\.Print_Area/.test(workbookXml) || printTitleRowsBeyond(workbookXml, maxRows)) {
			return buffer;
		}
		const replaced = new Map<string, Buffer>();
		for (const name of names.large) {
			const xml = parts.get(name);
			const limited = xml && limitSheetRows(xml, maxRows);
			if (limited) {
				replaced.set(name, limited);
			}
		}
		if (replaced.size === 0) {
			return buffer;
		}
		const zip = new JSZipRuntime();
		for (const [name, data] of parts) {
			zip.file(name, replaced.get(name) ?? data, { createFolders: false });
		}
		return await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
	} catch (error) {
		if (error instanceof RowLimitUnsupported) {
			return buffer;
		}
		throw error;
	}
}

/** 展開後の大きさが `minSheetBytes` 以上のシートの部品名。ZIP として読めなければ `undefined`（exceljs に任せる）。 */
async function listLargeWorksheets(buffer: Buffer, minSheetBytes: number): Promise<{ readonly large: readonly string[] } | undefined> {
	let archive: IParadisOfficeArchive;
	try {
		archive = await createParadisOfficeNodeArchive(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
	} catch {
		return undefined;
	}
	const large: string[] = [];
	try {
		for await (const entry of archive.entries()) {
			if (!entry.directory && WORKSHEET_PART.test(entry.name) && entry.declaredExpandedBytes >= minSheetBytes) {
				large.push(entry.name);
			}
		}
	} catch {
		return undefined;
	} finally {
		archive.dispose();
	}
	return { large };
}

/** すべての部品を展開して返す（並びは ZIP の中の順）。読めなければ `undefined`。 */
async function readAllParts(buffer: Buffer): Promise<Map<string, Buffer> | undefined> {
	let archive: IParadisOfficeArchive;
	try {
		archive = await createParadisOfficeNodeArchive(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
	} catch {
		return undefined;
	}
	const parts = new Map<string, Buffer>();
	try {
		for await (const entry of archive.entries()) {
			if (entry.directory || entry.encrypted) {
				if (entry.encrypted) {
					return undefined;
				}
				continue;
			}
			const chunks: Uint8Array[] = [];
			for await (const chunk of archive.read(entry)) {
				chunks.push(chunk.slice());
			}
			parts.set(entry.name, Buffer.concat(chunks));
		}
	} catch {
		return undefined;
	} finally {
		archive.dispose();
	}
	return parts;
}

/** 印刷タイトル（`_xlnm.Print_Titles`）が `maxRows` より下の行を含むか。 */
function printTitleRowsBeyond(workbookXml: string, maxRows: number): boolean {
	for (const match of workbookXml.matchAll(/<definedName\b[^>]*name="_xlnm\.Print_Titles"[^>]*>([^<]*)<\/definedName>/g)) {
		for (const row of match[1].matchAll(/\$?(\d+)(?![A-Z\d])/g)) {
			if (Number(row[1]) > maxRows) {
				return true;
			}
		}
	}
	return false;
}

const GT = 0x3e; // >
const SLASH = 0x2f; // /

function isNameEnd(byte: number | undefined): boolean {
	return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === GT || byte === SLASH;
}

/** `from` から `end` の手前までで最初の `<tag`（名前がちょうど `tag` のもの）の位置。無ければ -1。 */
function findTag(xml: Buffer, tag: string, from: number, end: number): number {
	// 範囲の外まで探さない（無い名前を探すと、そのたびに残りの全部を読むことになる）。
	const range = xml.subarray(from, end);
	let index = range.indexOf(`<${tag}`, 0, 'latin1');
	while (index >= 0) {
		if (isNameEnd(range[index + tag.length + 1])) {
			return from + index;
		}
		index = range.indexOf(`<${tag}`, index + 1, 'latin1');
	}
	return -1;
}

/** 開始タグの終わり（`>` の次）と、空要素か。 */
function startTagEnd(xml: Buffer, start: number): { readonly end: number; readonly empty: boolean } {
	const close = xml.indexOf(GT, start);
	if (close < 0) {
		throw new RowLimitUnsupported();
	}
	return { end: close + 1, empty: xml[close - 1] === SLASH };
}

const attributePatterns = new Map<string, RegExp>();

function attribute(tag: string, name: string): string | undefined {
	let pattern = attributePatterns.get(name);
	if (!pattern) {
		pattern = new RegExp(`\\s${name}="([^"]*)"`);
		attributePatterns.set(name, pattern);
	}
	return pattern.exec(tag)?.[1];
}

/** 行の開始タグの `r` の値。無ければ NaN。行は数が多いので文字列にせずに読む。 */
function rowNumber(xml: Buffer, start: number, end: number): number {
	const found = xml.subarray(start, end).indexOf(' r="', 0, 'latin1');
	let at = start + found;
	if (found < 0) {
		// 空白が改行やタブのこともある
		const tag = xml.toString('latin1', start, end);
		return Number(attribute(tag, 'r'));
	}
	at += 4;
	let value = 0;
	let digits = 0;
	for (; xml[at] >= 0x30 && xml[at] <= 0x39; at++, digits++) {
		value = value * 10 + xml[at] - 0x30;
	}
	return digits > 0 && xml[at] === 0x22 ? value : NaN;
}

function columnNumber(letters: string): number {
	let value = 0;
	for (let index = 0; index < letters.length; index++) {
		value = value * 26 + letters.charCodeAt(index) - 64;
	}
	return value;
}

function columnLetters(column: number): string {
	let letters = '';
	for (let value = column; value > 0; value = Math.floor((value - 1) / 26)) {
		letters = String.fromCharCode(65 + (value - 1) % 26) + letters;
	}
	return letters;
}

function cellAddress(reference: string | undefined): { readonly row: number; readonly column: number } {
	const match = reference && /^([A-Z]{1,3})(\d+)$/.exec(reference);
	if (!match) {
		throw new RowLimitUnsupported();
	}
	return { column: columnNumber(match[1]), row: Number(match[2]) };
}

/** 行の開始タグに高さか非表示の指定があるか。 */
function hasRowLayout(xml: Buffer, row: IRowSpan): boolean {
	const tag = xml.subarray(row.start, row.tagEnd);
	return tag.indexOf(' ht="', 0, 'latin1') >= 0 || tag.indexOf(' hidden="', 0, 'latin1') >= 0;
}

interface IRowSpan {
	readonly number: number;
	readonly start: number;
	readonly tagEnd: number;
	readonly end: number;
	readonly empty: boolean;
}

interface ICellSpan {
	readonly start: number;
	readonly end: number;
	readonly column: number;
	readonly address: string;
	/** exceljs で値のあるセル（`ValueType.Null` でない）になるか。 */
	readonly hasValue: boolean;
}

/** `start` から始まる 1 つのセルを読む。 */
function readCell(xml: Buffer, start: number, rowEnd: number, hyperlinks: ReadonlySet<string>): ICellSpan {
	const tag = startTagEnd(xml, start);
	const address = attribute(xml.toString('latin1', start, tag.end), 'r');
	const { column } = cellAddress(address);
	let end = tag.end;
	let hasValue = hyperlinks.has(address!);
	if (!tag.empty) {
		const close = xml.indexOf('</c>', tag.end, 'latin1');
		if (close < 0 || close > rowEnd) {
			throw new RowLimitUnsupported();
		}
		end = close + 4;
		hasValue ||= findTag(xml, 'v', tag.end, close) >= 0 || findTag(xml, 'f', tag.end, close) >= 0 || findTag(xml, 'is', tag.end, close) >= 0;
	}
	return { start, end, column, address: address!, hasValue };
}

/** 行の中で、値のある最初のセル。無ければ `undefined`。 */
function firstValueCell(xml: Buffer, row: IRowSpan, hyperlinks: ReadonlySet<string>): ICellSpan | undefined {
	if (row.empty) {
		return undefined;
	}
	for (let index = findTag(xml, 'c', row.tagEnd, row.end); index >= 0;) {
		const cell = readCell(xml, index, row.end, hyperlinks);
		if (cell.hasValue) {
			return cell;
		}
		index = findTag(xml, 'c', cell.end, row.end);
	}
	return undefined;
}

/** 行の中で、値のある最後のセル（後ろから探す）。無ければ `undefined`。 */
function lastValueCell(xml: Buffer, row: IRowSpan, hyperlinks: ReadonlySet<string>): ICellSpan | undefined {
	if (row.empty) {
		return undefined;
	}
	for (let from = row.end - 1; from >= row.tagEnd;) {
		const range = xml.subarray(row.tagEnd, from + 1);
		let found = range.lastIndexOf('<c', range.length - 1, 'latin1');
		while (found >= 0 && !isNameEnd(range[found + 2])) {
			found = found > 0 ? range.lastIndexOf('<c', found - 1, 'latin1') : -1;
		}
		if (found < 0) {
			return undefined;
		}
		const index = row.tagEnd + found;
		const cell = readCell(xml, index, row.end, hyperlinks);
		if (cell.hasValue) {
			return cell;
		}
		from = index - 1;
	}
	return undefined;
}

/**
 * 1 枚のシートの XML から、表示に使わない行のセルを落とす。手を入れる必要が無ければ `undefined`。
 * 同じにできない形なら {@link RowLimitUnsupported} を投げる。
 */
export function limitSheetRows(xml: Buffer, maxRows: number): Buffer | undefined {
	const dataStart = findTag(xml, 'sheetData', 0, xml.byteLength);
	if (dataStart < 0) {
		return undefined;
	}
	const dataTag = startTagEnd(xml, dataStart);
	if (dataTag.empty) {
		return undefined;
	}
	const dataEnd = xml.indexOf('</sheetData>', dataTag.end, 'latin1');
	if (dataEnd < 0) {
		throw new RowLimitUnsupported();
	}
	const tail = xml.toString('latin1', dataEnd);

	// 結合（範囲の先頭の行と最後の行）。
	const merges: { readonly top: number; readonly bottom: number }[] = [];
	for (const match of tail.matchAll(/<mergeCell\b[^>]*>/g)) {
		const reference = attribute(match[0], 'ref');
		const parts = reference?.split(':');
		if (!parts || parts.length !== 2) {
			throw new RowLimitUnsupported();
		}
		const from = cellAddress(parts[0]);
		const to = cellAddress(parts[1]);
		merges.push({ top: Math.min(from.row, to.row), bottom: Math.max(from.row, to.row) });
	}
	// ハイパーリンクの付いたセルは、値が無くても exceljs では値のあるセルになる。
	const hyperlinks = new Set<string>();
	for (const match of tail.matchAll(/<hyperlink\b[^>]*>/g)) {
		const reference = attribute(match[0], 'ref');
		if (reference && /^[A-Z]{1,3}\d+$/.test(reference)) {
			hyperlinks.add(reference);
		} else if (reference) {
			// 範囲で付いたハイパーリンクは、どのセルに付くかを exceljs に任せる。
			throw new RowLimitUnsupported();
		}
	}

	// 行を上から順に読む。
	const rows: IRowSpan[] = [];
	let previous = 0;
	for (let index = findTag(xml, 'row', dataTag.end, dataEnd); index >= 0;) {
		const tag = startTagEnd(xml, index);
		const number = rowNumber(xml, index, tag.end);
		if (!Number.isSafeInteger(number) || number <= previous) {
			throw new RowLimitUnsupported();
		}
		previous = number;
		let end = tag.end;
		if (!tag.empty) {
			const close = xml.indexOf('</row>', tag.end, 'latin1');
			if (close < 0 || close > dataEnd) {
				throw new RowLimitUnsupported();
			}
			end = close + 6;
		}
		rows.push({ number, start: index, tagEnd: tag.end, end, empty: tag.empty });
		index = findTag(xml, 'row', end, dataEnd);
	}

	// 使っている範囲の先頭の行（値のあるセルの最初の行か、結合の先頭の行）。表示はここから maxRows 行。
	let firstRow = Infinity;
	for (const row of rows) {
		if (firstValueCell(xml, row, hyperlinks)) {
			firstRow = row.number;
			break;
		}
	}
	for (const merge of merges) {
		firstRow = Math.min(firstRow, merge.top);
	}
	if (firstRow === Infinity) {
		return undefined;
	}
	const lastShownRow = firstRow + maxRows - 1;
	// 表示の最後の行の 1 行下までと、表示の行にかかる結合の最後の行の 1 行下までは、セルごと残す。
	let keepThrough = lastShownRow + 1;
	for (const merge of merges) {
		if (merge.top <= lastShownRow) {
			keepThrough = Math.max(keepThrough, merge.bottom + 1);
		}
	}
	const firstDropped = rows.findIndex(row => row.number > keepThrough);
	if (firstDropped < 0) {
		return undefined;
	}

	// 残す行の共有数式は、親（ref のある式）も残る行にあること。
	const kept = xml.toString('latin1', dataTag.end, rows[firstDropped].start);
	const masters = new Set<string>();
	const children = new Set<string>();
	for (const match of kept.matchAll(/<f\b[^>]*>/g)) {
		if (attribute(match[0], 't') !== 'shared') {
			continue;
		}
		const index = attribute(match[0], 'si');
		if (index === undefined) {
			throw new RowLimitUnsupported();
		}
		(attribute(match[0], 'ref') !== undefined ? masters : children).add(index);
	}
	for (const index of children) {
		if (!masters.has(index)) {
			throw new RowLimitUnsupported();
		}
	}

	// 落とす行の、値のあるセルの範囲。セルは列の順に並ぶ（ECMA-376 の決まり）ので、行の両端から探す。
	let minColumn = Infinity;
	let maxColumn = -Infinity;
	let lastRowWithValue = 0;
	for (let index = firstDropped; index < rows.length; index++) {
		const first = firstValueCell(xml, rows[index], hyperlinks);
		if (!first) {
			continue;
		}
		const last = lastValueCell(xml, rows[index], hyperlinks)!;
		if (last.column < first.column) {
			throw new RowLimitUnsupported();
		}
		minColumn = Math.min(minColumn, first.column);
		maxColumn = Math.max(maxColumn, last.column);
		lastRowWithValue = rows[index].number;
	}

	// 組み立てる。落とす行は高さか非表示の指定があるときだけ空の行として残し、目印は値のある最後の行に置く。
	const marker = (row: number) => {
		const columns = minColumn === maxColumn ? [minColumn] : [minColumn, maxColumn];
		return columns.map(column => `<c r="${columnLetters(column)}${row}" t="inlineStr"><is><t>.</t></is></c>`).join('');
	};
	const out: Buffer[] = [xml.subarray(0, rows[firstDropped].start)];
	let markerPlaced = lastRowWithValue === 0;
	for (let index = firstDropped; index < rows.length; index++) {
		const row = rows[index];
		const isMarkerRow = !markerPlaced && row.number === lastRowWithValue;
		if (isMarkerRow) {
			const tag = xml.toString('latin1', row.start, row.tagEnd);
			const open = row.empty ? `${tag.slice(0, tag.lastIndexOf('/'))}>` : tag;
			out.push(Buffer.from(`${open}${marker(row.number)}</row>`, 'latin1'));
			markerPlaced = true;
		} else if (hasRowLayout(xml, row)) {
			const tag = xml.toString('latin1', row.start, row.tagEnd);
			out.push(Buffer.from(row.empty ? tag : `${tag.slice(0, -1).trimEnd()}/>`, 'latin1'));
		}
	}
	out.push(xml.subarray(dataEnd));
	return Buffer.concat(out);
}
