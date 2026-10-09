/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel の印刷プレビューで、ページをシートと同じ寸法・書式で組むための材料を作る。セルの書式はビューアと同じ
// 関数（applyBaseCellStyle）で決め、図形・画像・グラフ・セルの斜線は、ビューアと同じ描き方の SVG を 1 つずつ
// 画像（data URL）にする。画像は、ビューアが使っている data URL をそのまま SVG の中で使う。

import type { IParadisSheetData } from '../common/paradisSpreadsheet.js';
import { isSafeParadisPrintCss, PARADIS_OFFICE_PRINT_DRAWING_BYTES, type ParadisOfficeSpreadsheetPrintLayout } from '../common/paradisOfficePrint.js';
import type { ParadisOfficePrintGridDrawing } from '../common/paradisOfficeProtocol.js';
import { PARADIS_ROW_NUM_COL_WIDTH, applyBaseCellStyle, buildShapeOverlay, computeShapeBBox } from './paradisSpreadsheetRender.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** 画面の px → 印刷の pt。 */
const PX_TO_PT = 0.75;

/** ブック全体で作る SVG の残りのバイト数。最初は印刷のモデルの上限（PARADIS_OFFICE_PRINT_DRAWING_BYTES）と同じ。 */
export interface IParadisSpreadsheetPrintDrawingBudget {
	remaining: number;
}

export function createParadisSpreadsheetPrintDrawingBudget(): IParadisSpreadsheetPrintDrawingBudget {
	return { remaining: PARADIS_OFFICE_PRINT_DRAWING_BYTES };
}

export interface IParadisSpreadsheetPrintLayout {
	readonly layout: ParadisOfficeSpreadsheetPrintLayout;
	/** `行:列`（Excel の 1 始まり）→ セルの CSS。 */
	readonly cellCss: ReadonlyMap<string, string>;
	/** 上限を越えて描かなかった図形の数。 */
	readonly omittedDrawings: number;
}

