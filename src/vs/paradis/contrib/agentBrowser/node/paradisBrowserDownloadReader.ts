/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP の read_download（ダウンロードしたファイルの中身を返す）。
// 読めるのは Para Code のダウンロードの保存先（download_by_click・save_page_as_pdf が書く場所）の中だけ。
// xlsx はシートの一覧とセルの範囲、csv / tsv は行の範囲を、上限付きで文字にして返す。
// xlsx は Excel ビューアと同じ exceljs を、使うときにだけ読み込む（shared process の起動を重くしない）。
// PDF のテキストは、使える PDF のライブラリが shared process に無いので、今は扱わない。

import type ExcelJS from 'exceljs';
import { promises as fs } from 'fs';
import { basename, extname, isAbsolute, relative, sep } from '../../../../base/common/path.js';

export const PARADIS_READ_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_CELLS = 2000;
const MAX_MAX_CELLS = 20_000;
const MAX_CELL_CHARS = 500;
const MAX_OUTPUT_CHARS = 100_000;
const DEFAULT_ROWS = 100;
const DEFAULT_COLUMNS = 30;

/** サービスから借りるもの。 */
export interface IParadisDownloadReaderHost {
	/** ダウンロードの保存先（electron-main に聞く）。分からなければ undefined。 */
	downloadsDirectory(): Promise<string | undefined>;
	realpath?(path: string): Promise<string>;
	readFile?(path: string): Promise<Buffer>;
	loadExcel?(): Promise<typeof ExcelJS>;
}

type ToolResult = unknown;

function text(message: string): ToolResult {
	return { content: [{ type: 'text', text: message }] };
}

function error(message: string): ToolResult {
	return { content: [{ type: 'text', text: message }], isError: true };
}

interface IRange {
	readonly startRow: number;
	readonly startColumn: number;
	readonly endRow: number;
	readonly endColumn: number;
}

/** 列番号（1 始まり）から列名（A, B, ..., AA）。 */
export function paradisColumnName(column: number): string {
	let name = '';
	for (let value = column; value > 0; value = Math.floor((value - 1) / 26)) {
		name = String.fromCharCode(65 + (value - 1) % 26) + name;
	}
	return name;
}

/** "B2:F40" や "A1" を読む。読めなければ undefined。 */
export function paradisParseA1Range(value: string): IRange | undefined {
	const match = /^\s*(?<c1>[A-Za-z]{1,3})(?<r1>\d{1,7})\s*(?::\s*(?<c2>[A-Za-z]{1,3})(?<r2>\d{1,7}))?\s*$/.exec(value);
	if (!match?.groups) {
		return undefined;
	}
	const column = (letters: string) => [...letters.toUpperCase()].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
	const startRow = Number(match.groups.r1);
	const startColumn = column(match.groups.c1);
	const endRow = match.groups.r2 !== undefined ? Number(match.groups.r2) : startRow;
	const endColumn = match.groups.c2 !== undefined ? column(match.groups.c2) : startColumn;
	if (startRow < 1 || endRow < startRow || endColumn < startColumn) {
		return undefined;
	}
	return { startRow, startColumn, endRow, endColumn };
}

/** CSV / TSV を行の配列にする（引用符・引用符の中の改行・"" を扱う）。`maxRows` 行で止める。 */
export function paradisParseDelimited(content: string, delimiter: string, maxRows: number): { rows: string[][]; complete: boolean } {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	let index = content.charCodeAt(0) === 0xFEFF ? 1 : 0;
	for (; index < content.length; index++) {
		const char = content[index];
		if (quoted) {
			if (char === '"') {
				if (content[index + 1] === '"') {
					field += '"';
					index++;
				} else {
					quoted = false;
				}
			} else {
				field += char;
			}
			continue;
		}
		if (char === '"' && field.length === 0) {
			quoted = true;
		} else if (char === delimiter) {
			row.push(field);
			field = '';
		} else if (char === '\n' || char === '\r') {
			if (char === '\r' && content[index + 1] === '\n') {
				index++;
			}
			row.push(field);
			field = '';
			rows.push(row);
			row = [];
			if (rows.length >= maxRows) {
				return { rows, complete: index + 1 >= content.length };
			}
		} else {
			field += char;
		}
	}
	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return { rows, complete: true };
}

/** 文字コードを決めて文字にする（UTF-8 として読めなければ Shift_JIS）。 */
export function paradisDecodeText(data: Uint8Array): { text: string; encoding: string } {
	try {
		return { text: new TextDecoder('utf-8', { fatal: true }).decode(data), encoding: 'UTF-8' };
	} catch {
		try {
			return { text: new TextDecoder('shift_jis').decode(data), encoding: 'Shift_JIS' };
		} catch {
			return { text: new TextDecoder('utf-8').decode(data), encoding: 'UTF-8 (with invalid bytes replaced)' };
		}
	}
}

