/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { localize } from '../../../../nls.js';
import type {
	ParadisOfficePlaceholder,
	ParadisOfficePrintBlock,
	ParadisOfficePrintGridCell,
	ParadisOfficePrintGridDrawing,
	ParadisOfficePrintSheetGrid,
	ParadisOfficePrintModel,
	ParadisOfficePrintPage,
	ParadisOfficeTextRun,
} from './paradisOfficeProtocol.js';

export const PARADIS_OFFICE_PRINT_LIMITS = Object.freeze({
	maximumPages: 1_000,
	maximumBlocks: 100_000,
	maximumBlockDepth: 64,
	maximumTextBytes: 8 * 1024 * 1024,
	maximumHtmlBytes: 16 * 1024 * 1024,
	maximumPdfBytes: 64 * 1024 * 1024,
});

export type ParadisOfficePrintErrorCode =
	| 'invalidModel'
	| 'invalidPageRange'
	| 'limitExceeded'
	| 'cancelled'
	| 'unsupported'
	| 'printFailed';

/** Safe print failure identity. Raw causes, paths, and backend messages are never retained. */
export class ParadisOfficePrintError extends Error {
	constructor(readonly code: ParadisOfficePrintErrorCode) {
		super(`Office print failed: ${code}`);
		this.name = 'ParadisOfficePrintError';
	}
}

export interface ParadisOfficePrintRange {
	readonly minRow: number;
	readonly minColumn: number;
	readonly maxRow: number;
	readonly maxColumn: number;
}

export type ParadisOfficePrintLinePrimitive =
	| {
		readonly kind: 'cellDiagonal' | 'tableDiagonal';
		readonly nodeId: string;
		readonly direction: 'topLeftToBottomRight' | 'topRightToBottomLeft' | 'both';
	}
	| { readonly kind: 'drawingLine'; readonly nodeId: string; readonly label?: string };

export interface ParadisOfficeSpreadsheetPrintCell {
	readonly nodeId: string;
	readonly row: number;
	readonly column: number;
	readonly runs: readonly ParadisOfficeTextRun[];
	readonly lines?: readonly ParadisOfficePrintLinePrimitive[];
	/** Merged cell size (laid-out sheets only). */
	readonly rowSpan?: number;
	readonly columnSpan?: number;
	/** Inline CSS of the cell (laid-out sheets only). */
	readonly css?: string;
}

/**
 * The sheet's geometry, so pages can be laid out like the sheet instead of as a plain table.
 * Sizes are in points. `columnWidths[0]` is column `minColumn`, `rowHeights[0]` is row `minRow`.
 * Drawings are positioned in points from the top-left of (`minRow`, `minColumn`).
 */
export interface ParadisOfficeSpreadsheetPrintLayout {
	readonly minRow: number;
	readonly minColumn: number;
	readonly rowHeights: readonly number[];
	readonly columnWidths: readonly number[];
	readonly drawings: readonly ParadisOfficePrintGridDrawing[];
	readonly gridLines: boolean;
	readonly scale: number;
	/** Top, right, bottom, left. */
	readonly marginsPoints: readonly [number, number, number, number];
	readonly horizontalCentered?: boolean;
	readonly verticalCentered?: boolean;
}

export interface ParadisOfficePrintHeaderFooterContent {
	readonly left?: string;
	readonly center?: string;
	readonly right?: string;
}

export interface ParadisOfficePrintHeaderFooterVariant {
	readonly header?: ParadisOfficePrintHeaderFooterContent;
	readonly footer?: ParadisOfficePrintHeaderFooterContent;
}

export interface ParadisOfficeSpreadsheetPrintSheet {
	readonly nodeId: string;
	readonly name: string;
	readonly cells: readonly ParadisOfficeSpreadsheetPrintCell[];
	readonly printAreas?: readonly ParadisOfficePrintRange[];
	/** Saved page rectangles produced from page setup and manual/automatic breaks, never live DOM measurements. */
	readonly pageRanges?: readonly ParadisOfficePrintRange[];
	readonly pageSetup?: { readonly widthPoints: number; readonly heightPoints: number };
	readonly printTitles?: {
		readonly rows?: { readonly from: number; readonly to: number };
		readonly columns?: { readonly from: number; readonly to: number };
	};
	readonly headerFooter?: {
		readonly odd?: ParadisOfficePrintHeaderFooterVariant;
		readonly even?: ParadisOfficePrintHeaderFooterVariant;
		readonly first?: ParadisOfficePrintHeaderFooterVariant;
	};
	readonly placeholders?: readonly ParadisOfficePlaceholder[];
	/** When present, pages are laid out as the sheet (sizes, styles, drawings) rather than as a plain table. */
	readonly layout?: ParadisOfficeSpreadsheetPrintLayout;
}

export interface ParadisOfficeSpreadsheetPrintInput {
	readonly title: string;
	readonly sheets: readonly ParadisOfficeSpreadsheetPrintSheet[];
	/** Drawings the caller already left out because of `PARADIS_OFFICE_PRINT_DRAWING_BYTES`. */
	readonly omittedDrawings?: number;
}

