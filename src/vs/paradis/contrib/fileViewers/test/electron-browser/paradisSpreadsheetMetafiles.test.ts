/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IParadisSheetData, IParadisWorkbookData } from '../../common/paradisSpreadsheet.js';
import { applySpreadsheetMetafiles, hasPendingSpreadsheetMetafiles } from '../../electron-browser/paradisSpreadsheetClient.js';
import { parseDrawingObjects } from '../../electron-browser/paradisSpreadsheetDrawings.js';

const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Invented drawing with one picture that points at `rid`. */
function pictureDrawing(rid: string): string {
	return `<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}" xmlns:r="${R}"><xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`
		+ `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="1" name="Picture 1"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${rid}"/></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;
}

function sheet(name: string): IParadisSheetData {
	return { name, rows: [], columnCount: 1, columnWidths: [80], truncated: false, minCol: 1 };
}

suite('ParadisSpreadsheetMetafiles', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('swaps converted EMF pictures in, redraws only the sheets that changed, and keeps the rest as boxes', () => {
		const drawingsBySheet = {
			1: [{ xml: pictureDrawing('rIdEmf'), media: {}, rejectedMedia: { rIdEmf: 'metafile' as const }, metafileMedia: { rIdEmf: 'image1.emf' } }],
			2: [{ xml: pictureDrawing('rIdOther'), media: {}, rejectedMedia: { rIdOther: 'metafile' as const }, metafileMedia: { rIdOther: 'image2.emf' } }],
		};
		const withUndrawn = (base: IParadisSheetData, index: 1 | 2) => ({ ...base, undrawnObjects: parseDrawingObjects(drawingsBySheet[index]).undrawn });
		const workbook: IParadisWorkbookData = { sheets: [withUndrawn(sheet('One'), 1), withUndrawn(sheet('Two'), 2)], drawingsBySheet };
		const svg = 'data:image/svg+xml;base64,PHN2Zy8+';
		const updated = applySpreadsheetMetafiles(workbook, { images: { 'image1.emf': svg, 'image2.emf': 'javascript:alert(1)' } });
		deepStrictEqual({
			pendingBefore: hasPendingSpreadsheetMetafiles(workbook),
			pendingAfter: hasPendingSpreadsheetMetafiles(updated),
			first: [updated.sheets[0].shapes?.map(shape => shape.href), updated.sheets[0].undrawnObjects],
			secondKept: updated.sheets[1] === workbook.sheets[1],
		}, {
			pendingBefore: true,
			pendingAfter: false,
			first: [[svg], undefined],
			secondKept: true,
		});
	});
});