/** SVG を data URL にする。中の画像は base64 の data URL なので、base64 を重ねずに URL エンコードで包む。 */
function svgDataUrl(svg: Element): string {
	return `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
}

/**
 * シート 1 枚の印刷の材料。`doc` は SVG と書式を組み立てるための文書（画面には足さない）。`budget` はブック全体で
 * 共有し、使い切ったら残りの図形は作らない（`omittedDrawings` に数える）。
 */
export function paradisSpreadsheetPrintLayout(sheet: IParadisSheetData, doc: Document, budget: IParadisSpreadsheetPrintDrawingBudget): IParadisSpreadsheetPrintLayout {
	const minRow = sheet.rows[0]?.excelRow ?? 1;
	const maxRow = sheet.rows[sheet.rows.length - 1]?.excelRow ?? minRow;
	const heightByRow = new Map(sheet.rows.map(row => [row.excelRow, row.height]));
	const rowHeightsPx: number[] = [];
	const rowY = new Map<number, number>();
	let y = 0;
	for (let row = minRow; row <= maxRow; row++) {
		rowY.set(row, y);
		const height = heightByRow.get(row) ?? 0;
		rowHeightsPx.push(height);
		y += height;
	}
	rowY.set(maxRow + 1, y);

	// セルの書式。ビューアと同じ関数で td に当て、その CSS を読む。危ない値を含むものは落とす。
	const cellCss = new Map<string, string>();
	const probe = doc.createElement('td');
	for (const row of sheet.rows) {
		row.cells.forEach((cell, index) => {
			if (cell.hidden) {
				return;
			}
			probe.removeAttribute('style');
			applyBaseCellStyle(probe, cell);
			const css = probe.style.cssText;
			if (css && isSafeParadisPrintCss(css)) {
				cellCss.set(`${row.excelRow}:${sheet.minCol + index}`, css);
			}
		});
	}

	// 図形・画像・グラフ。ビューアの重ね合わせと同じ関数で図形を 1 つずつ SVG にして画像にする。
	const drawings: ParadisOfficePrintGridDrawing[] = [];
	let omittedDrawings = 0;
	(sheet.shapes ?? []).forEach((shape, index) => {
		if (budget.remaining <= 0) {
			omittedDrawings++;
			return;
		}
		const overlay = buildShapeOverlay([shape], rowY, sheet.columnWidths, sheet.minCol, doc);
		if (!overlay?.firstChild) {
			return;
		}
		const box = computeShapeBBox(shape, rowY, sheet.columnWidths, sheet.minCol);
		// 線の太さ・矢印・回転ではみ出す分を見込んで、外側に余白を取る。
		const pad = Math.max(4, shape.outlineWidth * 4) + (shape.rotation ? Math.max(box.w, box.h) / 2 : 0);
		const left = box.x - pad;
		const top = box.y - pad;
		const width = box.w + pad * 2;
		const height = box.h + pad * 2;
		const svg = doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('xmlns', SVG_NS);
		svg.setAttribute('viewBox', `${left} ${top} ${width} ${height}`);
		svg.setAttribute('width', String(width));
		svg.setAttribute('height', String(height));
		svg.append(...Array.from(overlay.childNodes));
		const href = svgDataUrl(svg);
		if (href.length > budget.remaining) {
			omittedDrawings++;
			return;
		}
		budget.remaining -= href.length;
		drawings.push({
			nodeId: `drawing:${index}`,
			x: (left - PARADIS_ROW_NUM_COL_WIDTH) * PX_TO_PT,
			y: top * PX_TO_PT,
			width: width * PX_TO_PT,
			height: height * PX_TO_PT,
			href,
		});
	});

	// セルの斜線。セルの位置に線だけの SVG を置く。
	const columnLeft: number[] = [0];
	for (const width of sheet.columnWidths) {
		columnLeft.push(columnLeft[columnLeft.length - 1] + width);
	}
	for (const row of sheet.rows) {
		row.cells.forEach((cell, index) => {
			if (!cell.diagonal || cell.hidden) {
				return;
			}
			const x = columnLeft[index];
			const top = rowY.get(row.excelRow) ?? 0;
			let width = 0;
			for (let span = 0; span < (cell.colSpan ?? 1); span++) {
				width += sheet.columnWidths[index + span] ?? 0;
			}
			let height = 0;
			for (let span = 0; span < (cell.rowSpan ?? 1); span++) {
				height += heightByRow.get(row.excelRow + span) ?? 0;
			}
			if (width <= 0 || height <= 0) {
				return;
			}
			const svg = doc.createElementNS(SVG_NS, 'svg');
			svg.setAttribute('xmlns', SVG_NS);
			svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
			svg.setAttribute('width', String(width));
			svg.setAttribute('height', String(height));
			const strokeWidth = /^(?<width>\d+(?:\.\d+)?)px/.exec(cell.diagonal.style)?.groups?.width ?? '1';
			const line = (x1: number, y1: number, x2: number, y2: number) => {
				const element = doc.createElementNS(SVG_NS, 'line');
				element.setAttribute('x1', String(x1));
				element.setAttribute('y1', String(y1));
				element.setAttribute('x2', String(x2));
				element.setAttribute('y2', String(y2));
				element.setAttribute('stroke', /^#[0-9a-fA-F]{3,8}$/.test(cell.diagonal!.color) ? cell.diagonal!.color : '#000000');
				element.setAttribute('stroke-width', strokeWidth);
				svg.appendChild(element);
			};
			if (cell.diagonal.down) {
				line(0, 0, width, height);
			}
			if (cell.diagonal.up) {
				line(0, height, width, 0);
			}
			const href = svgDataUrl(svg);
			if (href.length > budget.remaining) {
				omittedDrawings++;
				return;
			}
			budget.remaining -= href.length;
			drawings.push({ nodeId: `diagonal:${row.excelRow}:${index}`, x: x * PX_TO_PT, y: top * PX_TO_PT, width: width * PX_TO_PT, height: height * PX_TO_PT, href });
		});
	}

	const setup = sheet.pageSetup;
	const scale = sheet.pageLayout?.effectiveScale ?? setup?.scale ?? 1;
	return {
		layout: {
			minRow,
			minColumn: sheet.minCol,
			rowHeights: rowHeightsPx.map(height => height * PX_TO_PT),
			columnWidths: sheet.columnWidths.map(width => width * PX_TO_PT),
			drawings,
			gridLines: !!setup?.printGridLines,
			scale: Math.min(4, Math.max(0.1, scale)),
			marginsPoints: setup ? [setup.marginTop, setup.marginRight, setup.marginBottom, setup.marginLeft] : [54, 50.4, 54, 50.4],
			...(setup?.horizontalCentered ? { horizontalCentered: true } : {}),
			...(setup?.verticalCentered ? { verticalCentered: true } : {}),
		},
		cellCss,
		omittedDrawings,
	};
}
