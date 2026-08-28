/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, doesNotMatch, ok, strictEqual, throws } from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisOfficePackageError } from '../../common/office/paradisOfficeArchive.js';
import { parseParadisOfficeXml } from '../../common/office/paradisOfficeCanonicalXml.js';
import {
	fingerprintSpreadsheetTablesBytes,
	fingerprintSpreadsheetTablesXml,
	bindSpreadsheetTableRangeOverlays,
	parseSpreadsheetTablesAndPrint,
	parseSpreadsheetTablesAndPrintVerifiedDocuments,
	type ParadisSpreadsheetTablesInput,
	type ParadisSpreadsheetVerifiedTablesInput,
} from '../../common/spreadsheet/paradisSpreadsheetTables.js';
import type { ParadisSemanticCell, ParadisSemanticSheet, ParadisSpreadsheetPartSource } from '../../common/spreadsheet/paradisSpreadsheetSemantic.js';

const spreadsheetNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const strictSpreadsheetNamespace = 'http://purl.oclc.org/ooxml/spreadsheetml/main';
const officeRelationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const strictOfficeRelationshipNamespace = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
const packageRelationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const relationshipsContentType = 'application/vnd.openxmlformats-package.relationships+xml';

const partIds = {
	contentTypes: '/[Content_Types].xml',
	rootRelationships: '/_rels/.rels',
	workbook: '/xl/workbook.xml',
	workbookRelationships: '/xl/_rels/workbook.xml.rels',
	worksheet: '/xl/worksheets/sheet1.xml',
	worksheetRelationships: '/xl/worksheets/_rels/sheet1.xml.rels',
	table: '/xl/tables/table1.xml',
	printerSettings: '/xl/printerSettings/printerSettings1.bin',
} as const;

function sourceFor(partId: string, xml: string): ParadisSpreadsheetPartSource {
	return { partId, fingerprint: fingerprintSpreadsheetTablesXml(xml) };
}

function sourceForBytes(partId: string, bytes: Uint8Array): ParadisSpreadsheetPartSource {
	return { partId, fingerprint: fingerprintSpreadsheetTablesBytes(bytes) };
}

function contentTypes(): string {
	return `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
		<Default Extension="rels" ContentType="${relationshipsContentType}"/>
		<Override PartName="${partIds.workbook}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
		<Override PartName="${partIds.worksheet}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
		<Override PartName="${partIds.table}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>
	</Types>`;
}

function rootRelationships(strict = false): string {
	const base = strict ? strictOfficeRelationshipNamespace : officeRelationshipNamespace;
	return `<Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rWorkbook" Type="${base}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
}

function workbook(namespace = spreadsheetNamespace, relationshipNamespace = officeRelationshipNamespace): string {
	return `<workbook xmlns="${namespace}" xmlns:r="${relationshipNamespace}"><sheets><sheet name="Data Sheet" sheetId="1" r:id="rSheet1"/></sheets><definedNames>
		<definedName name="_xlnm.Print_Area" localSheetId="0">'Data Sheet'!$A$1:$C$20,'Data Sheet'!$E$1:$F$5</definedName>
		<definedName name="_xlnm.Print_Titles" localSheetId="0">'Data Sheet'!$1:$2,'Data Sheet'!$A:$B</definedName>
	</definedNames></workbook>`;
}

function workbookRelationships(strict = false): string {
	const base = strict ? strictOfficeRelationshipNamespace : officeRelationshipNamespace;
	return `<Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rSheet1" Type="${base}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
}

function worksheet(namespace = spreadsheetNamespace, relationshipNamespace = officeRelationshipNamespace): string {
	return `<worksheet xmlns="${namespace}" xmlns:r="${relationshipNamespace}" xmlns:x="urn:future:sheet">
		<sheetData><row r="2" hidden="1"><c r="B2" s="7"/><c r="C2" s="8"/></row></sheetData>
		<autoFilter ref="D1:F10"><filterColumn colId="1" hiddenButton="0"><filters blank="1"><filter val="North"/><filter val="South"/></filters></filterColumn><sortState ref="D2:F10"><sortCondition ref="E2:E10" descending="1" sortBy="value"/></sortState></autoFilter>
		<printOptions horizontalCentered="1" verticalCentered="0" headings="1" gridLines="1" gridLinesSet="1"/>
		<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
		<pageSetup paperSize="9" scale="85" fitToWidth="1" fitToHeight="2" pageOrder="overThenDown" orientation="landscape" blackAndWhite="1" draft="0" errors="dash" copies="2"/>
		<headerFooter differentFirst="1" differentOddEven="1" scaleWithDoc="0" alignWithMargins="1">
			<oddHeader>&amp;LQuarterly&amp;CPage &amp;P of &amp;N&amp;R&amp;Z&amp;F</oddHeader><oddFooter>&amp;CConfidential</oddFooter>
			<evenHeader>&amp;LSafe</evenHeader><firstHeader>&amp;CC:\\Users\\alice\\secret.xlsx</firstHeader>
		</headerFooter>
		<rowBreaks count="1" manualBreakCount="1"><brk id="20" min="0" max="16383" man="1"/></rowBreaks>
		<colBreaks count="1" manualBreakCount="1"><brk id="5" min="0" max="1048575" man="1"/></colBreaks>
		<tableParts count="1"><tablePart r:id="rTable1"/></tableParts>
		<extLst><ext uri="{FUTURE}"><x:future print="opaque"/></ext></extLst>
	</worksheet>`;
}

