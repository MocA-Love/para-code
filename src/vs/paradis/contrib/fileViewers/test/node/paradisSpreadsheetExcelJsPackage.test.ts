/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { planExcelJsPackageLayout } from '../../node/spreadsheet/paradisSpreadsheetExcelJsPackage.js';

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const relationships = (...items: string[]) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`;

suite('planExcelJsPackageLayout', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('leaves a workbook in the exceljs layout alone', () => {
		strictEqual(planExcelJsPackageLayout({
			names: ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml', 'xl/worksheets/_rels/sheet1.xml.rels', 'xl/comments1.xml', 'xl/drawings/vmlDrawing1.vml'],
			relationships: new Map([
				['_rels/.rels', relationships(`<Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/>`)],
				['xl/_rels/workbook.xml.rels', relationships(`<Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/>`)],
				['xl/worksheets/_rels/sheet1.xml.rels', relationships(
					`<Relationship Id="rId1" Type="${R}/comments" Target="../comments1.xml"/>`,
					`<Relationship Id="rId2" Type="${R}/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/>`,
					`<Relationship Id="rId3" Type="${R}/hyperlink" Target="/elsewhere" TargetMode="External"/>`,
				)],
			]),
		}), undefined);
	});

	test('moves comments and VML, and follows the moves in Targets, relationships and content types', () => {
		const plan = planExcelJsPackageLayout({
			names: [
				'[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels',
				'xl/worksheets/sheet1.xml', 'xl/worksheets/_rels/sheet1.xml.rels',
				'xl/comments/comment1.xml', 'xl/notes/vml/shapes.vml', 'xl/notes/vml/_rels/shapes.vml.rels', 'xl/media/a$&b.png',
			],
			relationships: new Map([
				['_rels/.rels', relationships(`<Relationship Id="rId1" Type="${R}/officeDocument" Target="/xl/workbook.xml"/>`)],
				['xl/_rels/workbook.xml.rels', relationships(`<Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/>`)],
				['xl/worksheets/_rels/sheet1.xml.rels', relationships(
					`<Relationship Id="rId1" Type="${R}/comments" Target="/xl/comments/comment1.xml"/>`,
					`<Relationship Id="rId2" Type="${R}/vmlDrawing" Target="../notes/vml/shapes.vml"/>`,
				)],
				// The VML's own relationship is relative to where the VML was.
				['xl/notes/vml/_rels/shapes.vml.rels', relationships(`<Relationship Id="rId1" Type="${R}/image" Target="../../media/a$&amp;b.png"/>`)],
			]),
			contentTypes: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/><Override PartName="/xl/Comments/Comment1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/></Types>',
		});

		deepStrictEqual({ moves: [...plan!.moves], texts: [...plan!.texts] }, {
			moves: [
				['xl/comments/comment1.xml', 'xl/comments1.xml'],
				['xl/notes/vml/shapes.vml', 'xl/drawings/vmlDrawing1.vml'],
				['xl/notes/vml/_rels/shapes.vml.rels', 'xl/drawings/_rels/vmlDrawing1.vml.rels'],
			],
			texts: [
				['_rels/.rels', relationships(`<Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/>`)],
				['xl/drawings/_rels/vmlDrawing1.vml.rels', relationships(`<Relationship Id="rId1" Type="${R}/image" Target="../media/a$&amp;b.png"/>`)],
				['xl/worksheets/_rels/sheet1.xml.rels', relationships(
					`<Relationship Id="rId1" Type="${R}/comments" Target="../comments1.xml"/>`,
					`<Relationship Id="rId2" Type="${R}/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/>`,
				)],
				['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/><Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/></Types>'],
			],
		});
	});
});
