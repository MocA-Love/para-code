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
}

export interface ParadisOfficeSpreadsheetPrintInput {
	readonly title: string;
	readonly sheets: readonly ParadisOfficeSpreadsheetPrintSheet[];
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
		case 'topLeftToBottomRight': return localize('paradis.office.print.line.down', "top-left to bottom-right");
		case 'topRightToBottomLeft': return localize('paradis.office.print.line.up', "top-right to bottom-left");
		case 'both': return localize('paradis.office.print.line.both', "both diagonals");
	}
}

/** Converts line semantics to a stable label instead of replaying viewer pixel geometry or transforms. */
export function createParadisOfficeLineLabelBlock(line: ParadisOfficePrintLinePrimitive): ParadisOfficePrintBlock {
	let text: string;
	switch (line.kind) {
		case 'cellDiagonal':
			text = localize('paradis.office.print.cellDiagonal', "Diagonal border: {0}", lineDirectionLabel(line.direction));
			break;
		case 'tableDiagonal':
			text = localize('paradis.office.print.tableDiagonal', "Table diagonal border: {0}", lineDirectionLabel(line.direction));
			break;
		case 'drawingLine':
			text = line.label
				? localize('paradis.office.print.drawingLineNamed', "Drawing line: {0}", line.label)
				: localize('paradis.office.print.drawingLine', "Drawing line");
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
			const blocks: ParadisOfficePrintBlock[] = [
				...(header ? [header] : []),
				tableBlock(sheet, cells, `page:${pageIndex}`),
				...placeholders.map(placeholder => ({ kind: 'placeholder' as const, nodeId: placeholder.nodeId, placeholder })),
				...(footer ? [footer] : []),
			];
			pages.push({ pageNumber: pages.length + 1, widthPoints, heightPoints, blocks, placeholders });
		}
	}
	if (pages.length === 0) {
		throw new ParadisOfficePrintError('invalidModel');
	}
	const approximationWarnings = approximated ? [{
		code: 'spreadsheet.pagination.approximate',
		message: localize('paradis.office.print.spreadsheetApproximate', "Spreadsheet pagination is approximate because no saved page rectangles were available."),
	}] : [];
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
			message: localize('paradis.office.print.wordApproximate', "Word pagination uses saved and explicit breaks; automatic pagination may differ from Microsoft Word."),
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

function renderPrintBlock(block: ParadisOfficePrintBlock): string {
	const nodeId = escapeHtml(block.nodeId);
	switch (block.kind) {
		case 'text': return `<p data-node-id="${nodeId}">${renderTextRuns(block.runs)}</p>`;
		case 'container': {
			const tag = block.role === 'table' ? 'table' : block.role === 'row' ? 'tr' : block.role === 'cell' ? 'td' : block.role === 'list' ? 'ul' : 'section';
			return `<${tag} data-node-id="${nodeId}" data-print-role="${escapeHtml(block.role)}">${block.children.map(renderPrintBlock).join('')}</${tag}>`;
		}
		case 'object': {
			const label = block.object.altText ?? localize('paradis.office.print.object', "Document object: {0}", block.object.kind);
			return `<figure data-node-id="${nodeId}" data-object-kind="${escapeHtml(block.object.kind)}" data-render-coverage="${escapeHtml(block.object.coverage)}"><figcaption>${escapeHtml(label)}</figcaption></figure>`;
		}
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
		return `<article class="paradis-office-print-page" data-page-number="${page.pageNumber}" style="--office-page-width:${page.widthPoints}pt;--office-page-height:${page.heightPoints}pt">${page.blocks.map(renderPrintBlock).join('')}</article>`;
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