export type ParadisOfficeWordPrintItem =
	| { readonly kind: 'block'; readonly block: ParadisOfficePrintBlock }
	| { readonly kind: 'pageBreak'; readonly nodeId: string; readonly source: 'explicit' | 'saved' };

export interface ParadisOfficeWordPrintSection {
	readonly nodeId: string;
	readonly breakBefore?: 'continuous' | 'nextPage' | 'oddPage' | 'evenPage';
	readonly widthPoints: number;
	readonly heightPoints: number;
	readonly items: readonly ParadisOfficeWordPrintItem[];
	readonly placeholders: readonly ParadisOfficePlaceholder[];
}

export interface ParadisOfficeWordPrintInput {
	readonly title: string;
	readonly sections: readonly ParadisOfficeWordPrintSection[];
}

export interface ParadisOfficePrintHtmlArtifact {
	readonly html: string;
	readonly byteLength: number;
	readonly model: ParadisOfficePrintModel;
}

interface MutablePage {
	readonly widthPoints: number;
	readonly heightPoints: number;
	readonly blocks: ParadisOfficePrintBlock[];
	readonly placeholders: ParadisOfficePlaceholder[];
}

function throwIfCancelled(token: CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new ParadisOfficePrintError('cancelled');
	}
}

function isPositiveInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

function validateRange(range: ParadisOfficePrintRange): void {
	if (!isPositiveInteger(range.minRow) || !isPositiveInteger(range.minColumn)
		|| !isPositiveInteger(range.maxRow) || !isPositiveInteger(range.maxColumn)
		|| range.minRow > range.maxRow || range.minColumn > range.maxColumn) {
		throw new ParadisOfficePrintError('invalidModel');
	}
}

function contains(range: ParadisOfficePrintRange, row: number, column: number): boolean {
	return row >= range.minRow && row <= range.maxRow && column >= range.minColumn && column <= range.maxColumn;
}

function intersects(first: ParadisOfficePrintRange, second: ParadisOfficePrintRange): boolean {
	return first.minRow <= second.maxRow && first.maxRow >= second.minRow
		&& first.minColumn <= second.maxColumn && first.maxColumn >= second.minColumn;
}

function boundingRange(cells: readonly ParadisOfficeSpreadsheetPrintCell[]): ParadisOfficePrintRange {
	if (cells.length === 0) {
		return { minRow: 1, minColumn: 1, maxRow: 1, maxColumn: 1 };
	}
	let minRow = Number.MAX_SAFE_INTEGER;
	let minColumn = Number.MAX_SAFE_INTEGER;
	let maxRow = 1;
	let maxColumn = 1;
	for (const cell of cells) {
		minRow = Math.min(minRow, cell.row);
		minColumn = Math.min(minColumn, cell.column);
		maxRow = Math.max(maxRow, cell.row);
		maxColumn = Math.max(maxColumn, cell.column);
	}
	return { minRow, minColumn, maxRow, maxColumn };
}

function lineDirectionLabel(direction: Extract<ParadisOfficePrintLinePrimitive, { readonly kind: 'cellDiagonal' | 'tableDiagonal' }>['direction']): string {
	switch (direction) {
		case 'topLeftToBottomRight': return localize('paradis.office.print.line.down', "左上から右下");
		case 'topRightToBottomLeft': return localize('paradis.office.print.line.up', "右上から左下");
		case 'both': return localize('paradis.office.print.line.both', "両方向");
	}
}

/** Converts line semantics to a stable label instead of replaying viewer pixel geometry or transforms. */
export function createParadisOfficeLineLabelBlock(line: ParadisOfficePrintLinePrimitive): ParadisOfficePrintBlock {
	let text: string;
	switch (line.kind) {
		case 'cellDiagonal':
			text = localize('paradis.office.print.cellDiagonal', "斜線: {0}", lineDirectionLabel(line.direction));
			break;
		case 'tableDiagonal':
			text = localize('paradis.office.print.tableDiagonal', "表の斜線: {0}", lineDirectionLabel(line.direction));
			break;
		case 'drawingLine':
			text = line.label
				? localize('paradis.office.print.drawingLineNamed', "図形の線: {0}", line.label)
				: localize('paradis.office.print.drawingLine', "図形の線");
			break;
	}
	return { kind: 'text', nodeId: `${line.nodeId}:print-label`, runs: [{ text }] };
}

function spreadsheetCellBlock(cell: ParadisOfficeSpreadsheetPrintCell): ParadisOfficePrintBlock {
	const text: ParadisOfficePrintBlock = { kind: 'text', nodeId: `${cell.nodeId}:text`, runs: cell.runs };
	const children = [text, ...(cell.lines ?? []).map(createParadisOfficeLineLabelBlock)];
	return { kind: 'container', nodeId: cell.nodeId, role: 'cell', children };
}