function worksheetRelationships(strict = false): string {
	const base = strict ? strictOfficeRelationshipNamespace : officeRelationshipNamespace;
	return `<Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rTable1" Type="${base}/table" Target="../tables/table1.xml"/></Relationships>`;
}

function table(namespace = spreadsheetNamespace): string {
	return `<table xmlns="${namespace}" xmlns:x="urn:future:table" id="1" name="SalesTable" displayName="SalesTable" ref="A1:C4" headerRowCount="1" totalsRowCount="1" totalsRowShown="1">
		<autoFilter ref="A1:C3"><filterColumn colId="0"><customFilters and="1"><customFilter operator="greaterThanOrEqual" val="10"/><customFilter operator="lessThan" val="100"/></customFilters></filterColumn></autoFilter>
		<sortState ref="A2:C3" caseSensitive="0"><sortCondition ref="B2:B3" descending="0" sortBy="value"/></sortState>
		<tableColumns count="3">
			<tableColumn id="1" name="Region" totalsRowLabel="Total"/>
			<tableColumn id="2" name="Amount" totalsRowFunction="sum"><calculatedColumnFormula>=[@Qty]*[@Price]</calculatedColumnFormula><totalsRowFormula>SUBTOTAL(109,[Amount])</totalsRowFormula></tableColumn>
			<tableColumn id="3" name="Qty" totalsRowFunction="count"/>
		</tableColumns>
		<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="1" showRowStripes="1" showColumnStripes="0"/>
		<extLst><ext uri="{TABLE-FUTURE}"><x:future value="opaque"/></ext></extLst>
	</table>`;
}

interface XmlSet {
	readonly contentTypesXml: string;
	readonly rootRelationshipsXml: string;
	readonly workbookXml: string;
	readonly workbookRelationshipsXml: string;
	readonly worksheetXml: string;
	readonly worksheetRelationshipsXml: string;
	readonly tableXml: string;
}

function xmlSet(overrides: Partial<XmlSet> = {}): XmlSet {
	return {
		contentTypesXml: contentTypes(), rootRelationshipsXml: rootRelationships(), workbookXml: workbook(),
		workbookRelationshipsXml: workbookRelationships(), worksheetXml: worksheet(),
		worksheetRelationshipsXml: worksheetRelationships(), tableXml: table(), ...overrides,
	};
}

function inputFor(xml: XmlSet): ParadisSpreadsheetTablesInput {
	const bytes = (value: string) => new TextEncoder().encode(value);
	return {
		contentTypesXml: xml.contentTypesXml, contentTypesBytes: bytes(xml.contentTypesXml), contentTypesSource: sourceFor(partIds.contentTypes, xml.contentTypesXml),
		rootRelationshipsXml: xml.rootRelationshipsXml, rootRelationshipsBytes: bytes(xml.rootRelationshipsXml), rootRelationshipsSource: sourceFor(partIds.rootRelationships, xml.rootRelationshipsXml),
		workbookXml: xml.workbookXml, workbookBytes: bytes(xml.workbookXml), workbookSource: sourceFor(partIds.workbook, xml.workbookXml),
		workbookRelationshipsXml: xml.workbookRelationshipsXml, workbookRelationshipsBytes: bytes(xml.workbookRelationshipsXml), workbookRelationshipsSource: sourceFor(partIds.workbookRelationships, xml.workbookRelationshipsXml),
		worksheetXml: xml.worksheetXml, worksheetBytes: bytes(xml.worksheetXml), worksheetSource: sourceFor(partIds.worksheet, xml.worksheetXml),
		worksheetRelationshipsXml: xml.worksheetRelationshipsXml, worksheetRelationshipsBytes: bytes(xml.worksheetRelationshipsXml), worksheetRelationshipsSource: sourceFor(partIds.worksheetRelationships, xml.worksheetRelationshipsXml),
		tableParts: [{ xml: xml.tableXml, bytes: bytes(xml.tableXml), source: sourceFor(partIds.table, xml.tableXml) }],
	};
}