function cellText(value: string): string {
	const flat = value.replace(/\r?\n/g, '\\n').replace(/\t/g, ' ');
	return flat.length > MAX_CELL_CHARS ? `${flat.slice(0, MAX_CELL_CHARS)}...` : flat;
}

/** 範囲を「行番号: 値<TAB>値」の行にする。セルの上限で切る。 */
function renderRange(range: IRange, valueAt: (row: number, column: number) => string, maxCells: number): { lines: string[]; endRow: number; cut: boolean } {
	const width = range.endColumn - range.startColumn + 1;
	const lines: string[] = [`Columns: ${Array.from({ length: width }, (_, i) => paradisColumnName(range.startColumn + i)).join('\t')}`];
	let cells = 0;
	let chars = 0;
	for (let row = range.startRow; row <= range.endRow; row++) {
		if (cells + width > maxCells || chars > MAX_OUTPUT_CHARS) {
			return { lines, endRow: row - 1, cut: true };
		}
		const values = Array.from({ length: width }, (_, i) => cellText(valueAt(row, range.startColumn + i)));
		const line = `${row}: ${values.join('\t')}`;
		lines.push(line);
		cells += width;
		chars += line.length;
	}
	return { lines, endRow: range.endRow, cut: false };
}

function isInside(root: string, target: string): boolean {
	const between = relative(root, target);
	return between !== '' && between !== '..' && !between.startsWith(`..${sep}`) && !isAbsolute(between);
}

export class ParadisBrowserDownloadReader {

	constructor(private readonly host: IParadisDownloadReaderHost) { }

	async call(rawArgs: unknown): Promise<ToolResult> {
		const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {};
		const path = args.path;
		if (typeof path !== 'string' || !isAbsolute(path)) {
			return error('"path" must be the absolute path that download_by_click or save_page_as_pdf returned.');
		}
		const maxCells = args.max_cells ?? DEFAULT_MAX_CELLS;
		if (typeof maxCells !== 'number' || !Number.isInteger(maxCells) || maxCells < 1 || maxCells > MAX_MAX_CELLS) {
			return error(`"max_cells" must be an integer from 1 to ${MAX_MAX_CELLS}.`);
		}
		let range: IRange | undefined;
		if (args.range !== undefined) {
			range = typeof args.range === 'string' ? paradisParseA1Range(args.range) : undefined;
			if (!range) {
				return error('"range" must be a cell range like "A1:H50" (or one cell like "C3").');
			}
		}
		if (args.sheet !== undefined && (typeof args.sheet !== 'string' || args.sheet.length === 0)) {
			return error('"sheet" must be a sheet name (or use "sheet_number").');
		}
		if (args.sheet_number !== undefined && (typeof args.sheet_number !== 'number' || !Number.isInteger(args.sheet_number) || args.sheet_number < 1 || args.sheet !== undefined)) {
			return error('"sheet_number" must be an integer from 1 (the first sheet), and not given together with "sheet".');
		}
		const sheet = (args.sheet ?? args.sheet_number) as string | number | undefined;

		const realpath = this.host.realpath ?? (p => fs.realpath(p));
		const directory = await this.host.downloadsDirectory();
		if (directory === undefined) {
			return error('Para Code could not tell where browser downloads are saved, so it cannot read files yet. Retry in a moment.');
		}
		const [realDirectory, realFile] = await Promise.all([realpath(directory).catch(() => directory), realpath(path).catch(() => undefined)]);
		if (realFile === undefined) {
			return error(`No file at ${path}. Use the path that download_by_click or save_page_as_pdf returned.`);
		}
		if (!isInside(realDirectory, realFile)) {
			return error(`read_download only reads files in Para Code's download folder (${directory}), where download_by_click and save_page_as_pdf save them. ${path} is outside it.`);
		}
		let data: Buffer;
		try {
			const stat = await fs.stat(realFile);
			if (!stat.isFile()) {
				return error(`${path} is not a file.`);
			}
			if (stat.size > PARADIS_READ_DOWNLOAD_MAX_BYTES) {
				return error(`${path} is larger than ${PARADIS_READ_DOWNLOAD_MAX_BYTES / 1024 / 1024} MB, so it is not read.`);
			}
			data = await (this.host.readFile ?? (p => fs.readFile(p)))(realFile);
		} catch {
			return error(`Para Code could not read ${path}.`);
		}
		const extension = extname(realFile).toLowerCase();
		const name = basename(path);
		switch (extension) {
			case '.xlsx':
			case '.xlsm':
				return this.readWorkbook(name, data, sheet, range, maxCells);
			case '.csv':
			case '.tsv':
			case '.txt':
				return this.readDelimited(name, data, extension === '.tsv' ? '\t' : extension === '.txt' ? undefined : ',', range, maxCells);
			case '.pdf':
				return error('read_download cannot read the text of PDF files yet. Agents in a remote window find a copy of the file on their machine (the path in the download_by_click / save_page_as_pdf result) and can use a PDF tool there.');
			case '.xls':
				return error('Old Excel files (.xls) are not supported; only .xlsx / .xlsm.');
			default:
				return error(`read_download reads .xlsx, .xlsm, .csv, .tsv and .txt files, not "${extension || 'no extension'}".`);
		}
	}