function tableBlock(sheet: ParadisOfficeSpreadsheetPrintSheet, cells: readonly ParadisOfficeSpreadsheetPrintCell[], suffix: string): ParadisOfficePrintBlock {
	const rows = new Map<number, ParadisOfficeSpreadsheetPrintCell[]>();
	for (const cell of cells) {
		const row = rows.get(cell.row) ?? [];
		row.push(cell);
		rows.set(cell.row, row);
	}
	const rowBlocks = [...rows.entries()]
		.sort(([first], [second]) => first - second)
		.map(([row, rowCells]): ParadisOfficePrintBlock => ({
			kind: 'container',
			nodeId: `${sheet.nodeId}:${suffix}:row:${row}`,
			role: 'row',
			children: rowCells.sort((first, second) => first.column - second.column).map(spreadsheetCellBlock),
		}));
	return { kind: 'container', nodeId: `${sheet.nodeId}:${suffix}:table`, role: 'table', children: rowBlocks };
}

/** Drawing images (SVG data URLs) one print model may carry. They also count toward `maximumTextBytes`. */
export const PARADIS_OFFICE_PRINT_DRAWING_BYTES = 6 * 1024 * 1024;

/** Budget shared by every page of one model; a drawing that reaches into several pages is counted on each. */
interface DrawingBudget {
	remaining: number;
	readonly omitted: Set<string>;
}

/** The page's rows (or columns): the repeated titles that come before the page, then the page itself. */
function pageIndexes(range: { readonly from: number; readonly to: number } | undefined, first: number, last: number): { readonly indexes: readonly number[]; readonly titles: number } {
	const indexes: number[] = [];
	if (range) {
		for (let index = range.from; index <= Math.min(range.to, first - 1); index++) {
			indexes.push(index);
		}
	}
	const titles = indexes.length;
	for (let index = first; index <= last; index++) {
		indexes.push(index);
	}
	return { indexes, titles };
}

/** How many of `span` rows (or columns) starting at `index` are on the page next to each other. */
function visibleSpan(indexes: readonly number[], position: number, start: number, span: number | undefined): number {
	let visible = 1;
	while (visible < (span ?? 1) && indexes[position + visible] === start + visible) {
		visible++;
	}
	return visible;
}

/** Lays one page out like the sheet: the repeated titles, the page range's rows and columns, its cells, and the drawings that reach into it. */
function sheetGridBlock(
	sheet: ParadisOfficeSpreadsheetPrintSheet,
	layout: ParadisOfficeSpreadsheetPrintLayout,
	cells: readonly ParadisOfficeSpreadsheetPrintCell[],
	pageRange: ParadisOfficePrintRange,
	suffix: string,
	budget: DrawingBudget,
): ParadisOfficePrintBlock {
	const size = (values: readonly number[], first: number, index: number) => {
		const value = values[index - first];
		return Number.isFinite(value) && value > 0 ? value : 0;
	};
	const offset = (values: readonly number[], first: number, index: number) => {
		let total = 0;
		for (let current = first; current < index; current++) {
			total += size(values, first, current);
		}
		return total;
	};
	const rowIndexes = pageIndexes(sheet.printTitles?.rows, pageRange.minRow, pageRange.maxRow);
	const columnIndexes = pageIndexes(sheet.printTitles?.columns, pageRange.minColumn, pageRange.maxColumn);
	const rowAt = new Map(rowIndexes.indexes.map((row, position) => [row, position]));
	const columnAt = new Map(columnIndexes.indexes.map((column, position) => [column, position]));
	const rows = rowIndexes.indexes.map(row => size(layout.rowHeights, layout.minRow, row));
	const columns = columnIndexes.indexes.map(column => size(layout.columnWidths, layout.minColumn, column));
	const gridCells: ParadisOfficePrintGridCell[] = [];
	for (const cell of cells) {
		const row = rowAt.get(cell.row);
		const column = columnAt.get(cell.column);
		if (row === undefined || column === undefined) {
			continue;
		}
		const rowSpan = visibleSpan(rowIndexes.indexes, row, cell.row, cell.rowSpan);
		const columnSpan = visibleSpan(columnIndexes.indexes, column, cell.column, cell.columnSpan);
		gridCells.push({
			row,
			column,
			...(rowSpan > 1 ? { rowSpan } : {}),
			...(columnSpan > 1 ? { columnSpan } : {}),
			runs: cell.runs,
			...(cell.css ? { css: cell.css } : {}),
		});
	}
	// Drawings are placed in the page body (after the titles), in points from its top-left, and clipped to it.
	const left = offset(layout.columnWidths, layout.minColumn, pageRange.minColumn);
	const top = offset(layout.rowHeights, layout.minRow, pageRange.minRow);
	const width = columns.slice(columnIndexes.titles).reduce((sum, value) => sum + value, 0);
	const height = rows.slice(rowIndexes.titles).reduce((sum, value) => sum + value, 0);
	const drawings: ParadisOfficePrintGridDrawing[] = [];
	for (const drawing of layout.drawings) {
		if (!(drawing.x < left + width && drawing.x + drawing.width > left && drawing.y < top + height && drawing.y + drawing.height > top)) {
			continue;
		}
		if (drawing.href.length > budget.remaining) {
			budget.omitted.add(drawing.nodeId);
			continue;
		}
		budget.remaining -= drawing.href.length;
		drawings.push({ ...drawing, x: drawing.x - left, y: drawing.y - top });
	}
	return {
		kind: 'sheetGrid',
		nodeId: `${sheet.nodeId}:${suffix}:grid`,
		grid: {
			columns,
			rows,
			cells: gridCells,
			drawings,
			gridLines: layout.gridLines,
			scale: layout.scale,
			...(rowIndexes.titles ? { titleRows: rowIndexes.titles } : {}),
			...(columnIndexes.titles ? { titleColumns: columnIndexes.titles } : {}),
			...(layout.horizontalCentered ? { horizontalCentered: true } : {}),
			...(layout.verticalCentered ? { verticalCentered: true } : {}),
		},
	};
}