function verifiedInputFor(xml: XmlSet): ParadisSpreadsheetVerifiedTablesInput {
	const input = inputFor(xml);
	const encode = (value: string) => new TextEncoder().encode(value);
	const parse = (value: string) => parseParadisOfficeXml(value, { depth: 96, nodes: 10_000, attributeLength: 64 * 1024, characters: 1024 * 1024 });
	return {
		contentTypesDocument: parse(xml.contentTypesXml), contentTypesBytes: encode(xml.contentTypesXml), contentTypesSource: input.contentTypesSource,
		rootRelationshipsDocument: parse(xml.rootRelationshipsXml), rootRelationshipsBytes: encode(xml.rootRelationshipsXml), rootRelationshipsSource: input.rootRelationshipsSource,
		workbookDocument: parse(xml.workbookXml), workbookBytes: encode(xml.workbookXml), workbookSource: input.workbookSource,
		workbookRelationshipsDocument: parse(xml.workbookRelationshipsXml), workbookRelationshipsBytes: encode(xml.workbookRelationshipsXml), workbookRelationshipsSource: input.workbookRelationshipsSource,
		worksheetDocument: parse(xml.worksheetXml), worksheetBytes: encode(xml.worksheetXml), worksheetSource: input.worksheetSource,
		worksheetRelationshipsDocument: parse(xml.worksheetRelationshipsXml), worksheetRelationshipsBytes: encode(xml.worksheetRelationshipsXml), worksheetRelationshipsSource: input.worksheetRelationshipsSource,
		tableParts: [{ document: parse(xml.tableXml), bytes: encode(xml.tableXml), source: input.tableParts[0].source }],
	};
}

function invalid(run: () => unknown, code: ParadisOfficePackageError['code']): void {
	throws(run, error => error instanceof ParadisOfficePackageError && error.code === code);
}

