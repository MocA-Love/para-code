/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, rejects, strictEqual, throws } from 'assert';
import { createHash } from 'crypto';
import JSZip from 'jszip';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_OFFICE_BUDGET_PROFILES, type ParadisOfficeInventory } from '../../common/paradisOfficeProtocol.js';
import { type IParadisOfficeArchive, ParadisOfficePackageError } from '../../common/office/paradisOfficeArchive.js';
import { inspectOfficePackage } from '../../common/office/paradisOfficePackageCore.js';
import { diagnoseSpreadsheetProjection, type IParadisDiagonalBorder, type IParadisWorkbookData } from '../../common/paradisSpreadsheet.js';
import { ownSpreadsheetSemanticInput, parseSpreadsheetSemantic, resolveSpreadsheetSemanticLimits, sanitizeSpreadsheetPackageError } from '../../common/spreadsheet/paradisSpreadsheetSemanticParser.js';
import { parseSpreadsheetSemanticNode } from '../../node/spreadsheet/paradisSpreadsheetNodeAdapter.js';
import { createParadisOfficeNodeArchive } from '../../node/office/paradisOfficeNodeArchive.js';
import { buildOpcFixture, type IParadisOfficeFixtureRelationship, type ParadisOfficeFixturePart } from '../common/paradisOfficeFixture.js';

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

const effectiveStylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${spreadsheetNamespace}">
	<borders count="5">
		<border diagonalUp="1"><diagonal style="thin"><color rgb="FF112233"/></diagonal></border>
		<border diagonalDown="1"><diagonal style="medium"><color theme="4" tint="0.2"/></diagonal></border>
		<border diagonalUp="1" diagonalDown="1"><diagonal style="dashDot"><color indexed="7"/></diagonal></border>
		<border diagonalUp="1"><diagonal style="double"><color auto="1"/></diagonal></border>
		<border><diagonal/></border>
	</borders>
	<cellXfs count="5">
		<xf borderId="0" applyBorder="1"/><xf borderId="1" applyBorder="1"/><xf borderId="2" applyBorder="1"/>
		<xf borderId="3" applyBorder="1"/><xf borderId="4" applyBorder="1"/>
	</cellXfs>
</styleSheet>`;

const effectiveStyleWorksheetXml = `<worksheet xmlns="${spreadsheetNamespace}"><dimension ref="A1:E2"/>
	<cols><col min="2" max="3" style="1"/></cols><sheetData>
		<row r="1" s="2" customFormat="1"><c r="A1"/><c r="B1"/><c r="C1" s="3"/><c r="D1"/><c r="E1" s="4"/></row>
		<row r="2"><c r="A2"/><c r="B2"/><c r="C2" s="3"/></row>
	</sheetData></worksheet>`;

const archiveSheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${spreadsheetNamespace}"><dimension ref="A1:A1"/><sheetData><row r="1"><c r="A1" t="str"><v>archived</v></c></row></sheetData></worksheet>`;

interface SemanticFixture {
	readonly bytes: Uint8Array;
	readonly inventory: ParadisOfficeInventory;
}

interface SemanticFixtureOverrides {
	readonly workbook?: string;
	readonly worksheet?: string;
	readonly extraParts?: readonly ParadisOfficeFixturePart[];
	readonly firstSheetRelationshipTarget?: string;
	readonly rootRelationshipTarget?: string;
	readonly workbookContentType?: string;
	readonly styles?: string;
	readonly extraRelationships?: readonly IParadisOfficeFixtureRelationship[];
}