function textSection(nodeId: string, content: ParadisOfficePrintHeaderFooterContent | undefined): ParadisOfficePrintBlock | undefined {
	if (!content) {
		return undefined;
	}
	const children = (['left', 'center', 'right'] as const).flatMap(position => content[position] === undefined ? [] : [{
		kind: 'text' as const,
		nodeId: `${nodeId}:${position}`,
		runs: [{ text: content[position]! }],
	}]);
	return children.length > 0 ? { kind: 'container', nodeId, role: 'section', children } : undefined;
}

function pageHeaderFooter(sheet: ParadisOfficeSpreadsheetPrintSheet, pageIndex: number): ParadisOfficePrintHeaderFooterVariant | undefined {
	if (pageIndex === 0 && sheet.headerFooter?.first) {
		return sheet.headerFooter.first;
	}
	return (pageIndex + 1) % 2 === 0 ? sheet.headerFooter?.even ?? sheet.headerFooter?.odd : sheet.headerFooter?.odd;
}

function titleCell(sheet: ParadisOfficeSpreadsheetPrintSheet, pageRange: ParadisOfficePrintRange, cell: ParadisOfficeSpreadsheetPrintCell): boolean {
	const titleRow = sheet.printTitles?.rows;
	const titleColumn = sheet.printTitles?.columns;
	return !!(titleRow && cell.row >= titleRow.from && cell.row <= titleRow.to
		&& cell.column >= pageRange.minColumn && cell.column <= pageRange.maxColumn)
		|| !!(titleColumn && cell.column >= titleColumn.from && cell.column <= titleColumn.to
			&& cell.row >= pageRange.minRow && cell.row <= pageRange.maxRow);
}

/** Builds an Excel print model from semantic ranges and saved page rectangles, never from viewer DOM. */
export function createParadisOfficeSpreadsheetPrintModel(input: ParadisOfficeSpreadsheetPrintInput, token: CancellationToken = CancellationToken.None): ParadisOfficePrintModel {
	throwIfCancelled(token);
	const pages: ParadisOfficePrintPage[] = [];
	let approximated = false;
	const drawingBudget: DrawingBudget = { remaining: PARADIS_OFFICE_PRINT_DRAWING_BYTES, omitted: new Set() };
	for (const sheet of input.sheets) {
		throwIfCancelled(token);
		for (const cell of sheet.cells) {
			if (!isPositiveInteger(cell.row) || !isPositiveInteger(cell.column)) {
				throw new ParadisOfficePrintError('invalidModel');
			}
		}
		const areas = sheet.printAreas?.length ? [...sheet.printAreas] : [boundingRange(sheet.cells)];
		areas.forEach(validateRange);
		const savedPageRanges = sheet.pageRanges?.length ? [...sheet.pageRanges] : undefined;
		savedPageRanges?.forEach(validateRange);
		const pageRanges = savedPageRanges?.filter(pageRange => areas.some(area => intersects(area, pageRange))) ?? [...areas];
		approximated ||= !sheet.pageRanges?.length;
		const widthPoints = sheet.pageSetup?.widthPoints ?? 612;
		const heightPoints = sheet.pageSetup?.heightPoints ?? 792;
		for (let pageIndex = 0; pageIndex < pageRanges.length; pageIndex++) {
			throwIfCancelled(token);
			const pageRange = pageRanges[pageIndex];
			const cells = sheet.cells.filter(cell => (areas.some(area => intersects(area, pageRange) && contains(area, cell.row, cell.column))
				&& contains(pageRange, cell.row, cell.column)) || titleCell(sheet, pageRange, cell));
			const headerFooter = pageHeaderFooter(sheet, pageIndex);
			const header = textSection(`${sheet.nodeId}:page:${pageIndex}:header`, headerFooter?.header);
			const footer = textSection(`${sheet.nodeId}:page:${pageIndex}:footer`, headerFooter?.footer);
			const placeholders = [...(sheet.placeholders ?? [])];
			const layout = sheet.layout;
			const blocks: ParadisOfficePrintBlock[] = [
				...(header ? [header] : []),
				layout ? sheetGridBlock(sheet, layout, cells, pageRange, `page:${pageIndex}`, drawingBudget) : tableBlock(sheet, cells, `page:${pageIndex}`),
				...placeholders.map(placeholder => ({ kind: 'placeholder' as const, nodeId: placeholder.nodeId, placeholder })),
				...(footer ? [footer] : []),
			];
			pages.push({ pageNumber: pages.length + 1, widthPoints, heightPoints, ...(layout ? { marginsPoints: layout.marginsPoints } : {}), blocks, placeholders });
		}
	}
	if (pages.length === 0) {
		throw new ParadisOfficePrintError('invalidModel');
	}
	const approximationWarnings: { code: string; message: string }[] = approximated ? [{
		code: 'spreadsheet.pagination.approximate',
		message: localize('paradis.office.print.spreadsheetApproximate', "保存されたページ情報がないため、ページ区切りは概算です。"),
	}] : [];
	const omittedDrawings = drawingBudget.omitted.size + (input.omittedDrawings ?? 0);
	if (omittedDrawings > 0) {
		approximationWarnings.push({
			code: 'spreadsheet.printDrawingLimit',
			message: localize('paradis.office.print.spreadsheetDrawingLimit', "図形と画像が多いため、{0} 件を印刷していません。", omittedDrawings),
		});
	}
	const model = { title: input.title, pages, approximationWarnings };
	validatePrintModel(model, token);
	return model;
}