suite('ParadisSpreadsheetTables', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses table range, ordered columns, totals, stored structured formulas, and style without recalculation', () => {
		const model = parseSpreadsheetTablesAndPrint(inputFor(xmlSet()));
		deepStrictEqual(model.tables.map(value => ({
			id: value.id, name: value.name, displayName: value.displayName, ref: value.range.ref,
			headerRows: value.headerRowCount, totalRows: value.totalsRowCount, totalsShown: value.totalsRowShown,
			columns: value.columns.map(column => ({
				id: column.id, name: column.name, label: column.totalsRowLabel, total: column.totalsRowFunction,
				calculated: column.calculatedColumnFormula?.text, totalsFormula: column.totalsRowFormula?.text,
			})),
			style: value.styleInfo,
		})), [{
			id: 1, name: 'SalesTable', displayName: 'SalesTable', ref: 'A1:C4', headerRows: 1, totalRows: 1, totalsShown: true,
			columns: [
				{ id: 1, name: 'Region', label: 'Total', total: undefined, calculated: undefined, totalsFormula: undefined },
				{ id: 2, name: 'Amount', label: undefined, total: 'sum', calculated: '=[@Qty]*[@Price]', totalsFormula: 'SUBTOTAL(109,[Amount])' },
				{ id: 3, name: 'Qty', label: undefined, total: 'count', calculated: undefined, totalsFormula: undefined },
			],
			style: { name: 'TableStyleMedium2', showFirstColumn: false, showLastColumn: true, showRowStripes: true, showColumnStripes: false },
		}]);
		strictEqual(model.tables[0].columns[1].calculatedColumnFormula?.evaluation, 'notCalculated');
		strictEqual(model.tables[0].source.partId, partIds.table);
	});

	test('parses table and worksheet filters and sort state as range-owned records', () => {
		const model = parseSpreadsheetTablesAndPrint(inputFor(xmlSet()));
		deepStrictEqual({
			tableFilter: model.tables[0].autoFilter,
			tableSort: model.tables[0].sortState,
			worksheetFilter: model.worksheetAutoFilter,
		}, {
			tableFilter: {
				range: { ref: 'A1:C3', minRow: 1, maxRow: 3, minColumn: 1, maxColumn: 3 },
				columns: [{
					columnId: 0, customFiltersAnd: true, criteria: [
						{ kind: 'custom', operator: 'greaterThanOrEqual', value: '10' },
						{ kind: 'custom', operator: 'lessThan', value: '100' },
					]
				}],
			},
			tableSort: {
				range: { ref: 'A2:C3', minRow: 2, maxRow: 3, minColumn: 1, maxColumn: 3 }, caseSensitive: false,
				conditions: [{ range: { ref: 'B2:B3', minRow: 2, maxRow: 3, minColumn: 2, maxColumn: 2 }, descending: false, sortBy: 'value' }],
			},
			worksheetFilter: {
				range: { ref: 'D1:F10', minRow: 1, maxRow: 10, minColumn: 4, maxColumn: 6 },
				columns: [{
					columnId: 1, hiddenButton: false, criteria: [
						{ kind: 'value', value: 'North' }, { kind: 'value', value: 'South' }, { kind: 'blank' },
					]
				}],
				sortState: {
					range: { ref: 'D2:F10', minRow: 2, maxRow: 10, minColumn: 4, maxColumn: 6 },
					conditions: [{ range: { ref: 'E2:E10', minRow: 2, maxRow: 10, minColumn: 5, maxColumn: 5 }, descending: true, sortBy: 'value' }],
				},
			},
		});
	});

	test('parses print areas, row and column titles, headers, footers, options, setup, margins, and manual breaks', () => {
		const model = parseSpreadsheetTablesAndPrint(inputFor(xmlSet()));
		deepStrictEqual({
			areas: model.print.areas.map(range => range.ref),
			titles: model.print.titles,
			options: model.print.options,
			margins: model.print.margins,
			setup: model.print.setup,
			breaks: model.print.breaks,
			headerTokens: model.print.headerFooter.odd?.header?.center,
			footerText: model.print.headerFooter.odd?.footer?.center,
		}, {
			areas: ['A1:C20', 'E1:F5'],
			titles: { rows: { from: 1, to: 2 }, columns: { from: 1, to: 2 } },
			options: { horizontalCentered: true, verticalCentered: false, headings: true, gridLines: true, gridLinesSet: true },
			margins: { left: '0.7', right: '0.7', top: '0.75', bottom: '0.75', header: '0.3', footer: '0.3' },
			setup: { paperSize: 9, scale: 85, fitToWidth: 1, fitToHeight: 2, pageOrder: 'overThenDown', orientation: 'landscape', blackAndWhite: true, draft: false, errors: 'dash', copies: 2 },
			breaks: { rows: [{ id: 20, min: 0, max: 16383, manual: true }], columns: [{ id: 5, min: 0, max: 1048575, manual: true }] },
			headerTokens: [{ kind: 'text', value: 'Page ' }, { kind: 'page' }, { kind: 'text', value: ' of ' }, { kind: 'pages' }],
			footerText: [{ kind: 'text', value: 'Confidential' }],
		});
		deepStrictEqual(model.print.headerFooter.odd?.header?.right, [{ kind: 'path' }, { kind: 'fileName' }]);
		const serialized = JSON.stringify(model.print.headerFooter);
		doesNotMatch(serialized, /Users|alice|secret\.xlsx/);
		ok(model.print.headerFooter.first?.header?.center.some(token => token.kind === 'redactedPath'));
	});

	test('accounts for every authoritative part and unknown extension without silently dropping it', () => {
		const model = parseSpreadsheetTablesAndPrint(inputFor(xmlSet()));
		deepStrictEqual(model.completeness, {
			expectedParts: 7, visitedParts: 7, parsedParts: 7, opaqueParts: 2, failedParts: 0, omittedParts: 0,
			expectedSemanticUnits: 35, visitedSemanticUnits: 35, unknownElements: 2, unknownAttributes: 4,
			unresolvedReferences: 0, terminal: true,
		});
		deepStrictEqual(model.opaqueFragments.map(fragment => [fragment.name.namespace, fragment.name.local, fragment.source.partId]), [
			[spreadsheetNamespace, 'ext', partIds.table], [spreadsheetNamespace, 'ext', partIds.worksheet],
		]);
		ok(model.opaqueFragments.every(fragment => fragment.fingerprint.algorithm === 'sha256'));
	});

	test('accepts strict SpreadsheetML and office relationship namespaces without prefix dependence', () => {
		const strict = xmlSet({
			rootRelationshipsXml: rootRelationships(true), workbookXml: workbook(strictSpreadsheetNamespace, strictOfficeRelationshipNamespace),
			workbookRelationshipsXml: workbookRelationships(true), worksheetXml: worksheet(strictSpreadsheetNamespace, strictOfficeRelationshipNamespace),
			worksheetRelationshipsXml: worksheetRelationships(true), tableXml: table(strictSpreadsheetNamespace),
		});
		strictEqual(parseSpreadsheetTablesAndPrint(inputFor(strict)).tables[0].displayName, 'SalesTable');
	});

	test('rejects forged content types and relationships before accepting table authority', () => {
		const wrongTableType = contentTypes().replace('application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml', 'application/octet-stream');
		invalid(() => parseSpreadsheetTablesAndPrint(inputFor(xmlSet({ contentTypesXml: wrongTableType }))), 'unsafe');
		const wrongTarget = worksheetRelationships().replace('../tables/table1.xml', '../tables/table2.xml');
		invalid(() => parseSpreadsheetTablesAndPrint(inputFor(xmlSet({ worksheetRelationshipsXml: wrongTarget }))), 'unsafe');
		const wrongRelationshipMime = contentTypes().replace(relationshipsContentType, 'application/octet-stream');
		invalid(() => parseSpreadsheetTablesAndPrint(inputFor(xmlSet({ contentTypesXml: wrongRelationshipMime }))), 'unsafe');
	});

	test('rejects malformed, out-of-bounds, duplicate, and overlapping table/filter/print references', () => {
		const candidates = [
			table().replace('ref="A1:C4"', 'ref="A0:C4"'),
			table().replace('ref="A1:C4"', 'ref="A1:XFE4"'),
			table().replace('<tableColumns count="3">', '<tableColumns count="2">'),
			table().replace('id="3" name="Qty"', 'id="2" name="Qty"'),
			table().replace('ref="A1:C3"', 'ref="A1:D3"'),
			table().replace('ref="B2:B3"', 'ref="D2:D3"'),
		];
		for (const tableXml of candidates) {
			invalid(() => parseSpreadsheetTablesAndPrint(inputFor(xmlSet({ tableXml }))), 'malformed');
		}
		const duplicatePart = table().replace('id="1" name="SalesTable" displayName="SalesTable" ref="A1:C4"', 'id="2" name="SalesTable2" displayName="SalesTable2" ref="B2:D5"');
		const xml = xmlSet({
			worksheetXml: worksheet().replace('<tableParts count="1"><tablePart r:id="rTable1"/></tableParts>', '<tableParts count="2"><tablePart r:id="rTable1"/><tablePart r:id="rTable2"/></tableParts>'),
			worksheetRelationshipsXml: worksheetRelationships().replace('</Relationships>', `<Relationship Id="rTable2" Type="${officeRelationshipNamespace}/table" Target="../tables/table2.xml"/></Relationships>`),
			contentTypesXml: contentTypes().replace('</Types>', '<Override PartName="/xl/tables/table2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/></Types>'),
		});
		const input = inputFor(xml);
		invalid(() => parseSpreadsheetTablesAndPrint({ ...input, tableParts: [...input.tableParts, { xml: duplicatePart, bytes: new TextEncoder().encode(duplicatePart), source: sourceFor('/xl/tables/table2.xml', duplicatePart) }] }), 'malformed');

		const overlappingArea = workbook().replace(`'Data Sheet'!$E$1:$F$5`, `'Data Sheet'!$B$2:$D$5`);
		invalid(() => parseSpreadsheetTablesAndPrint(inputFor(xmlSet({ workbookXml: overlappingArea }))), 'malformed');
	});

	test('requires exact raw SHA identity and rejects decoded XML that disagrees with supplied bytes', () => {
		const xml = xmlSet();
		const input = inputFor(xml);
		const changed = xml.tableXml.replace('SalesTable', 'SalesTabla');
		invalid(() => parseSpreadsheetTablesAndPrint({ ...input, tableParts: [{ xml: changed, bytes: input.tableParts[0].bytes, source: input.tableParts[0].source }] }), 'unsafe');
		const bytes = new TextEncoder().encode(xml.tableXml.replace('SalesTable', 'SalesTableX'));
		invalid(() => parseSpreadsheetTablesAndPrint({ ...input, tableParts: [{ xml: xml.tableXml, bytes, source: sourceForBytes(partIds.table, bytes) }] }), 'unsafe');
	});

	test('requires all-byte raw Parts and owner-derived fixed relationship Part identities', () => {
		const input = inputFor(xmlSet());
		invalid(() => parseSpreadsheetTablesAndPrint({ ...input, workbookBytes: undefined } as unknown as ParadisSpreadsheetTablesInput), 'unsafe');
		invalid(() => parseSpreadsheetTablesAndPrint({
			...input,
			workbookRelationshipsSource: { ...input.workbookRelationshipsSource, partId: '/xl/_rels/other.xml.rels' },
		} as ParadisSpreadsheetTablesInput), 'unsafe');
		invalid(() => parseSpreadsheetTablesAndPrint({
			...input,
			worksheetRelationshipsSource: { ...input.worksheetRelationshipsSource, partId: '/xl/worksheets/_rels/other.xml.rels' },
		} as ParadisSpreadsheetTablesInput), 'unsafe');
	});

	test('counts opaque Parts separately from opaque fragments and accounts every typed semantic unit', () => {
		const extra = table().replace('<x:future value="opaque"/>', '<x:future value="opaque"/><x:second value="opaque2"/>');
		const model = parseSpreadsheetTablesAndPrint(inputFor(xmlSet({ tableXml: extra })));
		strictEqual(model.completeness.opaqueParts, 2, 'table and worksheet Parts, not three fragments');
		strictEqual(model.completeness.expectedSemanticUnits, model.completeness.visitedSemanticUnits);
		ok(model.completeness.expectedSemanticUnits > model.tables.length + 1);
	});

	test('rejects illegal filter and sort enums instead of accepting attacker-controlled vocabulary', () => {
		for (const tableXml of [
			table().replace('operator="greaterThanOrEqual"', 'operator="execute"'),
			table().replace('sortBy="value"', 'sortBy="external"'),
			table().replace('caseSensitive="0"', 'caseSensitive="0" sortMethod="external"'),
		]) {
			invalid(() => parseSpreadsheetTablesAndPrint(inputFor(xmlSet({ tableXml }))), 'malformed');
		}
		const dynamic = worksheet().replace('<filters blank="1"><filter val="North"/><filter val="South"/></filters>', '<dynamicFilter type="external"/>');
		invalid(() => parseSpreadsheetTablesAndPrint(inputFor(xmlSet({ worksheetXml: dynamic }))), 'malformed');
	});

	test('preserves AutoFilter extension wrappers including URI and rejects unresolved relationship IDs', () => {
		const extension = '<extLst><ext uri="{FILTER-FUTURE}"><x:filterFuture r:id="rMissing"/></ext></extLst>';
		const worksheetXml = worksheet().replace('</autoFilter>', `${extension}</autoFilter>`);
		invalid(() => parseSpreadsheetTablesAndPrint(inputFor(xmlSet({ worksheetXml }))), 'unsafe');
		const safeExtension = extension.replace(' r:id="rMissing"', '');
		const first = parseSpreadsheetTablesAndPrint(inputFor(xmlSet({ worksheetXml: worksheet().replace('</autoFilter>', `${safeExtension}</autoFilter>`) })));
		const changed = parseSpreadsheetTablesAndPrint(inputFor(xmlSet({ worksheetXml: worksheet().replace('</autoFilter>', `${safeExtension.replace('{FILTER-FUTURE}', '{FILTER-CHANGED}')}</autoFilter>`) })));
		const firstFragment = first.opaqueFragments.find(fragment => fragment.path.includes('/autoFilter/'));
		const changedFragment = changed.opaqueFragments.find(fragment => fragment.path.includes('/autoFilter/'));
		ok(firstFragment && changedFragment);
		strictEqual(firstFragment.name.local, 'ext');
		strictEqual(firstFragment.fingerprint.value === changedFragment.fingerprint.value, false);
		for (const [marker, replacement, path] of [
			['</filters></filterColumn>', '</filters><extLst><ext uri="{NESTED}"><x:nested/></ext></extLst></filterColumn>', '/filterColumn/'],
			['</sortState>', '<extLst><ext uri="{NESTED}"><x:nested/></ext></extLst></sortState>', '/sortState/'],
		] as const) {
			const nested = worksheet().replace(marker, replacement);
			const nestedModel = parseSpreadsheetTablesAndPrint(inputFor(xmlSet({ worksheetXml: nested })));
			ok(nestedModel.opaqueFragments.some(fragment => fragment.path.includes(path)));
		}
	});

	test('verifies printer settings target bytes and raw SHA before marking print semantics terminal', () => {
		const printerBytes = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
		const contentTypesXml = contentTypes().replace('</Types>', `<Override PartName="${partIds.printerSettings}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings"/></Types>`);
		const worksheetRelationshipsXml = worksheetRelationships().replace('</Relationships>', `<Relationship Id="rPrinter" Type="${officeRelationshipNamespace}/printerSettings" Target="../printerSettings/printerSettings1.bin"/></Relationships>`);
		const worksheetXml = worksheet().replace('copies="2"', 'copies="2" r:id="rPrinter"');
		const input = inputFor(xmlSet({ contentTypesXml, worksheetRelationshipsXml, worksheetXml }));
		const model = parseSpreadsheetTablesAndPrint({
			...input,
			printerSettingsParts: [{ bytes: printerBytes, source: sourceForBytes(partIds.printerSettings, printerBytes) }],
		});
		strictEqual(model.print.setup.printerSettingsSource?.fingerprint.value, sourceForBytes(partIds.printerSettings, printerBytes).fingerprint.value);
		const changed = new Uint8Array(printerBytes); changed[0] ^= 1;
		invalid(() => parseSpreadsheetTablesAndPrint({
			...input,
			printerSettingsParts: [{ bytes: changed, source: sourceForBytes(partIds.printerSettings, printerBytes) }],
		}), 'unsafe');
	});

	test('accepts standard sort/filter enum defaults and retains calendar semantics', () => {
		const worksheetXml = worksheet()
			.replace('<filters blank="1">', '<filters blank="1" calendarType="gregorian">')
			.replace('<sortState ref="D2:F10">', '<sortState ref="D2:F10" sortMethod="none">')
			.replace('</filterColumn>', '<iconFilter iconSet="3Arrows"/></filterColumn>')
			.replace('<filters blank="1" calendarType="gregorian"><filter val="North"/><filter val="South"/></filters><iconFilter iconSet="3Arrows"/>', '<filters blank="1" calendarType="gregorian"><filter val="North"/><filter val="South"/></filters>');
		const withIcon = worksheetXml.replace('<filters blank="1" calendarType="gregorian"><filter val="North"/><filter val="South"/></filters>', '<iconFilter iconSet="3Arrows"/>');
		const calendar = parseSpreadsheetTablesAndPrint(inputFor(xmlSet({ worksheetXml })));
		strictEqual(calendar.worksheetAutoFilter?.columns[0].calendarType, 'gregorian');
		strictEqual(calendar.worksheetAutoFilter?.sortState?.sortMethod, 'none');
		const icon = parseSpreadsheetTablesAndPrint(inputFor(xmlSet({ worksheetXml: withIcon }))).worksheetAutoFilter?.columns[0].criteria[0];
		deepStrictEqual(icon, { kind: 'icon', iconSet: '3Arrows' });
	});

	test('parses fit-to-page/custom paper semantics, break defaults, and rejects dangling printer settings', () => {
		const worksheetXml = worksheet()
			.replace('<sheetData>', '<sheetPr><pageSetUpPr fitToPage="1" autoPageBreaks="0"/></sheetPr><sheetData>')
			.replace('copies="2"', 'copies="2" paperWidth="210mm" paperHeight="297mm"')
			.replace('<brk id="20" min="0" max="16383" man="1"/>', '<brk id="20" max="16383" man="1" pt="1"/>');
		const model = parseSpreadsheetTablesAndPrint(inputFor(xmlSet({ worksheetXml })));
		deepStrictEqual({
			fitToPage: model.print.setup.fitToPage, autoPageBreaks: model.print.setup.autoPageBreaks,
			paperWidth: model.print.setup.paperWidth, paperHeight: model.print.setup.paperHeight,
			rowBreak: model.print.breaks.rows[0],
		}, {
			fitToPage: true, autoPageBreaks: false, paperWidth: '210mm', paperHeight: '297mm',
			rowBreak: { id: 20, min: 0, max: 16383, manual: true, pivotCreated: true },
		});
		const dangling = worksheetXml.replace('copies="2"', 'copies="2" r:id="rMissingPrinter"');
		invalid(() => parseSpreadsheetTablesAndPrint(inputFor(xmlSet({ worksheetXml: dangling }))), 'unsafe');
		const defaultBreak = worksheet().replace('<brk id="20" min="0" max="16383" man="1"/>', '<brk/>').replace('manualBreakCount="1"', 'manualBreakCount="0"');
		deepStrictEqual(parseSpreadsheetTablesAndPrint(inputFor(xmlSet({ worksheetXml: defaultBreak }))).print.breaks.rows[0], { id: 0, min: 0, max: 0, manual: false });
	});

	test('redacts every absolute path and URI form from header/footer display projection', () => {
		for (const secret of ['/etc/passwd', '/workspace/repo/private.xlsx', 'smb://server/share/private.xlsx', 'https://example.invalid/private.xlsx', 'mailto:alice@example.com', 'urn:private:value', '\\\\server\\share\\private.xlsx']) {
			const worksheetXml = worksheet().replace('C:\\Users\\alice\\secret.xlsx', secret);
			const serialized = JSON.stringify(parseSpreadsheetTablesAndPrint(inputFor(xmlSet({ worksheetXml }))).print.headerFooter);
			doesNotMatch(serialized, /passwd|workspace|example\.invalid|server|private\.xlsx/);
		}
	});

	test('enforces aggregate XML budgets and does not allow callers to upgrade the execution profile', () => {
		const input = inputFor(xmlSet());
		invalid(() => parseSpreadsheetTablesAndPrint(input, { limits: { aggregateXmlCharacters: 100 } }), 'limitExceeded');
		invalid(() => parseSpreadsheetTablesAndPrint(input, { profile: 'desktop', limits: { aggregateXmlCharacters: 100 } } as never), 'limitExceeded');
	});

	test('re-verifies Task 1-style parsed documents against owned bytes and rejects graph or byte TOCTOU', () => {
		const verified = verifiedInputFor(xmlSet());
		strictEqual(parseSpreadsheetTablesAndPrintVerifiedDocuments(verified, () => undefined).tables.length, 1);
		const changedBytes = new Uint8Array(verifiedInputFor(xmlSet()).tableParts[0].bytes);
		changedBytes[changedBytes.length - 8] ^= 1;
		invalid(() => parseSpreadsheetTablesAndPrintVerifiedDocuments({
			...verified,
			tableParts: [{ ...verified.tableParts[0], bytes: changedBytes, source: sourceForBytes(partIds.table, changedBytes) }],
		}, () => undefined), 'malformed');
		const accessor = Object.defineProperty({ ...verified }, 'worksheetDocument', { get: () => verified.worksheetDocument });
		invalid(() => parseSpreadsheetTablesAndPrintVerifiedDocuments(accessor as ParadisSpreadsheetVerifiedTablesInput, () => undefined), 'unsafe');
	});

	test('enforces table/filter/print limits, cancellation, deadlines, and never performs external fetch or recalculation', () => {
		invalid(() => parseSpreadsheetTablesAndPrint(inputFor(xmlSet()), { limits: { tableColumns: 2 } }), 'limitExceeded');
		invalid(() => parseSpreadsheetTablesAndPrint(inputFor(xmlSet()), { limits: { printRanges: 1 } }), 'limitExceeded');
		invalid(() => parseSpreadsheetTablesAndPrint(inputFor(xmlSet()), { cancellationToken: CancellationToken.Cancelled }), 'cancelled');
		let now = 0;
		invalid(() => parseSpreadsheetTablesAndPrint(inputFor(xmlSet()), { now: () => now++, deadlineMilliseconds: 0 }), 'limitExceeded');
		strictEqual(Object.prototype.hasOwnProperty.call(parseSpreadsheetTablesAndPrint, 'fetch'), false);
	});

	test('never mutates styleRef, effective diagonal identity, or conditional overlay provenance for populated, blank, and hidden cells', () => {
		const diagonal = Object.freeze({ up: true, down: true, style: 'dashDot', color: Object.freeze({ kind: 'rgb' as const, rgb: 'FFFF0000' }) });
		const cells = new Map<string, ParadisSemanticCell>([
			['A1', Object.freeze({ storedType: 'number', rawValue: Object.freeze({ present: true, text: '1' }), styleRef: 7, effectiveStyleRef: 7, effectiveStyleOrigin: 'cell' })],
			['B2', Object.freeze({ storedType: 'blank', styleRef: 7, effectiveStyleRef: 7, effectiveStyleOrigin: 'row' })],
		]);
		const provenance = Object.freeze({ baseDiagonal: diagonal, conditionalDiagonal: Object.freeze({ up: false, down: true, style: 'double' }), cell: cells.get('B2') });
		const before = { cells: [...cells.entries()], provenance };
		const model = parseSpreadsheetTablesAndPrint(inputFor(xmlSet()));
		const sheet = Object.freeze({
			name: 'Data Sheet', sheetId: '1', order: 0, state: 'visible', relationshipId: 'rSheet1', partId: partIds.worksheet,
			source: model.worksheetSource, views: Object.freeze([]), rows: new Map([[2, Object.freeze({ index: 2, hidden: true, styleRef: 7 })]]),
			columns: Object.freeze([{ min: 2, max: 2, hidden: true, styleRef: 7 }]), merges: Object.freeze([]), cells,
			conditionalFormatting: Object.freeze({ source: model.worksheetSource, worksheetSource: model.worksheetSource, differentialStyles: Object.freeze([]), rules: Object.freeze([]) }),
		} satisfies ParadisSemanticSheet);
		const bound = bindSpreadsheetTableRangeOverlays(model, sheet);
		deepStrictEqual({ cells: [...cells.entries()], provenance }, before);
		strictEqual(provenance.baseDiagonal, diagonal);
		strictEqual(provenance.cell, cells.get('B2'));
		deepStrictEqual(bound.map(overlay => [overlay.kind, overlay.range.ref]), [
			['table', 'A1:C4'], ['tableFilter', 'A1:C3'], ['tableSort', 'A2:C3'], ['worksheetFilter', 'D1:F10'], ['worksheetSort', 'D2:F10'], ['printArea', 'A1:C20'], ['printArea', 'E1:F5'],
		]);
		ok(model.rangeOverlays.every(overlay => !Object.prototype.hasOwnProperty.call(overlay, 'styleRef') && !Object.prototype.hasOwnProperty.call(overlay, 'diagonal')));
	});
});
