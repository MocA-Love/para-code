/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'assert';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ParadisOfficeXmlNode } from '../../common/office/paradisOfficeArchive.js';
import { parseParadisOfficeXml } from '../../common/office/paradisOfficeCanonicalXml.js';
import { unpackParadisWorkbookStyles } from '../../common/spreadsheet/paradisSpreadsheetStyleTable.js';
import { ParadisSpreadsheetService } from '../../node/paradisSpreadsheetService.js';
import { ParadisSpreadsheetParseWorkerBackend } from '../../node/spreadsheet/paradisSpreadsheetParseWorkerBackend.js';
import { rootBindsSpreadsheetMlPrefix, unprefixSpreadsheetMlXml, unprefixWorkbookSpreadsheetMl } from '../../node/spreadsheet/paradisSpreadsheetPrefixedXml.js';
import { collectParadisSpreadsheetSemanticDiagnostics } from '../../node/spreadsheet/paradisSpreadsheetSemanticDiagnostics.js';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const WORKER_PATH = FileAccess.asFileUri('vs/paradis/contrib/fileViewers/node/spreadsheet/paradisSpreadsheetParseWorkerMain.js').fsPath;
const LIMITS = { depth: 64, nodes: 10000, attributeLength: 10000, characters: 1000000 };

type Tree = [uri: string, local: string, attributes: string[], children: (Tree | string)[]];

/** The namespace tree of `xml`. With `unprefixed`, attributes in SpreadsheetML count as unqualified (the rewrite removes their prefix on purpose). */
function namespaceTree(xml: string, unprefixed = false): Tree {
	const project = (node: Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>): Tree => [
		node.uri,
		node.local,
		node.attributes.map(attribute => `{${unprefixed && attribute.uri === MAIN ? '' : attribute.uri}}${attribute.local}=${attribute.value}`).sort(),
		node.children.flatMap((child): (Tree | string)[] => child.kind === 'element' ? [project(child)] : child.kind === 'text' ? [child.value] : []),
	];
	return project(parseParadisOfficeXml(xml, LIMITS).root);
}

/** Invented workbook with everything the viewer reads from the package itself and through exceljs. */
async function inventedWorkbook(): Promise<Buffer> {
	const workbook = new ExcelJS.Workbook();
	const sheet = workbook.addWorksheet('Form', { pageSetup: { orientation: 'landscape', paperSize: 9, margins: { left: 0.5, right: 0.5, top: 1, bottom: 1, header: 0.3, footer: 0.3 } } });
	for (let row = 1; row <= 12; row++) {
		for (let column = 1; column <= 4; column++) {
			const cell = sheet.getCell(row, column);
			cell.value = row === 1 ? `head ${column}` : row * column;
			if (row === 1) {
				cell.font = { bold: true, color: { argb: 'FF112233' } };
				cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEEFF' } };
				cell.border = { bottom: { style: 'thin' } };
			}
		}
	}
	sheet.getCell('A1').note = 'a note';
	sheet.getRow(6).addPageBreak();
	sheet.mergeCells('A14:B15');
	sheet.getCell('A14').value = 'merged';
	for (let row = 2; row <= 12; row++) {
		sheet.getCell(row, 6).dataValidation = { type: 'list', formulae: ['"A,B"'], allowBlank: true };
	}
	const table = workbook.addWorksheet('Table');
	table.addTable({ name: 'Items', ref: 'A1', headerRow: true, columns: [{ name: 'Name' }, { name: 'Count' }], rows: [['apple', 1], ['pear', 2]] });
	return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Writes every SpreadsheetML part of `bytes` the way OpenXML SDK does: `x:` on each element, no default namespace. */
async function prefixed(bytes: Buffer): Promise<{ readonly bytes: Buffer; readonly parts: readonly string[] }> {
	const zip = await JSZip.loadAsync(bytes);
	const parts: string[] = [];
	for (const name of Object.keys(zip.files)) {
		if (!name.endsWith('.xml')) {
			continue;
		}
		const xml = await zip.file(name)!.async('text');
		if (!xml.includes(`xmlns="${MAIN}"`)) {
			continue;
		}
		parts.push(name);
		zip.file(name, xml.replaceAll(`xmlns="${MAIN}"`, `xmlns:x="${MAIN}"`).replace(/<(?<close>\/?)(?<name>[A-Za-z_][\w.-]*)(?=[\s/>])/g, '<$<close>x:$<name>'));
	}
	return { bytes: Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })), parts: parts.sort() };
}