function finalizeWordPage(pages: ParadisOfficePrintPage[], section: ParadisOfficeWordPrintSection, mutable: MutablePage): void {
	const blocks: ParadisOfficePrintBlock[] = [{
		kind: 'container',
		nodeId: `${section.nodeId}:page:${pages.length}`,
		role: 'section',
		children: mutable.blocks,
	}];
	pages.push({
		pageNumber: pages.length + 1,
		widthPoints: mutable.widthPoints,
		heightPoints: mutable.heightPoints,
		blocks,
		placeholders: [...mutable.placeholders],
	});
}

/** Builds Word pages from section boundaries and explicit/saved breaks, without pretending to run Word layout. */
export function createParadisOfficeWordPrintModel(input: ParadisOfficeWordPrintInput, token: CancellationToken = CancellationToken.None): ParadisOfficePrintModel {
	throwIfCancelled(token);
	const pages: ParadisOfficePrintPage[] = [];
	let current: MutablePage | undefined;
	let currentSection: ParadisOfficeWordPrintSection | undefined;
	for (let sectionIndex = 0; sectionIndex < input.sections.length; sectionIndex++) {
		throwIfCancelled(token);
		const section = input.sections[sectionIndex];
		const startsNewPage = sectionIndex > 0 && section.breakBefore !== 'continuous';
		if (current && currentSection && startsNewPage) {
			finalizeWordPage(pages, currentSection, current);
			current = undefined;
			const requiredParity = section.breakBefore === 'oddPage' ? 1 : section.breakBefore === 'evenPage' ? 0 : undefined;
			if (requiredParity !== undefined && (pages.length + 1) % 2 !== requiredParity) {
				finalizeWordPage(pages, currentSection, {
					widthPoints: currentSection.widthPoints,
					heightPoints: currentSection.heightPoints,
					blocks: [],
					placeholders: [],
				});
			}
		}
		if (current && (current.widthPoints !== section.widthPoints || current.heightPoints !== section.heightPoints)) {
			finalizeWordPage(pages, currentSection!, current);
			current = undefined;
		}
		currentSection = section;
		current ??= { widthPoints: section.widthPoints, heightPoints: section.heightPoints, blocks: [], placeholders: [] };
		for (const item of section.items) {
			throwIfCancelled(token);
			if (item.kind === 'pageBreak') {
				finalizeWordPage(pages, section, current);
				current = { widthPoints: section.widthPoints, heightPoints: section.heightPoints, blocks: [], placeholders: [] };
			} else {
				current.blocks.push(item.block);
			}
		}
		current.placeholders.push(...section.placeholders);
		current.blocks.push(...section.placeholders.map(placeholder => ({ kind: 'placeholder' as const, nodeId: placeholder.nodeId, placeholder })));
	}
	if (current && currentSection) {
		finalizeWordPage(pages, currentSection, current);
	}
	if (pages.length === 0) {
		throw new ParadisOfficePrintError('invalidModel');
	}
	const model: ParadisOfficePrintModel = {
		title: input.title,
		pages,
		approximationWarnings: [{
			code: 'word.pagination.approximate',
			message: localize('paradis.office.print.wordApproximate', "ページ区切りは、文書に保存された改ページ情報をもとに表示しています。Microsoft Word での自動的なページ分けとは異なる場合があります。"),
		}],
	};
	validatePrintModel(model, token);
	return model;
}

