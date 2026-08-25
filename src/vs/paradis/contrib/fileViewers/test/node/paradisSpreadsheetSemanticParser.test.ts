/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, rejects, strictEqual } from 'assert';
import { createHash } from 'crypto';
import JSZip from 'jszip';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_OFFICE_BUDGET_PROFILES, type ParadisOfficeInventory } from '../../common/paradisOfficeProtocol.js';
import { inspectOfficePackage } from '../../common/office/paradisOfficePackageCore.js';
import type { IParadisWorkbookData } from '../../common/paradisSpreadsheet.js';
import { parseSpreadsheetSemantic } from '../../common/spreadsheet/paradisSpreadsheetSemanticParser.js';
import { parseSpreadsheetSemanticNode } from '../../node/spreadsheet/paradisSpreadsheetNodeAdapter.js';
import { createParadisOfficeNodeArchive } from '../../node/office/paradisOfficeNodeArchive.js';
import { buildOpcFixture, type ParadisOfficeFixturePart } from '../common/paradisOfficeFixture.js';

const spreadsheetNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const officeDocumentRelationship = `${relationshipNamespace}/officeDocument`;
const worksheetRelationship = `${relationshipNamespace}/worksheet`;
const stylesRelationship = `${relationshipNamespace}/styles`;
const sharedStringsRelationship = `${relationshipNamespace}/sharedStrings`;

const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${relationshipNamespace}">
	<workbookPr date1904="1"/>
	<bookViews><workbookView activeTab="1" firstSheet="0" visibility="visible"/></bookViews>
	<sheets>
		<sheet name="Matrix" sheetId="7" state="visible" r:id="rIdSheet1"/>
		<sheet name="Archive" sheetId="9" state="veryHidden" r:id="rIdSheet2"/>
	</sheets>
	<definedNames>
		<definedName name="InputArea" localSheetId="0" hidden="1">Matrix!$A$1:$C$12</definedName>
		<definedName name="GlobalValue">42</definedName>
	</definedNames>
	<calcPr calcId="191029" calcMode="manual" fullCalcOnLoad="1" iterate="1" iterateCount="12" iterateDelta="0.01"/>
</workbook>`;

const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${spreadsheetNamespace}" xmlns:evil="urn:not-spreadsheet">
	<dimension ref="A1:E12"/>
	<sheetViews>
		<sheetView workbookViewId="0" showGridLines="0" rightToLeft="1" zoomScale="125">
			<pane xSplit="2" ySplit="3" topLeftCell="C4" activePane="bottomRight" state="frozenSplit"/>
			<selection pane="bottomRight" activeCell="D5" sqref="D5:E6"/>
		</sheetView>
	</sheetViews>
	<cols>
		<col min="1" max="1" width="14.5" customWidth="1" bestFit="1"/>
		<col min="3" max="3" width="9" hidden="1" outlineLevel="2" collapsed="1" style="1"/>
	</cols>
	<sheetData>
		<row r="1" ht="22" customHeight="1" s="1" customFormat="1">
			<c r="A1" s="1"><v>1</v></c>
			<c r="C1" t="inlineStr"><is><r><rPr><b/><color rgb="FFFF0000"/></rPr><t>rich</t></r><r><t xml:space="preserve"> text</t></r></is></c>
			<c r="D1" t="s"><v>1</v></c>
			<evil:c r="E1" t="str"><evil:v>must-not-parse</evil:v></evil:c>
		</row>
		<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" s="1"><f>SUM(B3:B6)</f><v>1</v></c></row>
		<row r="3"><c r="A3" t="inlineStr"><is><t/></is></c><c r="B3"><f>NOW()</f></c></row>
		<row r="4" outlineLevel="1"><c r="A4"/><c r="B4"><f t="shared" ref="B4:B5" si="4">A1*2</f><v>2</v></c></row>
		<row r="5"><c r="A5" t="b"><v>1</v></c><c r="B5"><f t="shared" si="4"/><v>2</v></c></row>
		<row r="6"><c r="B6"><f t="array" ref="B6:B7">TRANSPOSE(A1:A2)</f><v>3</v></c></row>
		<row r="7"><c r="B7" t="e"><v>#DIV/0!</v></c></row>
		<row r="8"><c r="B8" t="d"><v>2026-08-26T00:00:00Z</v></c></row>
		<row r="10"><c r="B10" s="1"/></row>
		<row r="12" hidden="1" outlineLevel="2" collapsed="1"><c r="C12" s="1"/></row>
	</sheetData>
	<mergeCells count="1"><mergeCell ref="D1:E2"/></mergeCells>
</worksheet>`;

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${spreadsheetNamespace}">
	<numFmts count="1"><numFmt numFmtId="165" formatCode="0.000"/></numFmts>
	<fonts count="1"><font><name val="Aptos"/><sz val="11"/></font></fonts>
	<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
	<borders count="2">
		<border><left/><right/><top/><bottom/><diagonal/></border>
		<border diagonalUp="1" diagonalDown="1"><left/><right/><top/><bottom/><diagonal style="dashDot"><color rgb="FFFF0000"/></diagonal></border>
	</borders>
	<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
	<cellXfs count="2">
		<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
		<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyNumberFormat="1"/>
	</cellXfs>