	private async readWorkbook(name: string, data: Buffer, sheet: string | number | undefined, range: IRange | undefined, maxCells: number): Promise<ToolResult> {
		if (data.length >= 4 && data[0] === 0xD0 && data[1] === 0xCF && data[2] === 0x11 && data[3] === 0xE0) {
			return error(`${name} is password-protected (encrypted) or an old binary workbook, so it cannot be read.`);
		}
		let workbook: ExcelJS.Workbook;
		try {
			const Excel = await (this.host.loadExcel ?? (async () => (await import('exceljs')).default))();
			workbook = new Excel.Workbook();
			await workbook.xlsx.load(data as unknown as ArrayBuffer);
		} catch {
			return error(`${name} could not be read as an Excel workbook.`);
		}
		const sheets = workbook.worksheets.map((worksheet, index) => ({ number: index + 1, name: worksheet.name, rows: worksheet.rowCount, columns: worksheet.columnCount, ...(worksheet.state !== 'visible' ? { hidden: true } : {}) }));
		if (sheets.length === 0) {
			return text(`${name} has no sheets.`);
		}
		const worksheet = sheet === undefined ? workbook.worksheets[0]
			: typeof sheet === 'number' ? workbook.worksheets[sheet - 1]
				: workbook.worksheets.find(candidate => candidate.name === sheet) ?? workbook.worksheets.find(candidate => candidate.name.toLowerCase() === sheet.toLowerCase());
		if (!worksheet) {
			return error(`${name} has no sheet ${JSON.stringify(sheet)}. Sheets: ${JSON.stringify(sheets)}`);
		}
		const used: IRange = { startRow: 1, startColumn: 1, endRow: Math.max(1, worksheet.rowCount), endColumn: Math.max(1, worksheet.columnCount) };
		const wanted = range ?? { ...used, endRow: Math.min(used.endRow, DEFAULT_ROWS), endColumn: Math.min(used.endColumn, DEFAULT_COLUMNS) };
		const rendered = renderRange(wanted, (row, column) => {
			const cell = worksheet.getCell(row, column);
			try {
				return cell.text ?? '';
			} catch {
				return String(cell.value ?? '');
			}
		}, maxCells);
		const shown = `${paradisColumnName(wanted.startColumn)}${wanted.startRow}:${paradisColumnName(wanted.endColumn)}${rendered.endRow}`;
		const more = rendered.cut || (range === undefined && (used.endRow > wanted.endRow || used.endColumn > wanted.endColumn))
			? `\nThe sheet has more (used area A1:${paradisColumnName(used.endColumn)}${used.endRow}); pass "range" for another part, or raise "max_cells".`
			: '';
		return text(`${name}: ${sheets.length} sheet(s): ${JSON.stringify(sheets)}\nSheet "${worksheet.name}", cells ${shown} (values as displayed; formulas show their last calculated result):${more}\n${rendered.lines.join('\n')}`);
	}

	private readDelimited(name: string, data: Buffer, delimiter: string | undefined, range: IRange | undefined, maxCells: number): ToolResult {
		const decoded = paradisDecodeText(data);
		const firstLine = decoded.text.slice(0, decoded.text.search(/\r?\n|$/));
		const separator = delimiter ?? (firstLine.includes('\t') ? '\t' : ',');
		const lastRow = range?.endRow ?? DEFAULT_ROWS;
		const parsed = paradisParseDelimited(decoded.text, separator, lastRow);
		const columns = parsed.rows.reduce((max, row) => Math.max(max, row.length), 1);
		const wanted = range ?? { startRow: 1, startColumn: 1, endRow: Math.max(1, parsed.rows.length), endColumn: Math.min(columns, DEFAULT_COLUMNS) };
		if (wanted.startRow > parsed.rows.length) {
			return error(`${name} has only ${parsed.rows.length} row(s).`);
		}
		const bounded = { ...wanted, endRow: Math.min(wanted.endRow, parsed.rows.length) };
		const rendered = renderRange(bounded, (row, column) => parsed.rows[row - 1]?.[column - 1] ?? '', maxCells);
		const more = rendered.cut || !parsed.complete || (range === undefined && columns > wanted.endColumn)
			? '\nThe file has more; pass "range" (for example "A101:Z200") for another part.'
			: '';
		return text(`${name} (${decoded.encoding}, ${separator === '\t' ? 'tab' : 'comma'}-separated), rows ${bounded.startRow}-${rendered.endRow}, columns ${paradisColumnName(bounded.startColumn)}-${paradisColumnName(bounded.endColumn)}:${more}\n${rendered.lines.join('\n')}`);
	}
}
