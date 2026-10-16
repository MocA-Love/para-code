/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, rejects, strictEqual } from 'assert';
import { readFileSync } from 'fs';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { FileAccess } from '../../../../../base/common/network.js';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisSpreadsheetService } from '../../node/paradisSpreadsheetService.js';
import { PARADIS_EXCELJS_MERGE_FAST_PATH_VERSION, installParadisExcelJsMergeFastPath, paradisExcelJsMergeRanges, withOriginalExcelJsMergesForTest } from '../../node/spreadsheet/paradisSpreadsheetExcelJsMerges.js';

/** Invented form-like sheet: many small merged blocks, a few wide ones, and styled cells inside them. */
async function mergedWorkbook(): Promise<Buffer> {
	const workbook = new ExcelJS.Workbook();
	const sheet = workbook.addWorksheet('Form');
	for (let block = 0; block < 300; block++) {
		const row = 1 + Math.floor(block / 10) * 2;
		const column = 1 + (block % 10) * 3;
		sheet.getCell(row, column).value = `v${block}`;
		sheet.getCell(row + 1, column + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
		sheet.mergeCells(row, column, row + 1, column + 2);
	}
	sheet.mergeCells('A70:AD72');
	workbook.addWorksheet('Plain').getCell('B2').value = 1;
	return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** The same workbook with one more merge that overlaps an existing one, the way a damaged file can store it. */
async function overlappingWorkbook(): Promise<Buffer> {
	const zip = await JSZip.loadAsync(await mergedWorkbook());
	const name = 'xl/worksheets/sheet1.xml';
	const xml = await zip.file(name)!.async('text');
	zip.file(name, xml.replace(/<mergeCells count="(?<count>\d+)">/, (_, count: string) => `<mergeCells count="${Number(count) + 1}"><mergeCell ref="B2:C3"/>`));
	return Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
}

async function loadModels(bytes: Buffer): Promise<unknown> {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
	return workbook.worksheets.map(sheet => ({
		model: sheet.model,
		merges: paradisExcelJsMergeRanges(sheet),
		cells: [1, 2, 3].flatMap(row => [1, 2, 3, 4].map(column => {
			const cell = sheet.getCell(row, column);
			return [cell.address, cell.isMerged, cell.master.address, cell.type];
		})),
	}));
}

suite('paradisSpreadsheetExcelJsMerges', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('is written against the bundled exceljs version', () => {
		const manifest = JSON.parse(readFileSync(join(FileAccess.asFileUri('').fsPath, '..', 'node_modules', 'exceljs', 'package.json'), 'utf8')) as { version: string };
		// The fast path relies on exceljs internals. When exceljs moves, re-check `_parseMergeCells` and `_merges`.
		strictEqual(manifest.version, PARADIS_EXCELJS_MERGE_FAST_PATH_VERSION);
		strictEqual(installParadisExcelJsMergeFastPath(ExcelJS), true);
		strictEqual(installParadisExcelJsMergeFastPath(ExcelJS), true);
	});

	test('loads the same worksheets as exceljs does without the fast path', async () => {
		installParadisExcelJsMergeFastPath(ExcelJS);
		const bytes = await mergedWorkbook();
		const original = await withOriginalExcelJsMergesForTest(ExcelJS, () => loadModels(bytes));
		const fast = await loadModels(bytes);
		deepStrictEqual(fast, original);
	});

	test('does not compare each merge with every earlier merge while loading', async () => {
		installParadisExcelJsMergeFastPath(ExcelJS);
		const bytes = await mergedWorkbook();
		const probe = new ExcelJS.Workbook().addWorksheet('probe');
		probe.mergeCells('A1:B2');
		const rangePrototype = Object.getPrototypeOf((probe as unknown as { _merges: Record<string, object> })._merges.A1) as { intersects(other: unknown): boolean };
		const intersects = rangePrototype.intersects;
		let comparisons = 0;
		rangePrototype.intersects = function (this: unknown, other: unknown) {
			comparisons++;
			return intersects.call(this, other);
		};
		try {
			const workbook = new ExcelJS.Workbook();
			await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
		} finally {
			rangePrototype.intersects = intersects;
		}
		// Without the fast path, exceljs compares the 301 merges pairwise (45,150 calls).
		strictEqual(comparisons, 0);
	});

	test('reads the merge list in the order of worksheet.model.merges', async () => {
		installParadisExcelJsMergeFastPath(ExcelJS);
		const workbook = new ExcelJS.Workbook();
		await workbook.xlsx.load(await mergedWorkbook() as unknown as Parameters<typeof workbook.xlsx.load>[0]);
		const sheet = workbook.getWorksheet('Form')!;
		deepStrictEqual(paradisExcelJsMergeRanges(sheet), (sheet.model as { merges: string[] }).merges);
		strictEqual(paradisExcelJsMergeRanges(sheet).length, 301);
	});

	test('still refuses a workbook whose merges overlap, with the exceljs error', async () => {
		installParadisExcelJsMergeFastPath(ExcelJS);
		const bytes = await overlappingWorkbook();
		const load = async () => {
			const workbook = new ExcelJS.Workbook();
			await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
		};
		await withOriginalExcelJsMergesForTest(ExcelJS, () => rejects(load, /Cannot merge already merged cells/));
		await rejects(load, /Cannot merge already merged cells/);
	});

	test('keeps the parsed workbook the same', async () => {
		const service = new ParadisSpreadsheetService();
		const base64 = (await mergedWorkbook()).toString('base64');
		const fast = await service.parseWorkbook(base64);
		const original = await withOriginalExcelJsMergesForTest(ExcelJS, () => service.parseWorkbook(base64));
		deepStrictEqual(fast, original);
		deepStrictEqual(fast.sheets[0].rows[0].cells.slice(0, 4).map(cell => [cell.value, cell.colSpan, cell.rowSpan, cell.hidden]), [['v0', 3, 2, undefined], ['', undefined, undefined, true], ['', undefined, undefined, true], ['v1', 3, 2, undefined]]);
	});
});