suite('ParadisSpreadsheetPrefixedXml', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('removes SpreadsheetML prefixes and keeps every element in its namespace', () => {
		const cases = [
			// What OpenXML SDK writes: no default namespace, other prefixes and a comment that mentions x:.
			`<?xml version="1.0" encoding="utf-8"?><x:worksheet xmlns:r="urn:r" xmlns:mc="urn:mc" mc:Ignorable="x14ac" xmlns:x14ac="urn:x14ac" xmlns:x="${MAIN}"><x:sheetData><x:row r="1" x14ac:dyDescent="0.25"><x:c r="A1" t="s"><x:v>0</x:v></x:c></x:row></x:sheetData><!-- <x:keep/> --><x:drawing r:id="rId1" /></x:worksheet>`,
			// A different default namespace in scope, an element with no namespace, and an inner redeclaration of x.
			`<x:worksheet xmlns:x="${MAIN}" xmlns="urn:other"><foo><x:bar/></foo><baz xmlns=""/><x:b xmlns:x="urn:other"><x:c/></x:b></x:worksheet>`,
			// Prefixed attributes, one of which would collide with an unprefixed one.
			`<x:a xmlns:x='${MAIN}' x:b="1" x:c="2" c="3"><![CDATA[<x:a>]]></x:a>`,
		];

		const results = cases.map(xml => unprefixSpreadsheetMlXml(xml)!);

		deepStrictEqual(results, [
			`<?xml version="1.0" encoding="utf-8"?><worksheet xmlns="${MAIN}" xmlns:r="urn:r" xmlns:mc="urn:mc" mc:Ignorable="x14ac" xmlns:x14ac="urn:x14ac" xmlns:x="${MAIN}"><sheetData><row r="1" x14ac:dyDescent="0.25"><c r="A1" t="s"><v>0</v></c></row></sheetData><!-- <x:keep/> --><drawing r:id="rId1" /></worksheet>`,
			`<worksheet xmlns:x="${MAIN}" xmlns="${MAIN}"><foo xmlns="urn:other"><bar xmlns="${MAIN}"/></foo><baz xmlns=""/><x:b xmlns:x="urn:other"><x:c/></x:b></worksheet>`,
			`<a xmlns="${MAIN}" xmlns:x='${MAIN}' b="1" x:c="2" c="3"><![CDATA[<x:a>]]></a>`,
		]);
		deepStrictEqual(results.map(xml => namespaceTree(xml, true)), cases.map(xml => namespaceTree(xml, true)));
	});

	test('leaves XML without SpreadsheetML prefixes, and XML it cannot follow, as it is', () => {
		const vml = '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:x="urn:schemas-microsoft-com:office:excel"><v:shape><x:ClientData ObjectType="Note"><x:Row>0</x:Row></x:ClientData></v:shape></xml>';
		const extension = `<worksheet xmlns="${MAIN}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><extLst><ext><x14:dataValidations/></ext></extLst></worksheet>`;

		deepStrictEqual([
			unprefixSpreadsheetMlXml(vml) === vml,
			unprefixSpreadsheetMlXml(extension) === extension,
			unprefixSpreadsheetMlXml(`<x:a xmlns:x="${MAIN}"><x:b></x:a>`),
			rootBindsSpreadsheetMlPrefix(`<?xml version="1.0"?>\n<x:workbook xmlns:x="${MAIN}">`),
			rootBindsSpreadsheetMlPrefix(`<?xml version="1.0"?><workbook xmlns="${MAIN}"><x:sheets xmlns:x="${MAIN}"/>`),
			rootBindsSpreadsheetMlPrefix(`<?xml version="1.0"?><x:workbook xmlns:x="${MAIN.slice(0, 20)}`),
		], [true, true, undefined, true, false, undefined]);
	});

	test('stays linear on markup that never closes, and leaves such a part alone', async () => {
		const hostile = [
			'<'.repeat(200_000),
			`<x:a xmlns:x="${MAIN}">${'<!--'.repeat(50_000)}`,
			`<x:a xmlns:x="${MAIN}">${'<?'.repeat(100_000)}`,
			`<x:a xmlns:x="${MAIN}">${'<!'.repeat(100_000)}`,
			`<x:a xmlns:x="${MAIN}" b="${'<'.repeat(200_000)}"/>`,
			`<x:a xmlns:x="${MAIN}">${'<x:b c="1"'.repeat(20_000)}`,
		];
		const original = await inventedWorkbook();
		const zip = await JSZip.loadAsync(original);
		zip.file('xl/evil.xml', '<'.repeat(64 * 1024));
		zip.file('xl/evil2.xml', `<x:a xmlns:x="${MAIN}">${'<'.repeat(200_000)}`);
		const withHostileParts = Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));

		const started = Date.now();
		const results = hostile.map(xml => unprefixSpreadsheetMlXml(xml));
		const heads = hostile.map(xml => rootBindsSpreadsheetMlPrefix(xml));
		const scanned = Date.now() - started;
		const workbook = await new ParadisSpreadsheetService().parseWorkbookBytes(withHostileParts);
		const opened = Date.now() - started - scanned;

		deepStrictEqual({ results, heads, sheets: workbook.sheets.map(sheet => sheet.name) }, {
			results: hostile.map(() => undefined),
			heads: [false, true, true, true, false, true],
			sheets: ['Form', 'Table'],
		});
		// Before the scan was linear, these took 31 seconds (the 64 KiB part) and 156 seconds (200K `<`).
		ok(scanned < 1000 && opened < 3000, `scanned in ${scanned}ms, opened in ${opened}ms`);
	});

	test('opens a workbook with x: prefixes the same as the one without, including what the viewer reads itself', async () => {
		const original = await inventedWorkbook();
		const { bytes, parts } = await prefixed(original);
		const service = new ParadisSpreadsheetService();

		const expected = await service.parseWorkbookBytes(original);
		const actual = await service.parseWorkbookBytes(bytes);

		const form = expected.sheets[0];
		// The original must carry each item, or both sides would match by being empty.
		deepStrictEqual({
			parts,
			sheets: expected.sheets.map(sheet => sheet.name),
			rowBreaks: form.rowBreaks,
			dataValidations: form.dataValidations?.length,
			pageSetup: !!form.pageSetup,
			comments: form.comments?.length,
			bold: form.rows[0].cells[0].style.fontWeight,
			tables: expected.sheets[1].tables?.length,
		}, {
			parts: ['xl/comments1.xml', 'xl/sharedStrings.xml', 'xl/styles.xml', 'xl/tables/table1.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'],
			sheets: ['Form', 'Table'],
			rowBreaks: [6],
			dataValidations: 1,
			pageSetup: true,
			comments: 1,
			bold: 'bold',
			tables: 1,
		});
		deepStrictEqual(actual, expected);
	});

	test('returns a workbook without prefixes unchanged, and parses a prefixed one in the parse worker', async () => {
		const original = await inventedWorkbook();
		const { bytes } = await prefixed(original);

		strictEqual(await unprefixWorkbookSpreadsheetMl(original, JSZip), original);
		notStrictEqual(await unprefixWorkbookSpreadsheetMl(bytes, JSZip), bytes);

		// The Electron renderer test host cannot launch worker_threads; the node unit runner runs this part.
		if (process.type === 'renderer') {
			return;
		}
		const backend = disposables.add(new ParadisSpreadsheetParseWorkerBackend((await ParadisSpreadsheetParseWorkerBackend.workerFactory(WORKER_PATH))!));
		const parsed = await backend.parse(new Uint8Array(bytes), undefined, CancellationToken.None);
		ok(parsed.kind === 'workbook');
		deepStrictEqual(unpackParadisWorkbookStyles(parsed.workbook), await new ParadisSpreadsheetService().parseWorkbookBytes(original));
	});

	test('reads a prefixed workbook in the semantic diagnostics as it reads the one without', async () => {
		const original = await inventedWorkbook();
		const { bytes } = await prefixed(original);

		const summaries = await Promise.all([original, bytes].map(async source => {
			const { elapsedMilliseconds: _, ...summary } = await collectParadisSpreadsheetSemanticDiagnostics(new Uint8Array(source));
			return summary;
		}));

		strictEqual(summaries[0].available, true);
		deepStrictEqual(summaries[1], summaries[0]);
	});
});
