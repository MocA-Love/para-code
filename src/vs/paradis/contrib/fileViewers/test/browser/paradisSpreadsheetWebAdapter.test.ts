/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, strictEqual } from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createParadisOfficeWebArchive } from '../../browser/office/paradisOfficeWebArchive.js';
import { parseSpreadsheetSemanticWeb } from '../../browser/spreadsheet/paradisSpreadsheetWebAdapter.js';
import { PARADIS_OFFICE_BUDGET_PROFILES, type ParadisOfficeInventory } from '../../common/paradisOfficeProtocol.js';
import { inspectOfficePackage } from '../../common/office/paradisOfficePackageCore.js';
import type { IParadisWorkbookData } from '../../common/paradisSpreadsheet.js';
import { buildOpcFixture } from '../common/paradisOfficeFixture.js';

const spreadsheetNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

suite('ParadisSpreadsheetWebAdapter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('owns inventory and projection deeply before opening its archive', async () => {
		const bytes = await spreadsheetFixture();
		const inventory = await inspectOfficePackage(
			await createParadisOfficeWebArchive(bytes),
			PARADIS_OFFICE_BUDGET_PROFILES.browser,
			CancellationToken.None,
		);
		const mutableInventory: ParadisOfficeInventory = {
			...inventory,
			relationships: inventory.relationships.map(relationship => ({ ...relationship })),
		};
		const projectedCell = { value: '1', style: {} };
		const projection: IParadisWorkbookData = {
			sheets: [{
				name: 'Sheet1', minCol: 1, columnCount: 1, columnWidths: [64], truncated: false,
				rows: [{ excelRow: 1, height: 20, cells: [projectedCell] }],
			}],
		};

		const parsing = parseSpreadsheetSemanticWeb(bytes, mutableInventory, CancellationToken.None, { projection });
		Object.defineProperty(mutableInventory, 'relationships', {
			configurable: true,
			value: mutableInventory.relationships.map(relationship => relationship.id === 'rIdSheet1'
				? { ...relationship, target: '/xl/worksheets/missing.xml' }
				: relationship),
		});
		Object.defineProperty(projectedCell, 'value', { configurable: true, value: 'mutated-after-call' });

		const snapshot = await parsing;
		deepStrictEqual(snapshot.sheets[0].cells.get('A1')?.rawValue, { present: true, text: '1' });
		strictEqual(snapshot.projectionDiagnostics.some(diagnostic => diagnostic.kind === 'valueMismatch' && diagnostic.cellAddress === 'A1'), false);
	});
});

async function spreadsheetFixture(): Promise<Uint8Array> {
	return buildOpcFixture({
		parts: [
			['/xl/workbook.xml', `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${relationshipNamespace}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rIdSheet1"/></sheets></workbook>`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
			['/xl/worksheets/sheet1.xml', `<worksheet xmlns="${spreadsheetNamespace}"><dimension ref="A1:A1"/><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'],
		],
		relationships: [
			{ id: 'rIdRoot', type: `${relationshipNamespace}/officeDocument`, target: 'xl/workbook.xml' },
			{ source: '/xl/workbook.xml', id: 'rIdSheet1', type: `${relationshipNamespace}/worksheet`, target: 'worksheets/sheet1.xml' },
		],
	});
}