</styleSheet>`;

const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="${spreadsheetNamespace}" count="2" uniqueCount="2">
	<si><t>1</t></si>
	<si><r><rPr><i/><color theme="4" tint="0.4"/></rPr><t>shared</t></r><r><t xml:space="preserve"> rich</t></r></si>
</sst>`;

const archiveSheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${spreadsheetNamespace}"><dimension ref="A1:A1"/><sheetData><row r="1"><c r="A1" t="str"><v>archived</v></c></row></sheetData></worksheet>`;

interface SemanticFixture {
	readonly bytes: Uint8Array;
	readonly inventory: ParadisOfficeInventory;
}

interface SemanticFixtureOverrides {
	readonly worksheet?: string;
	readonly extraParts?: readonly ParadisOfficeFixturePart[];
	readonly firstSheetRelationshipTarget?: string;
	readonly rootRelationshipTarget?: string;
	readonly workbookContentType?: string;
}

async function buildSemanticBytes(overrides: SemanticFixtureOverrides = {}): Promise<Uint8Array> {
	return buildOpcFixture({
		parts: [
			['/xl/workbook.xml', workbookXml, overrides.workbookContentType ?? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
			['/xl/worksheets/sheet1.xml', overrides.worksheet ?? worksheetXml, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'],
			['/xl/worksheets/sheet2.xml', archiveSheetXml, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'],
			['/xl/styles.xml', stylesXml, 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'],
			['/xl/sharedStrings.xml', sharedStringsXml, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml'],
			...(overrides.extraParts ?? []),
		],
		relationships: [
			{ id: 'rIdRoot', type: officeDocumentRelationship, target: overrides.rootRelationshipTarget ?? 'xl/workbook.xml' },
			{ source: '/xl/workbook.xml', id: 'rIdSheet1', type: worksheetRelationship, target: overrides.firstSheetRelationshipTarget ?? 'worksheets/sheet1.xml' },
			{ source: '/xl/workbook.xml', id: 'rIdSheet2', type: worksheetRelationship, target: 'worksheets/sheet2.xml' },
			{ source: '/xl/workbook.xml', id: 'rIdStyles', type: stylesRelationship, target: 'styles.xml' },
			{ source: '/xl/workbook.xml', id: 'rIdStrings', type: sharedStringsRelationship, target: 'sharedStrings.xml' },
		],
	});
}

async function createSemanticFixture(overrides: SemanticFixtureOverrides = {}): Promise<SemanticFixture> {
	const bytes = await buildSemanticBytes(overrides);
	const inventory = await inspectOfficePackage(
		await createParadisOfficeNodeArchive(bytes),
		PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal,
		CancellationToken.None,
	);
	return { bytes, inventory };
}

function rawSha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

async function reorderWorkbookRelationshipAttributes(bytes: Uint8Array): Promise<Uint8Array> {
	const zip = await JSZip.loadAsync(bytes);
	const path = 'xl/_rels/workbook.xml.rels';
	const entry = zip.file(path);
	if (!entry) {
		throw new Error('missing workbook relationships');
	}
	const original = await entry.async('text');
	const changed = original.replace(
		/<Relationship Id="rIdSheet1" Type="([^"]+)" Target="([^"]+)"\/>/,
		'<Relationship Type="$1" Id="rIdSheet1" Target="$2"/>',
	);
	strictEqual(changed.length, original.length);
	zip.file(path, changed, { createFolders: false, date: entry.date });
	return zip.generateAsync({ comment: '', compression: 'STORE', platform: 'DOS', type: 'uint8array' });
}

function differingLegacyProjection(): IParadisWorkbookData {
	return {
		sheets: [{
			name: 'Matrix',
			rows: [{
				excelRow: 1,
				height: 20,
				cells: [{
					value: 'projection-value',
					style: {},
					diagonal: { up: true, down: true, style: '1px solid', color: '#000000' },
				}],
			}],
			columnCount: 1,
			columnWidths: [64],
			truncated: false,
			minCol: 1,
		}],
	};
}

suite('ParadisSpreadsheetSemanticParser', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps raw cell type, formula, cache presence, and otherwise equal values separate', async () => {
		const fixture = await createSemanticFixture();
		const snapshot = await parseSpreadsheetSemantic(
			await createParadisOfficeNodeArchive(fixture.bytes),
			fixture.inventory,
			CancellationToken.None,
		);
		const cells = snapshot.sheets[0].cells;
		const styleFingerprint = { algorithm: 'sha256' as const, value: rawSha256(new TextEncoder().encode(stylesXml)), byteLength: new TextEncoder().encode(stylesXml).byteLength };

		deepStrictEqual(cells.get('A1'), {
			storedType: 'number',
			rawValue: '1',
			styleRef: 1,
			styleSource: { partId: '/xl/styles.xml', fingerprint: styleFingerprint },
		});
		deepStrictEqual(cells.get('A2'), { storedType: 'string', rawType: 's', rawValue: '0', text: '1', sharedStringIndex: 0 });
		deepStrictEqual(cells.get('A3'), { storedType: 'string', rawType: 'inlineStr', rawValue: '', text: '' });
		deepStrictEqual(cells.get('A4'), { storedType: 'blank' });
		deepStrictEqual(cells.get('A5'), { storedType: 'boolean', rawType: 'b', rawValue: '1' });
		deepStrictEqual(cells.get('B2'), {
			storedType: 'formula',
			rawValue: undefined,
			formula: { text: 'SUM(B3:B6)', kind: 'normal' },
			cachedResult: { present: true, type: 'number', rawValue: '1' },
			styleRef: 1,
			styleSource: { partId: '/xl/styles.xml', fingerprint: styleFingerprint },
		});
		deepStrictEqual(cells.get('B3'), {
			storedType: 'formula',
			rawValue: undefined,
			formula: { text: 'NOW()', kind: 'normal' },
			cachedResult: { present: false },
		});
		deepStrictEqual(cells.get('B4')?.formula, { text: 'A1*2', kind: 'shared', ref: 'B4:B5', sharedIndex: 4 });
		deepStrictEqual(cells.get('B5')?.formula, { text: '', kind: 'shared', sharedIndex: 4 });
		deepStrictEqual(cells.get('B6')?.formula, { text: 'TRANSPOSE(A1:A2)', kind: 'array', ref: 'B6:B7' });
		deepStrictEqual(cells.get('B7'), { storedType: 'error', rawType: 'e', rawValue: '#DIV/0!' });
		deepStrictEqual(cells.get('B8'), { storedType: 'date', rawType: 'd', rawValue: '2026-08-26T00:00:00Z' });
		strictEqual(snapshot.date1904, true);
	});

	test('retains workbook, sheet, sparse string, view, row, column, merge, style, and completeness semantics', async () => {
		const fixture = await createSemanticFixture();
		const snapshot = await parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None);

		deepStrictEqual(snapshot.sheets.map(sheet => [sheet.name, sheet.sheetId, sheet.order, sheet.state, sheet.partId]), [
			['Matrix', '7', 0, 'visible', '/xl/worksheets/sheet1.xml'],
			['Archive', '9', 1, 'veryHidden', '/xl/worksheets/sheet2.xml'],
		]);
		deepStrictEqual(snapshot.calcProperties, {
			calcId: '191029', calcMode: 'manual', fullCalcOnLoad: true, iterate: true, iterateCount: 12, iterateDelta: '0.01',
		});
		deepStrictEqual(snapshot.definedNames, [
			{ name: 'InputArea', text: 'Matrix!$A$1:$C$12', localSheetId: 0, hidden: true },
			{ name: 'GlobalValue', text: '42' },
		]);
		const sheet = snapshot.sheets[0];
		deepStrictEqual(sheet.dimension, { ref: 'A1:E12', minRow: 1, minColumn: 1, maxRow: 12, maxColumn: 5 });
		deepStrictEqual(sheet.merges, [{ ref: 'D1:E2', minRow: 1, minColumn: 4, maxRow: 2, maxColumn: 5 }]);
		deepStrictEqual(sheet.rows.get(12), { index: 12, hidden: true, outlineLevel: 2, collapsed: true });
		deepStrictEqual(sheet.columns[1], { min: 3, max: 3, width: '9', hidden: true, outlineLevel: 2, collapsed: true, styleRef: 1 });
		deepStrictEqual(sheet.views[0], {
			workbookViewId: 0,
			showGridLines: false,
			rightToLeft: true,
			zoomScale: 125,
			pane: { xSplit: '2', ySplit: '3', topLeftCell: 'C4', activePane: 'bottomRight', state: 'frozenSplit' },
			selections: [{ pane: 'bottomRight', activeCell: 'D5', sqref: 'D5:E6' }],
		});
		deepStrictEqual(sheet.cells.get('C1'), {
			storedType: 'string', rawType: 'inlineStr', rawValue: 'rich text', text: 'rich text',
			richText: [{ text: 'rich', properties: { bold: true, color: { rgb: 'FFFF0000' } } }, { text: ' text' }],
		});
		deepStrictEqual(sheet.cells.get('D1'), {
			storedType: 'string', rawType: 's', rawValue: '1', text: 'shared rich', sharedStringIndex: 1,
			richText: [{ text: 'shared', properties: { italic: true, color: { theme: 4, tint: '0.4' } } }, { text: ' rich' }],
		});
		strictEqual(sheet.cells.has('E1'), false);
		deepStrictEqual(snapshot.styles.completeness, {
			declaredCellFormats: 2, parsedCellFormats: 2, declaredBorders: 2, parsedBorders: 2,
			cellsWithStyleRefs: 4, unresolvedStyleRefs: 0, cellsWithDiagonalStyleRefs: 4,
		});
		deepStrictEqual(snapshot.completeness, {
			expectedParts: 8, visitedParts: 8, parsedParts: 8, expectedSheets: 2, parsedSheets: 2,
			expectedCells: 17, parsedCells: 17, unknownElements: 1, unknownAttributes: 0, unresolvedReferences: 0, terminal: true,
		});
	});

	test('does not normalize diagonal style identity away on populated, blank, or hidden cells when projection differs', async () => {
		const fixture = await createSemanticFixture();
		const before = fixture.bytes.slice();
		const beforeHash = rawSha256(fixture.bytes);
		const snapshot = await parseSpreadsheetSemanticNode(fixture.bytes, fixture.inventory, CancellationToken.None, {
			projection: differingLegacyProjection(),
		});

		strictEqual(rawSha256(fixture.bytes), beforeHash);
		deepStrictEqual(fixture.bytes, before);
		for (const address of ['A1', 'B10', 'C12']) {
			const cell = snapshot.sheets[0].cells.get(address);
			strictEqual(cell?.styleRef, 1);
			strictEqual(cell?.styleSource?.partId, '/xl/styles.xml');
			strictEqual(cell?.styleSource?.fingerprint.value, rawSha256(new TextEncoder().encode(stylesXml)));
			strictEqual(snapshot.styles.cellFormats[cell!.styleRef!].borderRef, 1);
			strictEqual(snapshot.styles.borders[1].diagonalUp, true);
			strictEqual(snapshot.styles.borders[1].diagonalDown, true);
			deepStrictEqual(snapshot.styles.borders[1].diagonal, { style: 'dashDot', color: { rgb: 'FFFF0000' } });
		}
		strictEqual(snapshot.sheets[0].rows.get(12)?.hidden, true);
		strictEqual(snapshot.sheets[0].columns.some(column => column.min <= 3 && column.max >= 3 && column.hidden), true);
		strictEqual(snapshot.projectionDiagnostics.some(diagnostic => diagnostic.kind === 'diagonalStyleMismatch' && diagnostic.cellAddress === 'A1'), true);
		strictEqual(snapshot.projectionDiagnostics.some(diagnostic => diagnostic.kind === 'valueMismatch' && diagnostic.cellAddress === 'A1'), true);
	});

	test('rejects a workbook relationship that is external, missing, cyclic, or points at the wrong part', async () => {
		const fixture = await createSemanticFixture();
		for (const relationshipPatch of [
			{ targetMode: 'external' as const },
			{ missing: true },
			{ cyclic: true },
			{ target: '/xl/worksheets/sheet2.xml' },
		]) {
			const inventory: ParadisOfficeInventory = {
				...fixture.inventory,
				relationships: fixture.inventory.relationships.map(relationship => relationship.id === 'rIdSheet1' ? { ...relationship, ...relationshipPatch } : relationship),
			};
			await rejects(
				parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), inventory, CancellationToken.None),
				/unsafe/,
			);
		}
	});

	test('rejects forged inventory relationships and owns inventory before its first asynchronous boundary', async () => {
		const fixture = await createSemanticFixture();
		const swappedRelationships = fixture.inventory.relationships.map(relationship => {
			if (relationship.id === 'rIdSheet1') {
				return { ...relationship, target: '/xl/worksheets/sheet2.xml' };
			}
			if (relationship.id === 'rIdSheet2') {
				return { ...relationship, target: '/xl/worksheets/sheet1.xml' };
			}
			return { ...relationship };
		});
		const forged: ParadisOfficeInventory = { ...fixture.inventory, relationships: swappedRelationships };

		await rejects(
			parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), forged, CancellationToken.None),
			/unsafe/,
		);
		const forgedWorkbookContentType: ParadisOfficeInventory = {
			...fixture.inventory,
			parts: fixture.inventory.parts.map(part => part.canonicalUri === '/xl/workbook.xml'
				? { ...part, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml' }
				: part),
		};
		await rejects(
			parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), forgedWorkbookContentType, CancellationToken.None),
			/unsafe/,
		);

		const mutable: ParadisOfficeInventory = {
			...fixture.inventory,
			relationships: fixture.inventory.relationships.map(relationship => ({ ...relationship })),
		};
		const parsing = parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), mutable, CancellationToken.None);
		Object.defineProperty(mutable, 'relationships', { configurable: true, value: swappedRelationships });
		const snapshot = await parsing;

		strictEqual(snapshot.sheets[0].cells.get('A1')?.storedType, 'number');
		strictEqual(snapshot.sheets[0].cells.get('A1')?.rawValue, '1');
	});

	test('rejects an all-byte relationship Part change even when its ZIP metadata and byte length are unchanged', async () => {
		const fixture = await createSemanticFixture();
		const changedRelationships = await createSemanticFixture({ firstSheetRelationshipTarget: 'worksheets/sheet2.xml' });
		strictEqual(changedRelationships.bytes.byteLength, fixture.bytes.byteLength);

		await rejects(
			parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(changedRelationships.bytes), fixture.inventory, CancellationToken.None),
			/unsafe/,
		);

		const changedRootRelationships = await buildSemanticBytes({ rootRelationshipTarget: 'xl/workboox.xml' });
		strictEqual(changedRootRelationships.byteLength, fixture.bytes.byteLength);
		await rejects(
			parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(changedRootRelationships), fixture.inventory, CancellationToken.None),
			/unsafe/,
		);

		const reorderedRelationships = await reorderWorkbookRelationshipAttributes(fixture.bytes);
		strictEqual(reorderedRelationships.byteLength, fixture.bytes.byteLength);
		await rejects(
			parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(reorderedRelationships), fixture.inventory, CancellationToken.None),
			/unsafe/,
		);
	});

	test('binds inventory content types to the verified Content Types Part', async () => {
		const fixture = await createSemanticFixture();
		const changed = await createSemanticFixture({
			workbookContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
		});
		const changedContentTypes = changed.inventory.parts.find(part => part.canonicalUri === '/[Content_Types].xml');
		if (!changedContentTypes) {
			throw new Error('missing changed Content Types inventory');
		}
		const forgedInventory: ParadisOfficeInventory = {
			...fixture.inventory,
			budgetUsage: { ...changed.inventory.budgetUsage },
			parts: fixture.inventory.parts.map(part => part.canonicalUri === '/[Content_Types].xml' ? changedContentTypes : part),
		};

		await rejects(
			parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(changed.bytes), forgedInventory, CancellationToken.None),
			/unsafe/,
		);
	});

	test('detects relevant part TOCTOU and enforces semantic cell, deadline, and cancellation limits', async () => {
		const fixture = await createSemanticFixture();
		const changed = await createSemanticFixture({ worksheet: worksheetXml.replace('<v>1</v>', '<v>2</v>') });
		await rejects(
			parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(changed.bytes), fixture.inventory, CancellationToken.None),
			/unsafe/,
		);
		await rejects(
			parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None, { limits: { cells: 16 } }),
			/limitExceeded/,
		);
		const oversizedProjection: IParadisWorkbookData = {
			sheets: [{
				name: 'Matrix', minCol: 1, columnCount: 2, columnWidths: [64, 64], truncated: false,
				rows: [{ excelRow: 1, height: 20, cells: [{ value: '1', style: {} }, { value: '2', style: {} }] }],
			}],
		};
		await rejects(
			parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None, {
				projection: oversizedProjection,
				limits: { projectionCells: 1 },
			}),
			/limitExceeded/,
		);
		const oversizedProjectionStructure: IParadisWorkbookData = {
			sheets: [
				{ name: 'Unrelated', minCol: 1, columnCount: 0, columnWidths: [], truncated: false, rows: [] },
				{ name: 'Matrix', minCol: 1, columnCount: 0, columnWidths: [], truncated: false, rows: [{ excelRow: 1, height: 20, cells: [] }, { excelRow: 2, height: 20, cells: [] }] },
			],
		};
		await rejects(
			parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None, {
				projection: oversizedProjectionStructure,
				limits: { projectionSheets: 1 },
			}),
			/limitExceeded/,
		);
		await rejects(
			parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None, {
				projection: oversizedProjectionStructure,
				limits: { projectionRows: 1 },
			}),
			/limitExceeded/,
		);
		let clock = 0;
		await rejects(
			parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None, { now: () => ++clock, deadlineMilliseconds: 2 }),
			/limitExceeded/,
		);
		const cancellation = new CancellationTokenSource();
		cancellation.cancel();
		await rejects(
			parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, cancellation.token),
			/cancelled/,
		);
		cancellation.dispose();
	});

	test('rejects duplicate value nodes and foreign descendants instead of inventing a raw value', async () => {
		for (const invalidCell of [
			'<c r="A1"><v>1</v><v>2</v></c>',
			'<c r="A1"><v>1<evil:x>2</evil:x></v></c>',
			'<c r="A1" t="n"><v>1</v><is><t>shadow</t></is></c>',
		]) {
			const invalidWorksheet = worksheetXml.replace('<c r="A1" s="1"><v>1</v></c>', invalidCell);
			const fixture = await createSemanticFixture({ worksheet: invalidWorksheet });
			await rejects(
				parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None),
				/malformed/,
			);
		}
	});

	test('counts unknown attributes on semantic root and leaf elements', async () => {
		const worksheetWithUnknownAttributes = worksheetXml
			.replace('<worksheet xmlns=', '<worksheet evil:rootFlag="1" xmlns=')
			.replace('<dimension ref="A1:E12"/>', '<dimension ref="A1:E12" evil:dimensionFlag="1"/>');
		const fixture = await createSemanticFixture({ worksheet: worksheetWithUnknownAttributes });
		const snapshot = await parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None);

		strictEqual(snapshot.completeness.unknownAttributes, 2);
	});
});