async function buildSemanticBytes(overrides: SemanticFixtureOverrides = {}): Promise<Uint8Array> {
	return buildOpcFixture({
		parts: [
			['/xl/workbook.xml', overrides.workbook ?? workbookXml, overrides.workbookContentType ?? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
			['/xl/worksheets/sheet1.xml', overrides.worksheet ?? worksheetXml, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'],
			['/xl/worksheets/sheet2.xml', archiveSheetXml, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'],
			['/xl/styles.xml', overrides.styles ?? stylesXml, 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'],
			['/xl/sharedStrings.xml', sharedStringsXml, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml'],
			...(overrides.extraParts ?? []),
		],
		relationships: [
			{ id: 'rIdRoot', type: officeDocumentRelationship, target: overrides.rootRelationshipTarget ?? 'xl/workbook.xml' },
			{ source: '/xl/workbook.xml', id: 'rIdSheet1', type: worksheetRelationship, target: overrides.firstSheetRelationshipTarget ?? 'worksheets/sheet1.xml' },
			{ source: '/xl/workbook.xml', id: 'rIdSheet2', type: worksheetRelationship, target: 'worksheets/sheet2.xml' },
			{ source: '/xl/workbook.xml', id: 'rIdStyles', type: stylesRelationship, target: 'styles.xml' },
			{ source: '/xl/workbook.xml', id: 'rIdStrings', type: sharedStringsRelationship, target: 'sharedStrings.xml' },
			...(overrides.extraRelationships ?? []),
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

async function createEffectiveStyleSnapshot() {
	const fixture = await createSemanticFixture({ worksheet: effectiveStyleWorksheetXml, styles: effectiveStylesXml });
	return parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None);
}

function rawSha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function recordWithExtraKeys<T extends object>(record: T, onRead: () => void): T {
	const expanded = { ...record };
	for (let index = 0; index < 128; index++) {
		Object.defineProperty(expanded, `attackerKey${index}`, { enumerable: true, value: index });
	}
	return new Proxy(expanded, {
		get: (target, property, receiver) => {
			onRead();
			return Reflect.get(target, property, receiver);
		},
	});
}

function trackArchiveReads(archive: IParadisOfficeArchive, reads: string[]): IParadisOfficeArchive {
	return {
		containerByteLength: archive.containerByteLength,
		entries: token => archive.entries(token),
		read: (entry, token) => {
			reads.push(entry.name);
			return archive.read(entry, token);
		},
		hash: bytes => archive.hash(bytes),
		parseXml: (xml, limits, token, checkpoint) => archive.parseXml(xml, limits, token, checkpoint),
		dispose: () => archive.dispose(),
	};
}

function withArchiveContainerLength(archive: IParadisOfficeArchive, containerByteLength: number): IParadisOfficeArchive {
	return {
		containerByteLength,
		entries: token => archive.entries(token),
		read: (entry, token) => archive.read(entry, token),
		hash: bytes => archive.hash(bytes),
		parseXml: (xml, limits, token, checkpoint) => archive.parseXml(xml, limits, token, checkpoint),
		dispose: () => archive.dispose(),
	};
}

function withEntryCompressedSize(
	archive: IParadisOfficeArchive,
	entryName: string,
	compressedBytes: number,
	onReadBytes: (bytes: number) => void,
): IParadisOfficeArchive {
	const originals = new WeakMap<object, Parameters<IParadisOfficeArchive['read']>[0]>();
	return {
		containerByteLength: archive.containerByteLength,
		async *entries(token) {
			for await (const original of archive.entries(token)) {
				const projected = original.name === entryName ? { ...original, compressedBytes } : original;
				originals.set(projected, original);
				yield projected;
			}
		},
		async *read(entry, token) {
			const original = originals.get(entry);
			if (!original) {
				throw new Error('unknown projected entry');
			}
			for await (const chunk of archive.read(original, token)) {
				for (let offset = 0; offset < chunk.byteLength; offset += 32) {
					const projected = chunk.slice(offset, Math.min(chunk.byteLength, offset + 32));
					if (entry.name === entryName) {
						onReadBytes(projected.byteLength);
					}
					yield projected;
				}
			}
		},
		hash: bytes => archive.hash(bytes),
		parseXml: (xml, limits, token, checkpoint) => archive.parseXml(xml, limits, token, checkpoint),
		dispose: () => archive.dispose(),
	};
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

async function overrideRelationshipContentType(bytes: Uint8Array, partName: string): Promise<Uint8Array> {
	const zip = await JSZip.loadAsync(bytes);
	const entry = zip.file('[Content_Types].xml');
	if (!entry) {
		throw new Error('missing Content Types');
	}
	const original = await entry.async('text');
	const changed = original.replace('</Types>', `<Override PartName="${partName}" ContentType="application/octet-stream"/></Types>`);
	zip.file('[Content_Types].xml', changed, { createFolders: false, date: entry.date });
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

function singleCellProjection(row: number, column: number, diagonal?: IParadisDiagonalBorder): IParadisWorkbookData {
	return {
		sheets: [{
			name: 'Matrix', minCol: column, columnCount: 1, columnWidths: [64], truncated: false,
			rows: [{ excelRow: row, height: 20, cells: [{ value: '', style: {}, ...(diagonal ? { diagonal } : {}) }] }],
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
			rawValue: { present: true, text: '1' },
			styleRef: 1,
			effectiveStyleRef: 1,
			effectiveStyleOrigin: 'cell',
			styleSource: { partId: '/xl/styles.xml', fingerprint: styleFingerprint },
		});
		deepStrictEqual(cells.get('A2'), { storedType: 'string', rawType: 's', rawValue: { present: true, text: '0' }, text: '1', sharedStringIndex: 0, effectiveStyleRef: 0, effectiveStyleOrigin: 'default', styleSource: { partId: '/xl/styles.xml', fingerprint: styleFingerprint } });
		deepStrictEqual(cells.get('A3'), { storedType: 'string', rawType: 'inlineStr', rawValue: { present: true, text: '' }, text: '', effectiveStyleRef: 0, effectiveStyleOrigin: 'default', styleSource: { partId: '/xl/styles.xml', fingerprint: styleFingerprint } });
		deepStrictEqual(cells.get('A4'), { storedType: 'blank', rawValue: { present: false }, effectiveStyleRef: 0, effectiveStyleOrigin: 'default', styleSource: { partId: '/xl/styles.xml', fingerprint: styleFingerprint } });
		deepStrictEqual(cells.get('A5'), { storedType: 'boolean', rawType: 'b', rawValue: { present: true, text: '1' }, effectiveStyleRef: 0, effectiveStyleOrigin: 'default', styleSource: { partId: '/xl/styles.xml', fingerprint: styleFingerprint } });
		deepStrictEqual(cells.get('B2'), {
			storedType: 'formula',
			rawValue: undefined,
			formula: { text: 'SUM(B3:B6)', kind: 'normal' },
			cachedResult: { present: true, type: 'number', rawValue: '1' },
			styleRef: 1,
			effectiveStyleRef: 1,
			effectiveStyleOrigin: 'cell',
			styleSource: { partId: '/xl/styles.xml', fingerprint: styleFingerprint },
		});
		deepStrictEqual(cells.get('B3'), {
			storedType: 'formula',
			rawValue: undefined,
			formula: { text: 'NOW()', kind: 'normal' },
			cachedResult: { present: false },
			effectiveStyleRef: 0,
			effectiveStyleOrigin: 'default',
			styleSource: { partId: '/xl/styles.xml', fingerprint: styleFingerprint },
		});
		deepStrictEqual(cells.get('B4')?.formula, { text: 'A1*2', kind: 'shared', ref: 'B4:B5', sharedIndex: 4 });
		deepStrictEqual(cells.get('B5')?.formula, { text: '', kind: 'shared', sharedIndex: 4 });
		deepStrictEqual(cells.get('B6')?.formula, { text: 'TRANSPOSE(A1:A2)', kind: 'array', ref: 'B6:B7' });
		deepStrictEqual(cells.get('B7'), { storedType: 'error', rawType: 'e', rawValue: { present: true, text: '#DIV/0!' }, effectiveStyleRef: 0, effectiveStyleOrigin: 'default', styleSource: { partId: '/xl/styles.xml', fingerprint: styleFingerprint } });
		deepStrictEqual(cells.get('B8'), { storedType: 'date', rawType: 'd', rawValue: { present: true, text: '2026-08-26T00:00:00Z' }, effectiveStyleRef: 0, effectiveStyleOrigin: 'default', styleSource: { partId: '/xl/styles.xml', fingerprint: styleFingerprint } });
		strictEqual(snapshot.date1904, true);
	});

	test('retains workbook, sheet, sparse string, view, row, column, merge, style, and completeness semantics', async () => {
		const fixture = await createSemanticFixture();
		const snapshot = await parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None);
		const styleFingerprint = { algorithm: 'sha256' as const, value: rawSha256(new TextEncoder().encode(stylesXml)), byteLength: new TextEncoder().encode(stylesXml).byteLength };

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
			storedType: 'string', rawType: 'inlineStr', rawValue: { present: true, text: 'rich text' }, text: 'rich text',
			richText: [{ text: 'rich', properties: { bold: true, color: { kind: 'rgb', rgb: 'FFFF0000' } } }, { text: ' text' }],
			effectiveStyleRef: 1, effectiveStyleOrigin: 'row', styleSource: { partId: '/xl/styles.xml', fingerprint: styleFingerprint },
		});
		deepStrictEqual(sheet.cells.get('D1'), {
			storedType: 'string', rawType: 's', rawValue: { present: true, text: '1' }, text: 'shared rich', sharedStringIndex: 1,
			richText: [{ text: 'shared', properties: { italic: true, color: { kind: 'theme', theme: 4, tint: '0.4' } } }, { text: ' rich' }],
			effectiveStyleRef: 1, effectiveStyleOrigin: 'row', styleSource: { partId: '/xl/styles.xml', fingerprint: styleFingerprint },
		});
		strictEqual(sheet.cells.has('E1'), false);
		deepStrictEqual(snapshot.styles.completeness, {
			declaredCellFormats: 2, parsedCellFormats: 2, declaredBorders: 2, parsedBorders: 2,
			cellsWithStyleRefs: 4, unresolvedStyleRefs: 0, cellsWithDiagonalStyleRefs: 6,
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
			deepStrictEqual(snapshot.styles.borders[1].diagonal, { style: 'dashDot', color: { kind: 'rgb', rgb: 'FFFF0000' } });
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
		deepStrictEqual(snapshot.sheets[0].cells.get('A1')?.rawValue, { present: true, text: '1' });
	});

	test('Node adapter owns inventory and projection deeply before opening its archive', async () => {
		const fixture = await createSemanticFixture();
		const mutableInventory: ParadisOfficeInventory = {
			...fixture.inventory,
			relationships: fixture.inventory.relationships.map(relationship => ({ ...relationship })),
		};
		const projectedCell = { value: '1', style: {} };
		const projection: IParadisWorkbookData = {
			sheets: [{
				name: 'Matrix', minCol: 1, columnCount: 1, columnWidths: [64], truncated: false,
				rows: [{ excelRow: 1, height: 20, cells: [projectedCell] }],
			}],
		};

		const parsing = parseSpreadsheetSemanticNode(fixture.bytes, mutableInventory, CancellationToken.None, { projection });
		Object.defineProperty(mutableInventory, 'relationships', {
			configurable: true,
			value: mutableInventory.relationships.map(relationship => relationship.id === 'rIdSheet1'
				? { ...relationship, target: '/xl/worksheets/sheet2.xml' }
				: relationship),
		});
		Object.defineProperty(projectedCell, 'value', { configurable: true, value: 'mutated-after-call' });

		const snapshot = await parsing;
		deepStrictEqual(snapshot.sheets[0].cells.get('A1')?.rawValue, { present: true, text: '1' });
		strictEqual(snapshot.projectionDiagnostics.some(diagnostic => diagnostic.kind === 'valueMismatch' && diagnostic.cellAddress === 'A1'), false);
	});

	test('Node adapter owns stable bytes before any inventory reflection', async () => {
		const fixture = await createSemanticFixture();
		const callerBytes = fixture.bytes.slice();
		const originalHash = rawSha256(callerBytes);
		let mutated = false;
		const inventory = new Proxy(fixture.inventory, {
			getOwnPropertyDescriptor: (target, property) => {
				if (!mutated) {
					mutated = true;
					callerBytes[0] ^= 0xff;
				}
				return Reflect.getOwnPropertyDescriptor(target, property);
			},
		});

		const snapshot = await parseSpreadsheetSemanticNode(callerBytes, inventory, CancellationToken.None);
		strictEqual(mutated, true);
		strictEqual(rawSha256(callerBytes) === originalHash, false);
		deepStrictEqual(snapshot.sheets[0].cells.get('A1')?.rawValue, { present: true, text: '1' });
		strictEqual(snapshot.styles.borders[1].diagonal?.style, 'dashDot');
		deepStrictEqual(snapshot.styles.borders[1].diagonal?.color, { kind: 'rgb', rgb: 'FFFF0000' });
	});

	test('Node adapter does not enumerate caller records with ownKeys', async () => {
		const fixture = await createSemanticFixture();
		let ownKeysCalls = 0;
		const inventory = new Proxy(fixture.inventory, {
			ownKeys: () => { ownKeysCalls++; throw new Error('/private/unbounded-own-keys'); },
		});
		const options = new Proxy({}, {
			ownKeys: () => { ownKeysCalls++; throw new Error('/private/unbounded-option-keys'); },
		});

		const snapshot = await parseSpreadsheetSemanticNode(fixture.bytes, inventory, CancellationToken.None, options);
		deepStrictEqual(snapshot.sheets.map(sheet => sheet.name), ['Matrix', 'Archive']);
		strictEqual(ownKeysCalls, 0);
	});

	test('Node adapter sanitizes ownership errors before raw Proxy details escape', async () => {
		const fixture = await createSemanticFixture();
		const inventory = new Proxy(fixture.inventory, {
			getOwnPropertyDescriptor: (target, property) => {
				if (property === 'format') { throw new Error('/private/node/ownership-secret'); }
				return Reflect.getOwnPropertyDescriptor(target, property);
			},
		});

		await rejects(
			parseSpreadsheetSemanticNode(fixture.bytes, inventory, CancellationToken.None),
			error => error instanceof ParadisOfficePackageError
				&& error.message === 'invalid'
				&& !error.stack?.includes('ownership-secret'),
		);

		const poisoned = new ParadisOfficePackageError('zipBomb');
		poisoned.stack = '/private/node/poisoned-package-error';
		Object.defineProperty(poisoned, 'secret', { value: '/private/node/custom-field' });
		const poisonedInventory = new Proxy(fixture.inventory, {
			getOwnPropertyDescriptor: (target, property) => {
				if (property === 'format') { throw poisoned; }
				return Reflect.getOwnPropertyDescriptor(target, property);
			},
		});
		await rejects(
			parseSpreadsheetSemanticNode(fixture.bytes, poisonedInventory, CancellationToken.None),
			error => error instanceof ParadisOfficePackageError
				&& error !== poisoned
				&& error.code === 'zipBomb'
				&& !error.stack?.includes('poisoned-package-error')
				&& !Object.hasOwn(error, 'secret'),
		);
	});

	test('sanitizer contains poisoned Proxy introspection traps', () => {
		const poisoned = new ParadisOfficePackageError('zipBomb');
		for (const proxy of [
			new Proxy(poisoned, { getPrototypeOf: () => { throw new Error('/private/get-prototype-secret'); } }),
			new Proxy(poisoned, { getOwnPropertyDescriptor: () => { throw new Error('/private/get-descriptor-secret'); } }),
		]) {
			const sanitized = sanitizeSpreadsheetPackageError(proxy);
			strictEqual(sanitized instanceof ParadisOfficePackageError, true);
			strictEqual(sanitized.code, 'invalid');
			strictEqual(sanitized.stack?.includes('/private/'), false);
		}
	});

	test('Node adapter binds parsing to its actual desktop execution profile', async () => {
		const fixture = await createSemanticFixture();
		const forgedInventory: ParadisOfficeInventory = { ...fixture.inventory, budgetProfile: 'browser' };

		await rejects(
			parseSpreadsheetSemanticNode(fixture.bytes, forgedInventory, CancellationToken.None),
			/unsafe/,
		);
	});

	test('Node adapter accepts an explicitly bound remote execution profile', async () => {
		const fixture = await createSemanticFixture();
		const remoteInventory: ParadisOfficeInventory = { ...fixture.inventory, budgetProfile: 'remoteMobile' };

		const snapshot = await parseSpreadsheetSemanticNode(
			fixture.bytes,
			remoteInventory,
			CancellationToken.None,
			{},
			'remoteMobile',
		);
		deepStrictEqual(snapshot.sheets.map(sheet => sheet.name), ['Matrix', 'Archive']);

		await rejects(
			parseSpreadsheetSemanticNode(fixture.bytes, fixture.inventory, CancellationToken.None, {}, 'remoteMobile'),
			/unsafe/,
		);
		const oversizedRemoteInventory: ParadisOfficeInventory = {
			...remoteInventory,
			parts: Array.from({ length: PARADIS_OFFICE_BUDGET_PROFILES.remoteMobile.entryCount + 1 }, (_, index) => ({
				...remoteInventory.parts[0], id: `/remote-part-${index}.xml`, canonicalUri: `/remote-part-${index}.xml`,
			})),
		};
		await rejects(
			parseSpreadsheetSemanticNode(fixture.bytes, oversizedRemoteInventory, CancellationToken.None, {}, 'remoteMobile'),
			/limitExceeded/,
		);
	});

	test('Node adapter uses intrinsic byte identity and rejects its compressed byte limit plus one', async () => {
		const fixture = await createSemanticFixture();
		let byteLengthReads = 0;
		let sliceCalls = 0;
		class PoisonedBytes extends Uint8Array {
			override get byteLength(): number { byteLengthReads++; return 1; }
			override slice(_start?: number, _end?: number): Uint8Array<ArrayBuffer> { sliceCalls++; return this; }
		}
		await rejects(parseSpreadsheetSemanticNode(new PoisonedBytes(fixture.bytes), fixture.inventory), /invalid/);
		strictEqual(byteLengthReads, 0);
		strictEqual(sliceCalls, 0);

		const oversized = new Uint8Array(PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal.compressedInputBytes + 1);
		await rejects(
			parseSpreadsheetSemanticNode(oversized, fixture.inventory),
			error => error instanceof ParadisOfficePackageError && error.code === 'limitExceeded',
		);
	});

	test('Node adapter rejects unstable or caller-programmable byte stores before reflection', async () => {
		const fixture = await createSemanticFixture();
		let inventoryReads = 0;
		const inventory = new Proxy(fixture.inventory, {
			getOwnPropertyDescriptor: (target, property) => {
				inventoryReads++;
				return Reflect.getOwnPropertyDescriptor(target, property);
			},
		});
		const invalidBytes: Uint8Array[] = [];
		if (typeof SharedArrayBuffer !== 'undefined') {
			const shared = new Uint8Array(new SharedArrayBuffer(fixture.bytes.byteLength));
			shared.set(fixture.bytes);
			invalidBytes.push(shared);
		}
		const resizableBuffer = new ArrayBuffer(fixture.bytes.byteLength, { maxByteLength: fixture.bytes.byteLength + 1024 });
		const resizable = new Uint8Array(resizableBuffer);
		resizable.set(fixture.bytes);
		invalidBytes.push(resizable);
		const detachedBuffer = fixture.bytes.slice().buffer;
		const detached = new Uint8Array(detachedBuffer);
		structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
		invalidBytes.push(detached);
		for (const ownKey of ['constructor', 'byteLength', 'slice'] as const) {
			const bytes = fixture.bytes.slice();
			Object.defineProperty(bytes, ownKey, { value: ownKey === 'constructor' ? { [Symbol.species]: () => bytes } : undefined });
			invalidBytes.push(bytes);
		}
		const ownSpecies = fixture.bytes.slice();
		Object.defineProperty(ownSpecies, Symbol.species, { value: () => ownSpecies });
		invalidBytes.push(ownSpecies);

		for (const bytes of invalidBytes) {
			await rejects(parseSpreadsheetSemanticNode(bytes, inventory), /invalid/);
		}
		strictEqual(inventoryReads, 0);
	});

	test('rejects prototype-key and unknown runtime budget profiles', async () => {
		const fixture = await createSemanticFixture();
		for (const value of ['__proto__', 'constructor', 'unknown']) {
			const inventory = { ...fixture.inventory };
			Object.defineProperty(inventory, 'budgetProfile', { enumerable: true, value });
			await rejects(
				parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), inventory, CancellationToken.None, { deadlineMilliseconds: 1 }),
				/unsafe/,
			);
		}
	});

	test('rejects inventory and option accessors without invoking them', async () => {
		const fixture = await createSemanticFixture();
		let inventoryGetterReads = 0;
		const accessorInventory = { ...fixture.inventory };
		Object.defineProperty(accessorInventory, 'budgetProfile', {
			enumerable: true,
			get: () => {
				inventoryGetterReads++;
				return 'desktopLocal';
			},
		});
		await rejects(
			parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), accessorInventory, CancellationToken.None),
			/unsafe/,
		);
		strictEqual(inventoryGetterReads, 0);

		let optionGetterReads = 0;
		const accessorOptions = {};
		Object.defineProperty(accessorOptions, 'projection', {
			enumerable: true,
			get: () => {
				optionGetterReads++;
				return undefined;
			},
		});
		await rejects(
			parseSpreadsheetSemanticNode(fixture.bytes, fixture.inventory, CancellationToken.None, accessorOptions),
			/unsafe/,
		);
		strictEqual(optionGetterReads, 0);
	});

	test('common parser owns projection before its first archive await', async () => {
		const fixture = await createSemanticFixture();
		const projectedStyle = { color: '#123456', fontWeight: '700' };
		const projectedDiagonal: IParadisDiagonalBorder = {
			up: true, down: true, style: '1px solid', color: '#ff0000', rawStyle: 'dashDot', rawColor: { kind: 'rgb', rgb: 'FFFF0000' },
		};
		const projectedCell = {
			value: '1', style: projectedStyle, colSpan: 2, rowSpan: 3, hidden: true, wrapText: true, verticalText: true, shrinkToFit: true,
			richText: [{ text: 'rich', style: { color: '#abcdef', fontStyle: 'italic' } }],
			diagonal: projectedDiagonal,
			dataValidation: { type: 'list' as const, formulae: ['"A,B"'], allowBlank: true },
		};
		const projection: IParadisWorkbookData = {
			sheets: [{
				name: 'Matrix', minCol: 1, columnCount: 1, columnWidths: [64], truncated: false,
				rows: [{ excelRow: 1, height: 20, cells: [projectedCell] }], showGridLines: false, zoomScale: 125, tabColor: '#ff00ff', protectedSheet: true,
				rowBreaks: [4], colBreaks: [2], printArea: { minR: 1, maxR: 10, minC: 1, maxC: 4 },
				dataValidations: [{ range: { minR: 1, maxR: 1, minC: 1, maxC: 1 }, validation: { type: 'list', formulae: ['"A,B"'], allowBlank: true } }],
				shapes: [{ type: 'line', flipV: false, flipH: false, from: { c: 0, co: 1, r: 0, ro: 2 }, to: { c: 1, co: 3, r: 1, ro: 4 }, outlineWidth: 1, outlineColor: '#000000', dash: 'solid', name: 'line' }],
			}],
			drawingsBySheet: { 1: [{ xml: '<drawing/>', media: { rId1: 'data:image/png;base64,AA==' } }] },
			themeColors: { accent1: '#112233' },
		};
		const parsing = parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None, { projection });
		Object.defineProperty(projectedCell, 'value', { configurable: true, value: 'mutated-after-call' });
		projectedStyle.color = '#000000';
		(projection.sheets[0].columnWidths as number[])[0] = 999;

		const snapshot = await parsing;
		strictEqual(snapshot.projectionDiagnostics.some(diagnostic => diagnostic.kind === 'valueMismatch' && diagnostic.cellAddress === 'A1'), false);
		const rendered = snapshot.renderProjection!;
		strictEqual(rendered.sheets[0].rows[0].cells[0].value, '1.000');
		deepStrictEqual(rendered.sheets[0].rows[0].cells[0].style, { color: '#123456', fontWeight: '700' });
		strictEqual(rendered.sheets[0].rows[0].cells[0].colSpan, 2);
		strictEqual(rendered.sheets[0].rows[0].cells[0].rowSpan, 3);
		strictEqual(rendered.sheets[0].rows[0].cells[0].hidden, true);
		strictEqual(rendered.sheets[0].rows[0].cells[0].wrapText, true);
		deepStrictEqual(rendered.sheets[0].rows[0].cells[0].richText, projectedCell.richText);
		deepStrictEqual(rendered.sheets[0].rows[0].cells[0].dataValidation, projectedCell.dataValidation);
		deepStrictEqual(rendered.sheets[0].rows[0].cells[0].diagonal, projectedDiagonal);
		deepStrictEqual(rendered.sheets[0].columnWidths, [64]);
		deepStrictEqual(rendered.sheets[0].shapes, projection.sheets[0].shapes);
		deepStrictEqual(rendered.sheets[0].dataValidations, projection.sheets[0].dataValidations);
		deepStrictEqual(rendered.drawingsBySheet, projection.drawingsBySheet);
		deepStrictEqual(rendered.themeColors, projection.themeColors);
	});

	test('freezes the publicly returned owned input before registering its no-copy marker', async () => {
		const fixture = await createSemanticFixture();
		const projection = singleCellProjection(1, 1);
		const owned = ownSpreadsheetSemanticInput(fixture.inventory, { projection }, CancellationToken.None);

		strictEqual(Object.isFrozen(owned.inventory), true);
		strictEqual(Object.isFrozen(owned.inventory.parts), true);
		strictEqual(Object.isFrozen(owned.options), true);
		strictEqual(Object.isFrozen(owned.options.projection?.sheets[0].rows[0].cells[0]), true);
		throws(() => Object.defineProperty(owned.inventory, 'relationships', { value: [] }), TypeError);
		const snapshot = await parseSpreadsheetSemantic(
			await createParadisOfficeNodeArchive(fixture.bytes), owned.inventory, CancellationToken.None, owned.options,
		);
		deepStrictEqual(snapshot.sheets.map(sheet => sheet.name), ['Matrix', 'Archive']);
	});

	test('consumes the owned marker without taking a second ownership snapshot', async () => {
		const fixture = await createSemanticFixture();
		const owned = ownSpreadsheetSemanticInput(fixture.inventory, {}, CancellationToken.None);
		let cancellationChecks = 0;
		const token: CancellationToken = {
			get isCancellationRequested() { cancellationChecks++; return false; },
			onCancellationRequested: Event.None,
		};
		const archive = withArchiveContainerLength(await createParadisOfficeNodeArchive(fixture.bytes), fixture.bytes.byteLength + 1);

		await rejects(parseSpreadsheetSemantic(archive, owned.inventory, token, owned.options), /unsafe/);
		strictEqual(cancellationChecks, 1);
	});

	test('checks cancellation during the owned graph freeze pass', async () => {
		const fixture = await createSemanticFixture();
		let snapshotFinished = false;
		const cell = new Proxy({ value: '1', style: {} }, {
			getOwnPropertyDescriptor: (target, property) => {
				const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
				if (property === 'style') {
					snapshotFinished = true;
				}
				return descriptor;
			},
		});
		const token: CancellationToken = {
			get isCancellationRequested() { return snapshotFinished; },
			onCancellationRequested: Event.None,
		};
		const projection: IParadisWorkbookData = {
			sheets: [{
				name: 'Matrix', minCol: 1, columnCount: 1, columnWidths: [], truncated: false,
				rows: [{ excelRow: 1, height: 20, cells: [cell] }],
			}],
		};

		await rejects(
			Promise.resolve().then(() => ownSpreadsheetSemanticInput(fixture.inventory, { projection }, token)),
			/cancelled/,
		);
		strictEqual(snapshotFinished, true);
	});

	test('owns render style and width graphs without invoking caller getters', async () => {
		const fixture = await createSemanticFixture();
		let unusedReads = 0;
		const unusedStyle = new Proxy({ color: '#123456' }, {
			get: (target, property, receiver) => {
				unusedReads++;
				return Reflect.get(target, property, receiver);
			},
		});
		const widths = new Proxy([64], {
			get: (target, property, receiver) => {
				if (property !== 'length') {
					unusedReads++;
				}
				return Reflect.get(target, property, receiver);
			},
		});
		const feature = new Proxy(fixture.inventory.features[0] ?? { kind: 'unused', count: 0, partIds: [], safety: 'safe' as const }, {
			get: (target, property, receiver) => {
				unusedReads++;
				return Reflect.get(target, property, receiver);
			},
		});
		const inventory: ParadisOfficeInventory = { ...fixture.inventory, features: [feature] };
		const projection: IParadisWorkbookData = {
			sheets: [{
				name: 'Matrix', minCol: 1, columnCount: 1, columnWidths: widths, truncated: false,
				rows: [{ excelRow: 1, height: 20, cells: [{ value: '1', style: unusedStyle }] }],
			}],
		};

		const snapshot = await parseSpreadsheetSemantic(
			await createParadisOfficeNodeArchive(fixture.bytes), inventory, CancellationToken.None, { projection },
		);
		strictEqual(unusedReads, 0);
		deepStrictEqual(snapshot.renderProjection?.sheets[0].rows[0].cells[0].style, { color: '#123456' });
		deepStrictEqual(snapshot.renderProjection?.sheets[0].columnWidths, [64]);
	});

	test('keeps raw value container absence separate from present empty content and blank cells', async () => {
		const worksheet = `<worksheet xmlns="${spreadsheetNamespace}"><dimension ref="A1:F1"/><sheetData><row r="1">
			<c r="A1" t="n"/><c r="B1" t="str"/><c r="C1" t="str"><v/></c>
			<c r="D1" t="inlineStr"/><c r="E1" t="inlineStr"><is/></c><c r="F1"/>
		</row></sheetData></worksheet>`;
		const fixture = await createSemanticFixture({ worksheet });
		const snapshot = await parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None);
		const cells = snapshot.sheets[0].cells;

		deepStrictEqual([cells.get('A1')?.storedType, cells.get('A1')?.rawType, cells.get('A1')?.rawValue, cells.get('A1')?.text], ['number', 'n', { present: false }, undefined]);
		deepStrictEqual([cells.get('B1')?.storedType, cells.get('B1')?.rawType, cells.get('B1')?.rawValue, cells.get('B1')?.text], ['string', 'str', { present: false }, undefined]);
		deepStrictEqual([cells.get('C1')?.storedType, cells.get('C1')?.rawType, cells.get('C1')?.rawValue, cells.get('C1')?.text], ['string', 'str', { present: true, text: '' }, '']);
		deepStrictEqual([cells.get('D1')?.storedType, cells.get('D1')?.rawType, cells.get('D1')?.rawValue, cells.get('D1')?.text], ['string', 'inlineStr', { present: false }, undefined]);
		deepStrictEqual([cells.get('E1')?.storedType, cells.get('E1')?.rawType, cells.get('E1')?.rawValue, cells.get('E1')?.text], ['string', 'inlineStr', { present: true, text: '' }, '']);
		deepStrictEqual([cells.get('F1')?.storedType, cells.get('F1')?.rawType, cells.get('F1')?.rawValue, cells.get('F1')?.text], ['blank', undefined, { present: false }, undefined]);
	});

	test('derives an omitted cell reference from the previous cell column', async () => {
		const worksheet = `<worksheet xmlns="${spreadsheetNamespace}"><dimension ref="B1:D1"/><sheetData><row r="1">
			<c r="B1"><v>1</v></c><c><v>2</v></c><c t="str"><v>three</v></c>
		</row></sheetData></worksheet>`;
		const fixture = await createSemanticFixture({ worksheet });
		const snapshot = await parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None);

		deepStrictEqual([...snapshot.sheets[0].cells.keys()], ['B1', 'C1', 'D1']);
		deepStrictEqual(snapshot.sheets[0].cells.get('C1')?.rawValue, { present: true, text: '2' });
		deepStrictEqual(snapshot.sheets[0].cells.get('D1')?.rawValue, { present: true, text: 'three' });
	});

	test('uses explicit cell style ahead of row and column styles', async () => {
		const cells = (await createEffectiveStyleSnapshot()).sheets[0].cells;
		deepStrictEqual([cells.get('C1')?.styleRef, cells.get('C1')?.effectiveStyleRef, cells.get('C1')?.effectiveStyleOrigin], [3, 3, 'cell']);
	});

	test('uses row style ahead of an intersecting column style', async () => {
		const cells = (await createEffectiveStyleSnapshot()).sheets[0].cells;
		deepStrictEqual([cells.get('B1')?.styleRef, cells.get('B1')?.effectiveStyleRef, cells.get('B1')?.effectiveStyleOrigin], [undefined, 2, 'row']);
	});

	test('ignores row style when customFormat is false or absent', async () => {
		const worksheet = `<worksheet xmlns="${spreadsheetNamespace}"><dimension ref="A1:B1"/><cols><col min="2" max="2" style="1"/></cols><sheetData><row r="1" s="2"><c r="A1"/><c r="B1"/></row></sheetData></worksheet>`;
		const fixture = await createSemanticFixture({ worksheet, styles: effectiveStylesXml });
		const cells = (await parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None)).sheets[0].cells;

		deepStrictEqual([cells.get('A1')?.effectiveStyleRef, cells.get('A1')?.effectiveStyleOrigin], [0, 'default']);
		deepStrictEqual([cells.get('B1')?.effectiveStyleRef, cells.get('B1')?.effectiveStyleOrigin], [1, 'column']);
	});

	test('uses row cellXf zero when customFormat is true and row s is absent', async () => {
		const worksheet = `<worksheet xmlns="${spreadsheetNamespace}"><dimension ref="A1:B1"/><cols><col min="2" max="2" style="1"/></cols><sheetData><row r="1" customFormat="1" hidden="1"><c r="A1"/><c r="B1"/></row></sheetData></worksheet>`;
		const fixture = await createSemanticFixture({ worksheet, styles: effectiveStylesXml });
		const snapshot = await parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None);
		const cell = snapshot.sheets[0].cells.get('B1');

		deepStrictEqual([snapshot.sheets[0].rows.get(1)?.hidden, cell?.storedType, cell?.styleRef, cell?.effectiveStyleRef, cell?.effectiveStyleOrigin], [true, 'blank', undefined, 0, 'row']);
		const diagnostics = diagnoseSpreadsheetProjection(snapshot, singleCellProjection(1, 2, {
			up: false, down: true, style: '2px solid', color: '#000000', rawStyle: 'medium', rawColor: { kind: 'theme', theme: 4, tint: '0.2' },
		}));
		deepStrictEqual(diagnostics.filter(diagnostic => diagnostic.cellAddress === 'B1').map(diagnostic => diagnostic.kind), [
			'diagonalDirectionMismatch', 'diagonalStyleMismatch', 'diagonalColorMismatch',
		]);
	});

	test('inherits column style when cell and row styles are absent', async () => {
		const cells = (await createEffectiveStyleSnapshot()).sheets[0].cells;
		deepStrictEqual([cells.get('B2')?.styleRef, cells.get('B2')?.effectiveStyleRef, cells.get('B2')?.effectiveStyleOrigin], [undefined, 1, 'column']);
	});

	test('inherits default cellXf zero when cell, row, and column styles are absent', async () => {
		const cells = (await createEffectiveStyleSnapshot()).sheets[0].cells;
		deepStrictEqual([cells.get('A2')?.styleRef, cells.get('A2')?.effectiveStyleRef, cells.get('A2')?.effectiveStyleOrigin], [undefined, 0, 'default']);
	});

	test('retains rgb, theme, indexed, and auto diagonal color provenance', async () => {
		const snapshot = await createEffectiveStyleSnapshot();
		deepStrictEqual(snapshot.styles.borders.map(border => border.diagonal?.color), [
			{ kind: 'rgb', rgb: 'FF112233' },
			{ kind: 'theme', theme: 4, tint: '0.2' },
			{ kind: 'indexed', indexed: 7 },
			{ kind: 'auto', auto: true },
			undefined,
		]);
	});

	test('reports a raw diagonal style-only mismatch without CSS token collapse', async () => {
		const snapshot = await createEffectiveStyleSnapshot();
		const styleOnly = diagnoseSpreadsheetProjection(snapshot, singleCellProjection(2, 1, {
			up: true, down: false, style: '1px solid', color: '#112233',
			rawStyle: 'medium', rawColor: { kind: 'rgb', rgb: 'FF112233' },
		}));
		deepStrictEqual(styleOnly.filter(diagnostic => diagnostic.cellAddress === 'A2').map(diagnostic => diagnostic.kind), ['diagonalStyleMismatch']);
		deepStrictEqual(styleOnly.find(diagnostic => diagnostic.cellAddress === 'A2')?.semanticDiagonal, {
			up: true, down: false, style: 'thin', color: { kind: 'rgb', rgb: 'FF112233' },
		});
	});

	test('reports a full ARGB-only diagonal color mismatch', async () => {
		const snapshot = await createEffectiveStyleSnapshot();
		const colorOnly = diagnoseSpreadsheetProjection(snapshot, singleCellProjection(2, 1, {
			up: true, down: false, style: '1px solid', color: '#112233',
			rawStyle: 'thin', rawColor: { kind: 'rgb', rgb: '00112233' },
		}));
		deepStrictEqual(colorOnly.filter(diagnostic => diagnostic.cellAddress === 'A2').map(diagnostic => diagnostic.kind), ['diagonalColorMismatch']);
	});

	test('retains tint provenance for rgb, indexed, and auto diagonal colors', async () => {
		const styles = `<styleSheet xmlns="${spreadsheetNamespace}"><borders count="3">
			<border diagonalUp="1"><diagonal style="thin"><color rgb="FF112233" tint="0.1"/></diagonal></border>
			<border diagonalUp="1"><diagonal style="thin"><color indexed="7" tint="0.2"/></diagonal></border>
			<border diagonalUp="1"><diagonal style="thin"><color auto="1" tint="0.3"/></diagonal></border>
		</borders><cellXfs count="3"><xf borderId="0"/><xf borderId="1"/><xf borderId="2"/></cellXfs></styleSheet>`;
		const fixture = await createSemanticFixture({ styles });
		const snapshot = await parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None);

		deepStrictEqual(snapshot.styles.borders.map(border => border.diagonal?.color), [
			{ kind: 'rgb', rgb: 'FF112233', tint: '0.1' },
			{ kind: 'indexed', indexed: 7, tint: '0.2' },
			{ kind: 'auto', auto: true, tint: '0.3' },
		]);
	});

	test('reports direction, raw style, and raw color mismatches without returning early', async () => {
		const snapshot = await createEffectiveStyleSnapshot();
		const allDifferent = diagnoseSpreadsheetProjection(snapshot, singleCellProjection(1, 1, {
			up: true, down: false, style: '1px dashed', color: '#FFFFFF',
			rawStyle: 'dashed', rawColor: { kind: 'rgb', rgb: 'FFFFFFFF' },
		}));
		deepStrictEqual(allDifferent.filter(diagnostic => diagnostic.cellAddress === 'A1').map(diagnostic => diagnostic.kind), [
			'diagonalDirectionMismatch', 'diagonalStyleMismatch', 'diagonalColorMismatch',
		]);
	});

	test('reports semantic-only diagonal presence', async () => {
		const snapshot = await createEffectiveStyleSnapshot();
		const semanticOnly = diagnoseSpreadsheetProjection(snapshot, singleCellProjection(2, 1));
		deepStrictEqual(semanticOnly.filter(diagnostic => diagnostic.cellAddress === 'A2').map(diagnostic => diagnostic.kind), ['diagonalPresenceMismatch']);
	});

	test('reports projection-only diagonal presence', async () => {
		const snapshot = await createEffectiveStyleSnapshot();
		const projectionOnly = diagnoseSpreadsheetProjection(snapshot, singleCellProjection(1, 5, {
			up: true, down: false, style: '1px solid', color: '#112233',
			rawStyle: 'thin', rawColor: { kind: 'rgb', rgb: 'FF112233' },
		}));
		deepStrictEqual(projectionOnly.filter(diagnostic => diagnostic.cellAddress === 'E1').map(diagnostic => diagnostic.kind), ['diagonalPresenceMismatch']);
	});

	test('accepts exact inherited theme diagonal provenance', async () => {
		const snapshot = await createEffectiveStyleSnapshot();
		const exactTheme = diagnoseSpreadsheetProjection(snapshot, singleCellProjection(2, 2, {
			up: false, down: true, style: '2px solid', color: '#000000',
			rawStyle: 'medium', rawColor: { kind: 'theme', theme: 4, tint: '0.2' },
		}));
		strictEqual(exactTheme.some(diagnostic => diagnostic.cellAddress === 'B2'), false);
	});

	test('rejects duplicate border edges including diagonal', async () => {
		for (const edge of ['start', 'end', 'left', 'right', 'top', 'bottom', 'diagonal', 'vertical', 'horizontal']) {
			const styles = `<styleSheet xmlns="${spreadsheetNamespace}"><borders count="1"><border><${edge}/><${edge}/></border></borders><cellXfs count="1"><xf borderId="0"/></cellXfs></styleSheet>`;
			const fixture = await createSemanticFixture({ styles });
			await rejects(
				parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None),
				/malformed/,
			);
		}
	});

	test('validates raw relationship authority before reading a forged inventory target', async () => {
		const sentinelXml = `<worksheet xmlns="${spreadsheetNamespace}"><sheetData>${'x'.repeat(256 * 1024)}</sheetData></worksheet>`;
		const fixture = await createSemanticFixture({
			extraParts: [['/xl/worksheets/sentinel.xml', sentinelXml, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml']],
		});
		const forgedInventory: ParadisOfficeInventory = {
			...fixture.inventory,
			relationships: fixture.inventory.relationships.map(relationship => relationship.id === 'rIdSheet1'
				? { ...relationship, target: '/xl/worksheets/sentinel.xml' }
				: relationship),
		};
		const reads: string[] = [];
		const archive = trackArchiveReads(await createParadisOfficeNodeArchive(fixture.bytes), reads);

		await rejects(parseSpreadsheetSemantic(archive, forgedInventory, CancellationToken.None), /unsafe/);
		strictEqual(reads.includes('xl/worksheets/sentinel.xml'), false);
	});

	test('does not read worksheet relationships absent from the raw workbook sheet list', async () => {
		const sentinelXml = `<worksheet xmlns="${spreadsheetNamespace}"><sheetData>${'x'.repeat(256 * 1024)}</sheetData></worksheet>`;
		const fixture = await createSemanticFixture({
			extraParts: [['/xl/worksheets/unreferenced.xml', sentinelXml, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml']],
			extraRelationships: [{ source: '/xl/workbook.xml', id: 'rIdUnreferenced', type: worksheetRelationship, target: 'worksheets/unreferenced.xml' }],
		});
		const reads: string[] = [];
		const archive = trackArchiveReads(await createParadisOfficeNodeArchive(fixture.bytes), reads);

		await parseSpreadsheetSemantic(archive, fixture.inventory, CancellationToken.None);
		strictEqual(reads.includes('xl/worksheets/unreferenced.xml'), false);
	});

	test('checkpoints the bounded workbook relationship fanout', async () => {
		const countCancellationChecks = async (fixture: SemanticFixture): Promise<number> => {
			const owned = ownSpreadsheetSemanticInput(fixture.inventory, {}, CancellationToken.None);
			let checks = 0;
			const token: CancellationToken = {
				get isCancellationRequested() { checks++; return false; },
				onCancellationRequested: Event.None,
			};
			await parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), owned.inventory, token, owned.options);
			return checks;
		};
		const baselineChecks = await countCancellationChecks(await createSemanticFixture());
		const noisyFixture = await createSemanticFixture({
			extraRelationships: Array.from({ length: 512 }, (_, index) => ({
				source: '/xl/workbook.xml', id: `rIdNoise${index}`, type: 'urn:para-code:test/noise',
				target: `https://invalid.example/${index}`, targetMode: 'External' as const,
			})),
		});
		const noisyChecks = await countCancellationChecks(noisyFixture);
		strictEqual(noisyChecks - baselineChecks >= 55, true);
	});

	test('rejects oversized inventory arrays before cloning and ignores unprojected keys', async () => {
		const fixture = await createSemanticFixture();
		let partReads = 0;
		const observedPart = new Proxy(fixture.inventory.parts[0], {
			get: (target, property, receiver) => {
				partReads++;
				return Reflect.get(target, property, receiver);
			},
		});
		const oversizedParts: ParadisOfficeInventory = {
			...fixture.inventory,
			parts: new Proxy(Array.from({ length: PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal.entryCount + 1 }, () => observedPart), {
				ownKeys: target => {
					partReads++;
					return Reflect.ownKeys(target);
				},
			}),
		};

		await rejects(
			parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), oversizedParts, CancellationToken.None),
			/limitExceeded/,
		);
		strictEqual(partReads, 0);

		const oversizedRelationships: ParadisOfficeInventory = {
			...fixture.inventory,
			relationships: Array.from({ length: 100_001 }, () => fixture.inventory.relationships[0]),
		};
		await rejects(
			parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), oversizedRelationships, CancellationToken.None),
			/limitExceeded/,
		);

		let unknownReads = 0;
		const oversizedKeys = { ...fixture.inventory };
		for (let index = 0; index < 64; index++) {
			Object.defineProperty(oversizedKeys, `attackerKey${index}`, { enumerable: true, get: () => { unknownReads++; throw new Error('must not read'); } });
		}
		await parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), oversizedKeys, CancellationToken.None);
		strictEqual(unknownReads, 0);
	});

	test('does not enumerate oversized unprojected nested record keys', async () => {
		const fixture = await createSemanticFixture();
		let reads = 0;
		const inventory: ParadisOfficeInventory = {
			...fixture.inventory,
			security: recordWithExtraKeys(fixture.inventory.security, () => reads++),
		};

		await parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), inventory, CancellationToken.None);
		strictEqual(reads, 0);
	});

	test('rejects shared projection object references', async () => {
		const fixture = await createSemanticFixture();
		const sharedCell = { value: '1', style: {} };
		const projection: IParadisWorkbookData = {
			sheets: [{
				name: 'Matrix', minCol: 1, columnCount: 2, columnWidths: [], truncated: false,
				rows: [{ excelRow: 1, height: 20, cells: [sharedCell, sharedCell] }],
			}],
		};

		await rejects(
			parseSpreadsheetSemanticNode(fixture.bytes, fixture.inventory, CancellationToken.None, { projection }),
			/unsafe/,
		);
	});

	test('rejects shared nested render projection objects', async () => {
		const fixture = await createSemanticFixture();
		const sharedStyle = { color: '#123456' };
		const projection: IParadisWorkbookData = {
			sheets: [{
				name: 'Matrix', minCol: 1, columnCount: 2, columnWidths: [64, 64], truncated: false,
				rows: [{ excelRow: 1, height: 20, cells: [{ value: '1', style: sharedStyle }, { value: '2', style: sharedStyle }] }],
			}],
		};
		throws(() => ownSpreadsheetSemanticInput(fixture.inventory, { projection }, CancellationToken.None), /unsafe/);
	});

	test('rejects sparse and accessor-backed projection arrays', async () => {
		const fixture = await createSemanticFixture();
		const sparseRows: IParadisWorkbookData['sheets'][number]['rows'][number][] = [];
		sparseRows.length = 2;
		sparseRows[1] = { excelRow: 2, height: 20, cells: [] };
		const accessorCells: IParadisWorkbookData['sheets'][number]['rows'][number]['cells'][number][] = [];
		Object.defineProperty(accessorCells, '0', { enumerable: true, get: () => ({ value: '1', style: {} }) });
		accessorCells.length = 1;
		for (const rows of [
			sparseRows,
			[{ excelRow: 1, height: 20, cells: accessorCells }],
		]) {
			const projection: IParadisWorkbookData = {
				sheets: [{ name: 'Matrix', minCol: 1, columnCount: 1, columnWidths: [], truncated: false, rows }],
			};
			await rejects(
				parseSpreadsheetSemanticNode(fixture.bytes, fixture.inventory, CancellationToken.None, { projection }),
				/unsafe/,
			);
		}
	});

	test('does not enumerate or read an unknown projection key', async () => {
		const fixture = await createSemanticFixture();
		let unknownReads = 0;
		const cell = { value: '1', style: {} };
		Object.defineProperty(cell, 'attackerKey', { enumerable: true, get: () => { unknownReads++; throw new Error('must not read'); } });
		const projection: IParadisWorkbookData = {
			sheets: [{
				name: 'Matrix', minCol: 1, columnCount: 1, columnWidths: [], truncated: false,
				rows: [{ excelRow: 1, height: 20, cells: [cell] }],
			}],
		};

		await parseSpreadsheetSemanticNode(fixture.bytes, fixture.inventory, CancellationToken.None, { projection });
		strictEqual(unknownReads, 0);
	});

	test('enforces the aggregate ownership node budget across an otherwise bounded graph', async () => {
		const fixture = await createSemanticFixture();
		const rows = Array.from({ length: 250_001 }, (_, index) => ({ excelRow: index + 1, height: 20, cells: [] }));
		const projection: IParadisWorkbookData = {
			sheets: [{ name: 'Matrix', minCol: 1, columnCount: 0, columnWidths: [], truncated: false, rows }],
		};

		await rejects(
			Promise.resolve().then(() => ownSpreadsheetSemanticInput(fixture.inventory, { projection }, CancellationToken.None)),
			/limitExceeded/,
		);
	});

	test('rejects a dense ownership array before enumerating its keys', async () => {
		const fixture = await createSemanticFixture();
		let ownKeysCalls = 0;
		const denseCells = new Proxy(Array.from({ length: 1_000_001 }, () => ({ value: '1', style: {} })), {
			ownKeys: target => {
				ownKeysCalls++;
				return Reflect.ownKeys(target);
			},
		});
		const projection: IParadisWorkbookData = {
			sheets: [{
				name: 'Matrix', minCol: 1, columnCount: denseCells.length, columnWidths: [], truncated: false,
				rows: [{ excelRow: 1, height: 20, cells: denseCells }],
			}],
		};

		await rejects(
			Promise.resolve().then(() => ownSpreadsheetSemanticInput(fixture.inventory, { projection }, CancellationToken.None)),
			/limitExceeded/,
		);
		strictEqual(ownKeysCalls, 0);
	});

	test('checks cancellation while copying individual ownership descriptors', async () => {
		const fixture = await createSemanticFixture();
		let descriptorReads = 0;
		const cells = new Proxy(Array.from({ length: 100 }, () => ({ value: '1', style: {} })), {
			getOwnPropertyDescriptor: (target, property) => {
				if (property !== 'length') {
					descriptorReads++;
				}
				return Reflect.getOwnPropertyDescriptor(target, property);
			},
		});
		const token: CancellationToken = {
			get isCancellationRequested() { return descriptorReads >= 10; },
			onCancellationRequested: Event.None,
		};
		const projection: IParadisWorkbookData = {
			sheets: [{
				name: 'Matrix', minCol: 1, columnCount: cells.length, columnWidths: [], truncated: false,
				rows: [{ excelRow: 1, height: 20, cells }],
			}],
		};

		await rejects(
			Promise.resolve().then(() => ownSpreadsheetSemanticInput(fixture.inventory, { projection }, token)),
			/cancelled/,
		);
		strictEqual(descriptorReads > 0 && descriptorReads < cells.length, true);
	});

	test('checks cancellation incrementally while taking the inventory snapshot', async () => {
		const fixture = await createSemanticFixture();
		let reads = 0;
		const observedPart = new Proxy(fixture.inventory.parts[0], {
			get: (target, property, receiver) => {
				reads++;
				return Reflect.get(target, property, receiver);
			},
		});
		const inventory: ParadisOfficeInventory = {
			...fixture.inventory,
			parts: Array.from({ length: 5_000 }, () => observedPart),
		};
		const cancellation = new CancellationTokenSource();
		cancellation.cancel();

		await rejects(
			parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), inventory, cancellation.token),
			/cancelled/,
		);
		strictEqual(reads < 100, true);
		cancellation.dispose();
	});

	test('enforces aggregate reread compression ratio from actual archive metadata', async () => {
		const fixture = await createSemanticFixture();
		const forgedInventory: ParadisOfficeInventory = {
			...fixture.inventory,
			budgetUsage: { ...fixture.inventory.budgetUsage, compressedInputBytes: 1 },
		};
		const archive = withArchiveContainerLength(await createParadisOfficeNodeArchive(fixture.bytes), 1);

		await rejects(parseSpreadsheetSemantic(archive, forgedInventory, CancellationToken.None), /zipBomb/);
	});

	test('aborts a reread stream at the entry ratio instead of after the whole Part', async () => {
		const fixture = await createSemanticFixture();
		const workbookPart = fixture.inventory.parts.find(part => part.canonicalUri === '/xl/workbook.xml');
		if (!workbookPart) {
			throw new Error('missing workbook inventory');
		}
		const inventory: ParadisOfficeInventory = {
			...fixture.inventory,
			parts: fixture.inventory.parts.map(part => part === workbookPart ? { ...part, compressedBytes: 1 } : part),
		};
		let workbookReadBytes = 0;
		const archive = withEntryCompressedSize(
			await createParadisOfficeNodeArchive(fixture.bytes),
			'xl/workbook.xml',
			1,
			bytes => workbookReadBytes += bytes,
		);

		await rejects(parseSpreadsheetSemantic(archive, inventory, CancellationToken.None), /zipBomb/);
		strictEqual(workbookReadBytes < workbookPart.expandedBytes, true);
	});

	test('clamps caller semantic limits to static hard caps while allowing exact narrowing', () => {
		strictEqual(resolveSpreadsheetSemanticLimits({ cells: 5_000_001 }).cells, 5_000_000);
		strictEqual(resolveSpreadsheetSemanticLimits({ cells: 7 }).cells, 7);
		strictEqual(resolveSpreadsheetSemanticLimits({ projectionCells: Number.MAX_SAFE_INTEGER }).projectionCells, 5_000_000);
	});

	test('rejects non-finite or backward clocks and never extends the profile deadline', async () => {
		const fixture = await createSemanticFixture();
		await rejects(
			parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None, { now: () => Number.NaN }),
			/invalid/,
		);

		const backwardTimes = [100, 101, 99];
		await rejects(
			parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None, {
				now: () => backwardTimes.shift() ?? 99,
			}),
			/invalid/,
		);

		let clockReads = 0;
		await rejects(
			parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None, {
				now: () => clockReads++ === 0 ? 0 : PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal.semanticParseMilliseconds + 1,
				deadlineMilliseconds: PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal.semanticParseMilliseconds * 2,
			}),
			/limitExceeded/,
		);
		await rejects(
			parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None, {
				now: () => 0,
				deadlineMilliseconds: 1,
				projection: {
					sheets: [{
						name: 'Matrix', minCol: 1, columnCount: 0, columnWidths: [], truncated: false,
						rows: Array.from({ length: 10_000 }, (_, index) => ({ excelRow: index + 1, height: 20, cells: [] })),
					}],
				},
			}),
			/limitExceeded/,
		);
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

	test('rejects non-relationship Content Types before parsing root or workbook relationships', async () => {
		const base = await buildSemanticBytes();
		for (const [partName, sentinel] of [
			['/_rels/.rels', 'rIdRoot'],
			['/xl/_rels/workbook.xml.rels', 'rIdStyles'],
		] as const) {
			const bytes = await overrideRelationshipContentType(base, partName);
			const inventory = await inspectOfficePackage(
				await createParadisOfficeNodeArchive(bytes),
				PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal,
				CancellationToken.None,
			);
			strictEqual(inventory.parts.find(part => part.canonicalUri === partName)?.contentType, 'application/octet-stream');
			let sentinelParses = 0;
			const inner = await createParadisOfficeNodeArchive(bytes);
			const archive: IParadisOfficeArchive = {
				containerByteLength: inner.containerByteLength,
				entries: token => inner.entries(token),
				read: (entry, token) => inner.read(entry, token),
				hash: value => inner.hash(value),
				parseXml: (xml, limits, token, checkpoint) => {
					if (xml.includes(sentinel)) {
						sentinelParses++;
					}
					return inner.parseXml(xml, limits, token, checkpoint);
				},
				dispose: () => inner.dispose(),
			};

			await rejects(parseSpreadsheetSemantic(archive, inventory, CancellationToken.None), /unsafe/);
			strictEqual(sentinelParses, 0, partName);
		}
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

	test('rejects duplicate singleton workbook and worksheet schema elements', async () => {
		const duplicateWorkbookProperties = workbookXml.replace('<workbookPr date1904="1"/>', '<workbookPr date1904="1"/><workbookPr date1904="0"/>');
		const duplicateCalculationProperties = workbookXml.replace('<calcPr ', '<calcPr calcId="1"/><calcPr ');
		const duplicateFileVersion = workbookXml.replace('<workbookPr ', '<fileVersion appName="xl"/><fileVersion appName="xl"/><workbookPr ');
		const duplicateWorkbookProtection = workbookXml.replace('<bookViews>', '<workbookProtection/><workbookProtection/><bookViews>');
		const duplicateDimension = worksheetXml.replace('<dimension ref="A1:E12"/>', '<dimension ref="A1:E12"/><dimension ref="A1:A1"/>');
		const duplicateSheetProperties = worksheetXml.replace('<dimension ', '<sheetPr/><sheetPr/><dimension ');
		const duplicateSheetFormat = worksheetXml.replace('<sheetViews>', '<sheetFormatPr defaultRowHeight="15"/><sheetFormatPr defaultRowHeight="20"/><sheetViews>');
		const duplicatePageMargins = worksheetXml.replace('</worksheet>', '<pageMargins left="1" right="1" top="1" bottom="1" header="1" footer="1"/><pageMargins left="2" right="2" top="2" bottom="2" header="2" footer="2"/></worksheet>');
		const duplicatePane = worksheetXml.replace(
			'<pane xSplit="2" ySplit="3" topLeftCell="C4" activePane="bottomRight" state="frozenSplit"/>',
			'<pane xSplit="2"/><pane ySplit="3"/>',
		);
		for (const overrides of [
			{ workbook: duplicateWorkbookProperties },
			{ workbook: duplicateCalculationProperties },
			{ workbook: duplicateFileVersion },
			{ workbook: duplicateWorkbookProtection },
			{ worksheet: duplicateDimension },
			{ worksheet: duplicateSheetProperties },
			{ worksheet: duplicateSheetFormat },
			{ worksheet: duplicatePageMargins },
			{ worksheet: duplicatePane },
		]) {
			const fixture = await createSemanticFixture(overrides);
			await rejects(
				parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None),
				/malformed/,
			);
		}
	});

	test('accepts repeated cols containers but rejects duplicate style singleton containers', async () => {
		const repeatedColumns = worksheetXml.replace(
			'<cols>',
			'<cols><col min="5" max="5" width="8"/></cols><cols>',
		);
		const repeatedColumnsFixture = await createSemanticFixture({ worksheet: repeatedColumns });
		const snapshot = await parseSpreadsheetSemantic(
			await createParadisOfficeNodeArchive(repeatedColumnsFixture.bytes), repeatedColumnsFixture.inventory, CancellationToken.None,
		);
		strictEqual(snapshot.sheets[0].columns.length, 3);

		for (const singleton of ['numFmts', 'borders', 'cellXfs']) {
			const styles = singleton === 'numFmts'
				? stylesXml.replace('</numFmts>', '</numFmts><numFmts count="0"/>')
				: singleton === 'borders'
					? stylesXml.replace('</borders>', '</borders><borders count="0"/>')
					: stylesXml.replace('</cellXfs>', '</cellXfs><cellXfs count="0"/>');
			const fixture = await createSemanticFixture({ styles });
			await rejects(
				parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None),
				/malformed/,
			);
		}
	});

	test('requires exactly one non-empty workbook sheets container', async () => {
		const missing = workbookXml.replace(/\s*<sheets>[\s\S]*?<\/sheets>/, '');
		const empty = workbookXml.replace(/<sheets>[\s\S]*?<\/sheets>/, '<sheets/>');
		for (const workbook of [missing, empty]) {
			const fixture = await createSemanticFixture({ workbook });
			await rejects(
				parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory),
				/malformed/,
			);
		}
	});

	test('requires exactly one worksheet sheetData while allowing it to be empty', async () => {
		const missingSheetData = worksheetXml.replace(/\s*<sheetData>[\s\S]*?<\/sheetData>/, '');
		const missingFixture = await createSemanticFixture({ worksheet: missingSheetData });
		await rejects(
			parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(missingFixture.bytes), missingFixture.inventory),
			/malformed/,
		);

		const emptySheetData = worksheetXml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, '<sheetData/>');
		const emptyFixture = await createSemanticFixture({ worksheet: emptySheetData });
		const snapshot = await parseSpreadsheetSemantic(await createParadisOfficeNodeArchive(emptyFixture.bytes), emptyFixture.inventory);
		strictEqual(snapshot.sheets[0].cells.size, 0);
		strictEqual(snapshot.sheets[0].rows.size, 0);
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
