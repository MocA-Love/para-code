/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisDrawingRightmostColumn } from '../../common/spreadsheet/paradisSpreadsheetDrawingExtent.js';

const EMU = 9525;
const NAMESPACES = 'xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';

/** A shape (`sp`) at `x`,`y` of `width` x `height` px; `callout` makes it a callout whose tail points left (right when flipped). */
function shape(width: number, height: number, options: { readonly callout?: boolean; readonly flipH?: boolean; readonly rotation?: number; readonly x?: number } = {}): string {
	const flip = options.flipH ? ' flipH="1"' : '';
	const rotation = options.rotation ? ` rot="${options.rotation * 60000}"` : '';
	const geometry = options.callout
		? '<a:prstGeom prst="wedgeRoundRectCallout"><a:avLst><a:gd name="adj1" fmla="val -62000"/><a:gd name="adj2" fmla="val 12000"/><a:gd name="adj3" fmla="val 16667"/></a:avLst></a:prstGeom>'
		: '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
	return `<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="2" name="Shape"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:xfrm${flip}${rotation}><a:off x="${(options.x ?? 0) * EMU}" y="0"/><a:ext cx="${width * EMU}" cy="${height * EMU}"/></a:xfrm>${geometry}</xdr:spPr></xdr:sp>`;
}

function oneCell(column: number, width: number, height: number, content: string): string {
	return `<xdr:oneCellAnchor><xdr:from><xdr:col>${column}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="${width * EMU}" cy="${height * EMU}"/>${content}<xdr:clientData/></xdr:oneCellAnchor>`;
}

function drawing(...anchors: string[]): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr ${NAMESPACES}>${anchors.join('')}</xdr:wsDr>`;
}

suite('ParadisSpreadsheetDrawingExtent', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('finds the column holding the right edge of each kind of anchor, tail, flip, rotation, wrapper, and group', () => {
		// Every column is 100px wide and every row 20px, so the right edge x falls in column ceil(x / 100).
		const metrics = { columnWidth: () => 100, rowHeight: () => 20 };
		const column = (...anchors: string[]) => paradisDrawingRightmostColumn([drawing(...anchors)], metrics, 50);
		deepStrictEqual({
			// From 200px: a 150px rectangle ends at 350px.
			oneCell: column(oneCell(2, 150, 40, shape(150, 40))),
			// A 190px callout ends at 390px with its tail to the left; flipped, the tail (12% of the width) reaches 412.8px.
			calloutTailLeft: column(oneCell(2, 190, 40, shape(190, 40, { callout: true }))),
			calloutTailRight: column(oneCell(2, 190, 40, shape(190, 40, { callout: true, flipH: true }))),
			// A 40 x 190 rectangle ends at 240px; turned 90 degrees around its center (220px) it spans 125..315px.
			upright: column(oneCell(2, 40, 190, shape(40, 190))),
			rotated: column(oneCell(2, 40, 190, shape(40, 190, { rotation: 90 }))),
			// 450px + 100px.
			absolute: column(`<xdr:absoluteAnchor><xdr:pos x="${450 * EMU}" y="0"/><xdr:ext cx="${100 * EMU}" cy="${40 * EMU}"/>${shape(100, 40)}<xdr:clientData/></xdr:absoluteAnchor>`),
			// To column 6 (600px) + 50px.
			twoCell: column(`<xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>6</xdr:col><xdr:colOff>${50 * EMU}</xdr:colOff><xdr:row>3</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>${shape(550, 60)}<xdr:clientData/></xdr:twoCellAnchor>`),
			// The flipped callout again, wrapped in mc:AlternateContent.
			wrapped: column(oneCell(2, 190, 40, `<mc:AlternateContent><mc:Choice Requires="a14">${shape(190, 40, { callout: true, flipH: true })}</mc:Choice><mc:Fallback/></mc:AlternateContent>`)),
			// A 400px group whose child space is 800px wide: the flipped callout at child x 420 (210px) and 380 wide (190px) ends at 400px, its tail at 422.8px.
			group: column(oneCell(0, 400, 40, `<xdr:grpSp><xdr:nvGrpSpPr><xdr:cNvPr id="3" name="Group"/><xdr:cNvGrpSpPr/></xdr:nvGrpSpPr><xdr:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${400 * EMU}" cy="${40 * EMU}"/><a:chOff x="0" y="0"/><a:chExt cx="${800 * EMU}" cy="${80 * EMU}"/></a:xfrm></xdr:grpSpPr>${shape(380, 80, { callout: true, flipH: true, x: 420 })}</xdr:grpSp>`)),
			// Beyond the limit, and nothing to measure.
			farAway: column(oneCell(500, 100, 40, shape(100, 40))),
			none: paradisDrawingRightmostColumn([drawing(), ''], metrics, 50),
		}, {
			oneCell: 4,
			calloutTailLeft: 4,
			calloutTailRight: 5,
			upright: 3,
			rotated: 4,
			absolute: 6,
			twoCell: 7,
			wrapped: 5,
			group: 5,
			farAway: 50,
			none: undefined,
		});
	});
});