/** Selects one-based inclusive page ordinals after the full model has been generated. */
export function selectParadisOfficePrintPages(
	model: ParadisOfficePrintModel,
	pageRange?: readonly [number, number],
	token: CancellationToken = CancellationToken.None,
): ParadisOfficePrintModel {
	validatePrintModel(model, token);
	if (!pageRange) {
		return model;
	}
	const [from, to] = pageRange;
	if (!isPositiveInteger(from) || !isPositiveInteger(to) || from > to || to > model.pages.length) {
		throw new ParadisOfficePrintError('invalidPageRange');
	}
	return { title: model.title, pages: model.pages.slice(from - 1, to), approximationWarnings: model.approximationWarnings };
}

function stringBytes(value: string): number {
	return VSBuffer.fromString(value).byteLength;
}

const SAFE_PRINT_CSS = /^[^<>{}\\@]*$/;
const SAFE_SVG_DATA_URL = /^data:image\/svg\+xml,[A-Za-z0-9\-_.!~*'()%]+$/;

/** A percent-encoded SVG data URL (what the spreadsheet print layout makes), with nothing that could leave the attribute. */
export function isSafeParadisPrintSvgDataUrl(href: string): boolean {
	return SAFE_SVG_DATA_URL.test(href);
}

/** Inline CSS that may not load anything or escape the declaration (no url(), imports, braces, or escapes). */
export function isSafeParadisPrintCss(css: string): boolean {
	return css.length <= 4096 && SAFE_PRINT_CSS.test(css) && !/url\s*\(|expression\s*\(|image-set|image\s*\(|var\s*\(/i.test(css);
}

function finiteNonNegative(value: number, maximum: number): boolean {
	return Number.isFinite(value) && value >= 0 && value <= maximum;
}

function validateSheetGrid(grid: ParadisOfficePrintSheetGrid, consumeText: (value: string) => void): void {
	if (grid.columns.length > 16_384 || grid.rows.length > 1_048_576 || !grid.columns.every(value => finiteNonNegative(value, 14_400)) || !grid.rows.every(value => finiteNonNegative(value, 14_400))
		|| !(Number.isFinite(grid.scale) && grid.scale > 0 && grid.scale <= 4)
		|| !(grid.titleRows === undefined || (Number.isSafeInteger(grid.titleRows) && grid.titleRows >= 0 && grid.titleRows <= grid.rows.length))
		|| !(grid.titleColumns === undefined || (Number.isSafeInteger(grid.titleColumns) && grid.titleColumns >= 0 && grid.titleColumns <= grid.columns.length))) {
		throw new ParadisOfficePrintError('invalidModel');
	}
	for (const cell of grid.cells) {
		if (!Number.isSafeInteger(cell.row) || !Number.isSafeInteger(cell.column) || cell.row < 0 || cell.column < 0 || cell.row >= grid.rows.length || cell.column >= grid.columns.length
			|| (cell.rowSpan !== undefined && !(Number.isSafeInteger(cell.rowSpan) && cell.rowSpan >= 1 && cell.row + cell.rowSpan <= grid.rows.length))
			|| (cell.columnSpan !== undefined && !(Number.isSafeInteger(cell.columnSpan) && cell.columnSpan >= 1 && cell.column + cell.columnSpan <= grid.columns.length))
			|| (cell.css !== undefined && !isSafeParadisPrintCss(cell.css))) {
			throw new ParadisOfficePrintError('invalidModel');
		}
		for (const run of cell.runs) { consumeText(run.text); }
		consumeText(cell.css ?? '');
	}
	for (const drawing of grid.drawings) {
		if (!SAFE_SVG_DATA_URL.test(drawing.href) || ![drawing.x, drawing.y].every(Number.isFinite) || !finiteNonNegative(drawing.width, 100_000) || !finiteNonNegative(drawing.height, 100_000)) {
			throw new ParadisOfficePrintError('invalidModel');
		}
		consumeText(drawing.nodeId);
		consumeText(drawing.href);
	}
}

function validatePrintModel(model: ParadisOfficePrintModel, token: CancellationToken): void {
	throwIfCancelled(token);
	if (typeof model.title !== 'string' || model.pages.length === 0) {
		throw new ParadisOfficePrintError('invalidModel');
	}
	if (model.pages.length > PARADIS_OFFICE_PRINT_LIMITS.maximumPages) {
		throw new ParadisOfficePrintError('limitExceeded');
	}
	let blocks = 0;
	let textBytes = stringBytes(model.title);
	const consumeText = (value: string): void => {
		textBytes += stringBytes(value);
		if (textBytes > PARADIS_OFFICE_PRINT_LIMITS.maximumTextBytes) {
			throw new ParadisOfficePrintError('limitExceeded');
		}
	};
	const visit = (block: ParadisOfficePrintBlock, depth: number): void => {
		throwIfCancelled(token);
		blocks++;
		if (blocks > PARADIS_OFFICE_PRINT_LIMITS.maximumBlocks || depth > PARADIS_OFFICE_PRINT_LIMITS.maximumBlockDepth) {
			throw new ParadisOfficePrintError('limitExceeded');
		}
		consumeText(block.nodeId);
		switch (block.kind) {
			case 'text':
				for (const run of block.runs) { consumeText(run.text); }
				break;
			case 'container':
				for (const child of block.children) { visit(child, depth + 1); }
				break;
			case 'object':
				consumeText(block.object.altText ?? block.object.kind);
				break;
			case 'placeholder':
				consumeText(block.placeholder.title);
				consumeText(block.placeholder.detail ?? '');
				break;
			case 'sheetGrid':
				validateSheetGrid(block.grid, consumeText);
				break;
		}
	};
	for (const page of model.pages) {
		if (!isPositiveInteger(page.pageNumber) || !Number.isFinite(page.widthPoints) || !Number.isFinite(page.heightPoints)
			|| page.widthPoints <= 0 || page.heightPoints <= 0 || page.widthPoints > 14_400 || page.heightPoints > 14_400) {
			throw new ParadisOfficePrintError('invalidModel');
		}
		for (const block of page.blocks) { visit(block, 1); }
		for (const placeholder of page.placeholders) {
			consumeText(placeholder.nodeId);
			consumeText(placeholder.feature);
			consumeText(placeholder.title);
			consumeText(placeholder.detail ?? '');
		}
	}
	for (const warning of model.approximationWarnings) {
		consumeText(warning.code);
		consumeText(warning.message);
	}
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, character => {
		switch (character) {
			case '&': return '&amp;';
			case '<': return '&lt;';
			case '>': return '&gt;';
			case '"': return '&quot;';
			case '\'': return '&#39;';
			default: return character;
		}
	});
}

function renderTextRuns(runs: readonly ParadisOfficeTextRun[]): string {
	return runs.map(run => `<span>${escapeHtml(run.text)}</span>`).join('');
}

function points(value: number): string {
	return `${Math.round(value * 100) / 100}pt`;
}

/** The page grid as a fixed table (sizes in points) with the drawings placed over it as SVG images. */
function renderSheetGrid(nodeId: string, grid: ParadisOfficePrintSheetGrid): string {
	const width = grid.columns.reduce((sum, value) => sum + value, 0);
	const height = grid.rows.reduce((sum, value) => sum + value, 0);
	const byRow = new Map<number, ParadisOfficePrintGridCell[]>();
	for (const cell of grid.cells) {
		const list = byRow.get(cell.row) ?? [];
		list.push(cell);
		byRow.set(cell.row, list);
	}
	const covered = new Set<string>();
	for (const cell of grid.cells) {
		for (let row = cell.row; row < cell.row + (cell.rowSpan ?? 1); row++) {
			for (let column = cell.column; column < cell.column + (cell.columnSpan ?? 1); column++) {
				if (row !== cell.row || column !== cell.column) {
					covered.add(`${row}:${column}`);
				}
			}
		}
	}
	const rows = grid.rows.map((rowHeight, row) => {
		const cellsByColumn = new Map((byRow.get(row) ?? []).map(cell => [cell.column, cell]));
		let html = `<tr style="height:${points(rowHeight)}">`;
		for (let column = 0; column < grid.columns.length; column++) {
			if (covered.has(`${row}:${column}`)) {
				continue;
			}
			const cell = cellsByColumn.get(column);
			const span = `${cell?.rowSpan ? ` rowspan="${cell.rowSpan}"` : ''}${cell?.columnSpan ? ` colspan="${cell.columnSpan}"` : ''}`;
			const style = cell?.css && isSafeParadisPrintCss(cell.css) ? ` style="${escapeHtml(cell.css)}"` : '';
			html += `<td${span}${style}>${cell ? renderTextRuns(cell.runs) : ''}</td>`;
		}
		return `${html}</tr>`;
	}).join('');
	const columns = grid.columns.map(columnWidth => `<col style="width:${points(columnWidth)}">`).join('');
	// The drawings sit over the page body (after the repeated titles) and are clipped to it, as Excel clips them to the page.
	const bodyLeft = grid.columns.slice(0, grid.titleColumns ?? 0).reduce((sum, value) => sum + value, 0);
	const bodyTop = grid.rows.slice(0, grid.titleRows ?? 0).reduce((sum, value) => sum + value, 0);
	const images = grid.drawings.filter(drawing => SAFE_SVG_DATA_URL.test(drawing.href)).map(drawing =>
		`<img alt="" src="${escapeHtml(drawing.href)}" style="position:absolute;left:${points(drawing.x)};top:${points(drawing.y)};width:${points(drawing.width)};height:${points(drawing.height)}">`).join('');
	const drawings = images ? `<div class="paradis-office-print-drawings" style="left:${points(bodyLeft)};top:${points(bodyTop)};width:${points(width - bodyLeft)};height:${points(height - bodyTop)}">${images}</div>` : '';
	const placement = `${grid.horizontalCentered ? 'margin-left:auto;margin-right:auto;' : ''}${grid.verticalCentered ? 'margin-top:auto;margin-bottom:auto;' : ''}`;
	return `<div class="paradis-office-print-sheet${grid.gridLines ? ' paradis-office-print-gridlines' : ''}" data-node-id="${escapeHtml(nodeId)}" style="position:relative;width:${points(width)};height:${points(height)};zoom:${Math.round(grid.scale * 1000) / 1000};${placement}"><table style="width:${points(width)}"><colgroup>${columns}</colgroup>${rows}</table>${drawings}</div>`;
}

function renderPrintBlock(block: ParadisOfficePrintBlock): string {
	const nodeId = escapeHtml(block.nodeId);
	switch (block.kind) {
		case 'text': return `<p data-node-id="${nodeId}">${renderTextRuns(block.runs)}</p>`;
		case 'container': {
			const tag = block.role === 'table' ? 'table' : block.role === 'row' ? 'tr' : block.role === 'cell' ? 'td' : block.role === 'list' ? 'ul' : 'section';
			return `<${tag} data-node-id="${nodeId}" data-print-role="${escapeHtml(block.role)}">${block.children.map(renderPrintBlock).join('')}</${tag}>`;
		}
		case 'object': {
			const label = block.object.altText ?? localize('paradis.office.print.object', "文書オブジェクト: {0}", block.object.kind);
			return `<figure data-node-id="${nodeId}" data-object-kind="${escapeHtml(block.object.kind)}" data-render-coverage="${escapeHtml(block.object.coverage)}"><figcaption>${escapeHtml(label)}</figcaption></figure>`;
		}
		case 'sheetGrid': return renderSheetGrid(block.nodeId, block.grid);
		case 'placeholder': {
			const detail = block.placeholder.detail ? `<span>${escapeHtml(block.placeholder.detail)}</span>` : '';
			return `<aside class="paradis-office-print-placeholder" data-node-id="${nodeId}" data-placeholder-reason="${escapeHtml(block.placeholder.reason)}"><strong>${escapeHtml(block.placeholder.title)}</strong><span>${escapeHtml(block.placeholder.feature)} — ${escapeHtml(block.placeholder.reason)}</span>${detail}</aside>`;
		}
	}
}

/** Serializes only typed print blocks into a CSP-locked, script-free print document. */
export function renderParadisOfficePrintHtml(
	model: ParadisOfficePrintModel,
	options: { readonly pageRange?: readonly [number, number] } = {},
	token: CancellationToken = CancellationToken.None,
): ParadisOfficePrintHtmlArtifact {
	const selected = selectParadisOfficePrintPages(model, options.pageRange, token);
	const warnings = selected.approximationWarnings.length > 0
		? `<aside class="paradis-office-print-warnings" role="note">${selected.approximationWarnings.map(warning => `<p data-warning-code="${escapeHtml(warning.code)}">${escapeHtml(warning.message)}</p>`).join('')}</aside>`
		: '';
	const pages = selected.pages.map(page => {
		throwIfCancelled(token);
		const margins = page.marginsPoints ? `;padding:${page.marginsPoints.map(points).join(' ')}` : '';
		return `<article class="paradis-office-print-page" data-page-number="${page.pageNumber}" style="--office-page-width:${page.widthPoints}pt;--office-page-height:${page.heightPoints}pt${margins}">${page.blocks.map(renderPrintBlock).join('')}</article>`;
	}).join('');
	const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${escapeHtml(selected.title)}</title><style>
@page { margin: 0; }
html,body { margin: 0; padding: 0; color: #000; background: #fff; font: 11pt sans-serif; }
.paradis-office-print-warnings { margin: 12pt; padding: 8pt; border: 1pt solid currentColor; }
.paradis-office-print-page { box-sizing: border-box; width: var(--office-page-width); min-height: var(--office-page-height); padding: 24pt; break-after: page; overflow: hidden; }
.paradis-office-print-page:last-child { break-after: auto; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
td { border: .5pt solid currentColor; padding: 2pt; overflow-wrap: anywhere; vertical-align: top; }
p { margin: 0 0 4pt; white-space: pre-wrap; overflow-wrap: anywhere; }
.paradis-office-print-sheet { box-sizing: content-box; }
.paradis-office-print-sheet table { width: auto; border-collapse: collapse; table-layout: fixed; }
.paradis-office-print-sheet td { border: none; padding: 0 2pt; overflow: hidden; white-space: nowrap; vertical-align: bottom; font: 11pt sans-serif; }
.paradis-office-print-sheet.paradis-office-print-gridlines td { outline: .5pt solid #c0c0c0; }
.paradis-office-print-drawings { position: absolute; overflow: hidden; }
.paradis-office-print-sheet img { pointer-events: none; }
.paradis-office-print-placeholder, figure { display: grid; gap: 2pt; margin: 6pt 0; padding: 6pt; border: 1pt dashed currentColor; break-inside: avoid; }
@media print { .paradis-office-print-warnings { break-after: avoid; } }
</style></head><body>${warnings}${pages}</body></html>`;
	const byteLength = stringBytes(html);
	if (byteLength > PARADIS_OFFICE_PRINT_LIMITS.maximumHtmlBytes) {
		throw new ParadisOfficePrintError('limitExceeded');
	}
	throwIfCancelled(token);
	return { html, byteLength, model: selected };
}
