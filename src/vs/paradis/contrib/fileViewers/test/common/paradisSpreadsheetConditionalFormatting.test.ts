/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, notStrictEqual, ok, strictEqual, throws } from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisOfficePackageError } from '../../common/office/paradisOfficeArchive.js';
import {
	evaluateSpreadsheetConditionalFormattingOwned,
	fingerprintSpreadsheetConditionalFormattingXml,
	parseSpreadsheetConditionalFormatting,
	type ParadisSpreadsheetConditionalFormatEvaluation,
} from '../../common/spreadsheet/paradisSpreadsheetConditionalFormatting.js';
import type {
	ParadisSemanticCell,
	ParadisSemanticSheet,
	ParadisSpreadsheetPartSource,
	ParadisSpreadsheetSnapshot,
} from '../../common/spreadsheet/paradisSpreadsheetSemantic.js';

const namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const worksheetSource: ParadisSpreadsheetPartSource = {
	partId: '/xl/worksheets/sheet1.xml',
	fingerprint: { algorithm: 'sha256', value: '1'.repeat(64), byteLength: 4096 },
};
const otherWorksheetSource: ParadisSpreadsheetPartSource = {
	partId: '/xl/worksheets/sheet2.xml',
	fingerprint: { algorithm: 'sha256', value: '2'.repeat(64), byteLength: 2048 },
};
const stylesSource: ParadisSpreadsheetPartSource = {
	partId: '/xl/styles.xml',
	fingerprint: { algorithm: 'sha256', value: '3'.repeat(64), byteLength: 1024 },
};

function sourceFor(partId: string, xml: string): ParadisSpreadsheetPartSource {
	return { partId, fingerprint: fingerprintSpreadsheetConditionalFormattingXml(xml) };
}

function worksheet(body: string): string {
	return `<worksheet xmlns="${namespace}"><sheetData/>${body}</worksheet>`;
}

function styles(body: string): string {
	return `<styleSheet xmlns="${namespace}">${body}</styleSheet>`;
}

function number(value: number, styleRef?: number): ParadisSemanticCell {
	return {
		storedType: 'number',
		rawType: 'n',
		rawValue: { present: true, text: String(value) },
		...(styleRef === undefined ? {} : { styleRef, effectiveStyleRef: styleRef, effectiveStyleOrigin: 'cell' as const, styleSource: stylesSource }),
	};
}

function text(value: string): ParadisSemanticCell {
	return { storedType: 'string', rawType: 'str', rawValue: { present: true, text: value }, text: value };
}

function formula(textValue: string, cachedResult: ParadisSemanticCell['cachedResult']): ParadisSemanticCell {
	return {
		storedType: 'formula', rawType: 'n', formula: { text: textValue, kind: 'normal' }, cachedResult,
	};
}

function sheet(
	name: string,
	partId: string,
	source: ParadisSpreadsheetPartSource,
	cells: ReadonlyMap<string, ParadisSemanticCell>,
): ParadisSemanticSheet {
	return {
		name, sheetId: name === 'Sheet1' ? '1' : '2', order: name === 'Sheet1' ? 0 : 1,
		state: 'visible', relationshipId: name === 'Sheet1' ? 'rId1' : 'rId2', partId, source,
		views: [], rows: new Map(), columns: [], merges: [], cells,
	};
}

function snapshot(
	cells: ReadonlyMap<string, ParadisSemanticCell>,
	otherCells: ReadonlyMap<string, ParadisSemanticCell> = new Map(),
	date1904 = false,
): ParadisSpreadsheetSnapshot {
	return {
		workbookSource: { partId: '/xl/workbook.xml', fingerprint: { algorithm: 'sha256', value: '4'.repeat(64), byteLength: 512 } },
		date1904,
		definedNames: [], workbookViews: [],
		sheets: [
			sheet('Sheet1', worksheetSource.partId, worksheetSource, cells),
			sheet('Other Sheet', otherWorksheetSource.partId, otherWorksheetSource, otherCells),
		],
		styles: {
			source: stylesSource, numberFormats: [], cellFormats: [{ index: 0, borderRef: 0 }, { index: 1, borderRef: 1 }],
			borders: [
				{ index: 0 },
				{
					index: 1, diagonalUp: true, diagonalDown: false,
					diagonal: { style: 'dashDot', color: { kind: 'rgb', rgb: 'FFFF0000' } },
				},
			],
			completeness: { parsedCellFormats: 2, parsedBorders: 2, cellsWithStyleRefs: 1, unresolvedStyleRefs: 0, cellsWithDiagonalStyleRefs: 1 },
		},
		completeness: {
			expectedParts: 4, visitedParts: 4, parsedParts: 4, expectedSheets: 2, parsedSheets: 2,
			expectedCells: cells.size + otherCells.size, parsedCells: cells.size + otherCells.size,
			unknownElements: 0, unknownAttributes: 0, unresolvedReferences: 0, terminal: true,
		},
		projectionDiagnostics: [],
	};
}

function parse(body: string, styleBody?: string) {
	const worksheetXml = worksheet(body);
	const stylesXml = styleBody === undefined ? undefined : styles(styleBody);
	return parseSpreadsheetConditionalFormatting({
		worksheetXml, worksheetSource: sourceFor(worksheetSource.partId, worksheetXml),
		...(stylesXml === undefined ? {} : { stylesXml, stylesSource: sourceFor(stylesSource.partId, stylesXml) }),
	});
}

function parseRawWorksheet(worksheetXml: string, context?: Parameters<typeof parseSpreadsheetConditionalFormatting>[1]) {
	return parseSpreadsheetConditionalFormatting({
		worksheetXml,
		worksheetSource: sourceFor(worksheetSource.partId, worksheetXml),
	}, context);
}

function resultsFor(
	model: ReturnType<typeof parse>,
	workbook: ParadisSpreadsheetSnapshot,
	addresses: readonly string[],
	todaySerial?: number,
): readonly ParadisSpreadsheetConditionalFormatEvaluation[] {
	const boundWorkbook = bindSnapshot(model, workbook);
	return evaluateSpreadsheetConditionalFormattingOwned(model, boundWorkbook, {
		sheetName: 'Sheet1', addresses, ...(todaySerial === undefined ? {} : { todaySerial }),
	});
}

function bindSnapshot(model: ReturnType<typeof parse>, workbook: ParadisSpreadsheetSnapshot): ParadisSpreadsheetSnapshot {
	return {
		...workbook,
		sheets: workbook.sheets.map(sheet => sheet.name === 'Sheet1' ? { ...sheet, partId: model.worksheetSource.partId, source: model.worksheetSource } : sheet),
		styles: model.stylesSource ? { ...workbook.styles, source: model.stylesSource } : workbook.styles,
	};
}

function exactResult(
	results: readonly ParadisSpreadsheetConditionalFormatEvaluation[],
	address: string,
	priority: number,
): Extract<ParadisSpreadsheetConditionalFormatEvaluation, { readonly status: 'exact' }> {
	const result = results.find(candidate => candidate.cellAddress === address && candidate.priority === priority);
	ok(result, `${address} priority ${priority}`);
	strictEqual(result.status, 'exact');
	return result as Extract<ParadisSpreadsheetConditionalFormatEvaluation, { readonly status: 'exact' }>;
}

suite('ParadisSpreadsheetConditionalFormatting', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses ordered sqref rules, stopIfTrue, formulas, and all-byte source identities', () => {
		const model = parse(`
			<conditionalFormatting sqref="A1:A4 C1">
				<cfRule type="expression" dxfId="0" priority="9"><formula>A1&gt;0</formula></cfRule>
				<cfRule type="cellIs" priority="2" stopIfTrue="1" operator="greaterThan"><formula>5</formula></cfRule>
			</conditionalFormatting>`, `
			<dxfs count="1"><dxf><font><b/><color rgb="FF112233"/></font></dxf></dxfs>`);

		strictEqual(model.rules.length, 2);
		deepStrictEqual(model.rules.map(rule => [rule.priority, rule.type, rule.stopIfTrue]), [
			[2, 'cellIs', true],
			[9, 'expression', false],
		]);
		deepStrictEqual(model.rules[0].ranges.map(range => range.ref), ['A1:A4', 'C1']);
		deepStrictEqual(model.rules[0].formulas, ['5']);
		strictEqual(model.rules[1].differentialStyleRef, 0);
		strictEqual(model.rules[1].source.partId, worksheetSource.partId);
		strictEqual(model.rules[1].source.fingerprint.value.length, 64);
		strictEqual(model.differentialStyles[0].source.partId, stylesSource.partId);
		deepStrictEqual(model.differentialStyles[0].font, { bold: true, color: { kind: 'rgb', rgb: 'FF112233' } });
	});

	test('evaluates every cellIs operator with relative, mixed, and absolute references in priority order', () => {
		const cells = new Map<string, ParadisSemanticCell>([
			['A1', number(5)], ['B1', number(100)], ['A2', number(3)], ['B2', number(9)],
			['C2', number(10)], ['D2', number(10)], ['C3', number(8)], ['D3', number(8)],
		]);
		const operators = [
			['between', '3', '10'], ['notBetween', '11', '20'], ['equal', '10'], ['notEqual', '11'],
			['greaterThan', '9'], ['lessThan', '11'], ['greaterThanOrEqual', '10'], ['lessThanOrEqual', '10'],
			['between', '10', '3'], ['notBetween', '10', '3'],
		] as const;
		const operatorRules = operators.map(([operator, ...formulas], index) =>
			`<cfRule type="cellIs" priority="${index + 10}" operator="${operator}">${formulas.map(value => `<formula>${value}</formula>`).join('')}</cfRule>`).join('');
		const model = parse(`
			<conditionalFormatting sqref="C2:D3">
				<cfRule type="cellIs" priority="1" stopIfTrue="1" operator="greaterThan"><formula>A1</formula></cfRule>
				<cfRule type="cellIs" priority="2" operator="greaterThan"><formula>$A$1</formula></cfRule>
				<cfRule type="cellIs" priority="3" operator="lessThan"><formula>A$1</formula></cfRule>
				${operatorRules}
			</conditionalFormatting>`);
		const results = resultsFor(model, snapshot(cells), ['C2', 'D2', 'C3', 'D3']);

		strictEqual(exactResult(results, 'C2', 1).applies, true);
		strictEqual(exactResult(results, 'C2', 2).suppressedByRuleId, model.rules[0].id);
		strictEqual(exactResult(results, 'D3', 1).applies, false); // A1 shifted to B2 (9).
		strictEqual(exactResult(results, 'D3', 2).applies, true); // $A$1 remains 5.
		strictEqual(exactResult(results, 'D3', 3).applies, true); // A$1 shifts to B$1 (100).
		for (let priority = 10; priority < 20; priority++) {
			strictEqual(exactResult(results, 'C2', priority).suppressedByRuleId, model.rules[0].id);
			strictEqual(exactResult(results, 'D2', priority).applies, priority !== 19, `operator priority ${priority}`);
		}
	});

	test('anchors relative formulas to the first ordered sqref cell across disjoint and overlapping ranges', () => {
		const cells = new Map<string, ParadisSemanticCell>([['A1', number(1)], ['B1', number(1)], ['C1', number(0)]]);
		const disjoint = parse('<conditionalFormatting sqref="A1 C1"><cfRule type="expression" priority="1"><formula>A1=1</formula></cfRule></conditionalFormatting>');
		const disjointResults = resultsFor(disjoint, snapshot(cells), ['A1', 'C1']);
		strictEqual(exactResult(disjointResults, 'A1', 1).applies, true);
		strictEqual(exactResult(disjointResults, 'C1', 1).applies, false);

		const overlap = parse('<conditionalFormatting sqref="A1:B1 B1:C1"><cfRule type="expression" priority="1"><formula>A1=1</formula></cfRule></conditionalFormatting>');
		strictEqual(exactResult(resultsFor(overlap, snapshot(cells), ['C1']), 'C1', 1).applies, false);

		const ordered = parse('<conditionalFormatting sqref="C1 A1"><cfRule type="expression" priority="1"><formula>A1=1</formula></cfRule></conditionalFormatting>');
		const orderedResult = resultsFor(ordered, snapshot(cells), ['A1'])[0];
		deepStrictEqual(orderedResult.status === 'notEvaluated' ? orderedResult.reason : undefined, 'invalidValue');
	});

	test('evaluates the bounded expression subset over arithmetic, comparisons, boolean functions, and same-workbook ranges', () => {
		const cells = new Map<string, ParadisSemanticCell>([
			['A1', number(1)], ['A2', number(2)], ['B1', number(0)], ['C1', number(8)],
		]);
		const otherCells = new Map<string, ParadisSemanticCell>([['A1', number(7)]]);
		const model = parse(`
			<conditionalFormatting sqref="C1">
				<cfRule type="expression" priority="1"><formula>AND(A1:A2&gt;0,NOT(B1&lt;&gt;0),(1+2*3)^1=7)</formula></cfRule>
				<cfRule type="expression" priority="2"><formula>'other sheet'!$A$1=7</formula></cfRule>
				<cfRule type="expression" priority="3"><formula>2^3^2=64</formula></cfRule>
			</conditionalFormatting>`);
		const results = resultsFor(model, snapshot(cells, otherCells), ['C1']);

		strictEqual(exactResult(results, 'C1', 1).applies, true);
		strictEqual(exactResult(results, 'C1', 2).applies, true);
		strictEqual(exactResult(results, 'C1', 3).applies, true);
		const literalModel = parse('<conditionalFormatting sqref="C1"><cfRule type="expression" priority="1"><formula>"[x]"="[x]"</formula></cfRule></conditionalFormatting>');
		strictEqual(exactResult(resultsFor(literalModel, snapshot(cells), ['C1']), 'C1', 1).applies, true);
		const structuredModel = parse('<conditionalFormatting sqref="C1"><cfRule type="expression" priority="1"><formula>Table1[Column]&gt;0</formula></cfRule></conditionalFormatting>');
		const structured = resultsFor(structuredModel, snapshot(cells), ['C1'])[0];
		deepStrictEqual(structured.status === 'notEvaluated' ? structured.reason : undefined, 'unsupportedExpression');
	});

	test('uses direct typed values and present formula caches without recalculation, preserving unresolved rules', () => {
		const cells = new Map<string, ParadisSemanticCell>([
			['A1', number(1)],
			['A2', formula('999+1', { present: true, type: 'number', rawValue: '2' })],
			['A3', formula('A3+1', { present: false })],
			['A4', formula('[Book.xlsx]Sheet1!A1', { present: false })],
			['A5', formula('RAND()', { present: false })],
			['A6', formula('1+1', { present: false })],
			['A7', { storedType: 'error', rawType: 'e', rawValue: { present: true, text: '#DIV/0!' } }],
			['A8', { storedType: 'string', rawType: 's', rawValue: { present: true, text: '99' } }],
		]);
		const model = parse(`
			<conditionalFormatting sqref="B1">
				<cfRule type="expression" priority="1"><formula>A1+A2=3</formula></cfRule>
				<cfRule type="expression" priority="2"><formula>A3&gt;0</formula></cfRule>
				<cfRule type="expression" priority="3"><formula>A4&gt;0</formula></cfRule>
				<cfRule type="expression" priority="4"><formula>A5&gt;0</formula></cfRule>
				<cfRule type="expression" priority="5"><formula>A6&gt;0</formula></cfRule>
				<cfRule type="expression" priority="6"><formula>A7&gt;0</formula></cfRule>
				<cfRule type="expression" priority="7"><formula>SUM(A1:A2)&gt;0</formula></cfRule>
				<cfRule type="expression" priority="8"><formula>[External.xlsx]Sheet1!A1&gt;0</formula></cfRule>
				<cfRule type="expression" priority="9"><formula>A8="99"</formula></cfRule>
				<cfRule type="expression" priority="10"><formula>'[Book.xlsx]A"B'!A1&gt;0</formula></cfRule>
			</conditionalFormatting>`);
		const results = resultsFor(model, snapshot(cells), ['B1']);

		strictEqual(exactResult(results, 'B1', 1).applies, true);
		deepStrictEqual(results.slice(1).map(result => result.status === 'notEvaluated' ? result.reason : undefined), [
			'cycle', 'externalReference', 'volatileFunction', 'cacheMissing', 'errorValue', 'unsupportedFunction', 'externalReference', 'sharedStringMissing', 'externalReference',
		]);
		strictEqual(model.rules.length, 10, 'notEvaluated rules remain semantic records');
	});

	test('classifies indirect formula cycles with bounded dependency traversal and reason precedence', () => {
		const cells = new Map<string, ParadisSemanticCell>([
			['A1', formula('B1+1', { present: false })], ['B1', formula('C1+1', { present: false })], ['C1', formula('A1+1', { present: false })],
			['A2', formula('B2+[Book.xlsx]Sheet1!A1', { present: false })], ['B2', formula('A2+1', { present: false })],
			['A3', formula('B3&RAND()', { present: false })], ['B3', formula('A3+1', { present: false })],
			['A4', formula('B4+1', { present: false })], ['B4', number(1)],
		]);
		const model = parse(`
			<conditionalFormatting sqref="D1">
				<cfRule type="expression" priority="1"><formula>A1&gt;0</formula></cfRule>
				<cfRule type="expression" priority="2"><formula>A2&gt;0</formula></cfRule>
				<cfRule type="expression" priority="3"><formula>A3&gt;0</formula></cfRule>
				<cfRule type="expression" priority="4"><formula>A4&gt;0</formula></cfRule>
			</conditionalFormatting>`);
		deepStrictEqual(resultsFor(model, snapshot(cells), ['D1']).map(result => result.status === 'notEvaluated' ? result.reason : undefined), [
			'cycle', 'externalReference', 'volatileFunction', 'cacheMissing',
		]);
	});

	test('keeps number, text, boolean, and blank comparison identities distinct', () => {
		const cells = new Map<string, ParadisSemanticCell>([
			['A1', number(1)], ['A2', text('1')], ['A3', { storedType: 'boolean', rawType: 'b', rawValue: { present: true, text: '1' } }],
		]);
		const model = parse(`
			<conditionalFormatting sqref="B1">
				<cfRule type="expression" priority="1"><formula>A1=A2</formula></cfRule>
				<cfRule type="expression" priority="2"><formula>A1=A3</formula></cfRule>
				<cfRule type="expression" priority="3"><formula>A1=B1</formula></cfRule>
			</conditionalFormatting>`);
		const results = resultsFor(model, snapshot(cells), ['B1']);
		deepStrictEqual(results.map(result => result.status === 'exact' && result.applies), [false, false, false]);
	});

	test('evaluates rank, average, duplicate, and unique rules over typed range values', () => {
		const cells = new Map<string, ParadisSemanticCell>([
			['A1', number(10)], ['A2', number(20)], ['A3', number(20)], ['A4', number(30)], ['A5', number(40)],
		]);
		const model = parse(`
			<conditionalFormatting sqref="A1:A5">
				<cfRule type="top10" priority="1" rank="2"/>
				<cfRule type="top10" priority="2" rank="40" percent="1" bottom="1"/>
				<cfRule type="aboveAverage" priority="3"/>
				<cfRule type="aboveAverage" priority="4" aboveAverage="0" equalAverage="1"/>
				<cfRule type="duplicateValues" priority="5"/>
				<cfRule type="uniqueValues" priority="6"/>
				<cfRule type="top10" priority="7" rank="0" percent="1"/>
			</conditionalFormatting>`);
		const results = resultsFor(model, snapshot(cells), ['A1', 'A2', 'A3', 'A4', 'A5']);

		deepStrictEqual(results.filter(result => result.priority === 1 && result.status === 'exact' && result.applies).map(result => result.cellAddress), ['A4', 'A5']);
		deepStrictEqual(results.filter(result => result.priority === 2 && result.status === 'exact' && result.applies).map(result => result.cellAddress), ['A1', 'A2', 'A3']);
		deepStrictEqual(results.filter(result => result.priority === 3 && result.status === 'exact' && result.applies).map(result => result.cellAddress), ['A4', 'A5']);
		deepStrictEqual(results.filter(result => result.priority === 4 && result.status === 'exact' && result.applies).map(result => result.cellAddress), ['A1', 'A2', 'A3']);
		deepStrictEqual(results.filter(result => result.priority === 5 && result.status === 'exact' && result.applies).map(result => result.cellAddress), ['A2', 'A3']);
		deepStrictEqual(results.filter(result => result.priority === 6 && result.status === 'exact' && result.applies).map(result => result.cellAddress), ['A1', 'A4', 'A5']);
		strictEqual(results.some(result => result.priority === 7 && result.status === 'exact' && result.applies), false);
	});

	test('counts overlapping sqref cells once for duplicate and unique rules', () => {
		const model = parse('<conditionalFormatting sqref="B1 B1"><cfRule type="uniqueValues" priority="1"/></conditionalFormatting>');
		strictEqual(exactResult(resultsFor(model, snapshot(new Map()), ['B1']), 'B1', 1).applies, true);
	});

	test('evaluates text and deterministic time-period rules without formatted display text', () => {
		const cells = new Map<string, ParadisSemanticCell>([
			['A2', formula('1+1', { present: false })], ['B1', text('AlphaBeta')], ['B2', text('beta')], ['C1', number(45_000)], ['C2', number(44_994)], ['C3', number(44_993)],
		]);
		const model = parse(`
			<conditionalFormatting sqref="B1:B2">
				<cfRule type="containsText" priority="1" operator="containsText" text="BETA"><formula>NOT(ISERROR(SEARCH("BETA",B1)))</formula></cfRule>
				<cfRule type="notContainsText" priority="2" text="Alpha"/>
				<cfRule type="beginsWith" priority="3" text="alpha"/>
				<cfRule type="endsWith" priority="4" text="BETA"/>
			</conditionalFormatting>
			<conditionalFormatting sqref="C1:C3">
				<cfRule type="timePeriod" priority="5" timePeriod="today"/>
				<cfRule type="timePeriod" priority="6" timePeriod="last7Days"/>
			</conditionalFormatting>`);
		const unresolvedModel = parse('<conditionalFormatting sqref="B1"><cfRule type="containsText" priority="1" text="Alpha"><formula>A2&gt;0</formula></cfRule></conditionalFormatting>');
		const unsupportedModel = parse('<conditionalFormatting sqref="B1"><cfRule type="containsText" priority="1" text="Alpha"><formula>SUM(1,2)=0</formula></cfRule></conditionalFormatting>');
		const wrongTargetModel = parse('<conditionalFormatting sqref="B1"><cfRule type="containsText" priority="1" text="Alpha"><formula>NOT(ISERROR(SEARCH("Alpha",A1)))</formula></cfRule></conditionalFormatting>');
		const results = resultsFor(model, snapshot(cells), ['B1', 'B2', 'C1', 'C2', 'C3'], 45_000);

		strictEqual(exactResult(results, 'B1', 1).applies, true);
		strictEqual(exactResult(results, 'B2', 2).applies, true);
		strictEqual(exactResult(results, 'B1', 3).applies, true);
		strictEqual(exactResult(results, 'B1', 4).applies, true);
		strictEqual(exactResult(results, 'C1', 5).applies, true);
		deepStrictEqual(results.filter(result => result.priority === 6 && result.status === 'exact' && result.applies).map(result => result.cellAddress), ['C1', 'C2']);
		const unresolved = resultsFor(unresolvedModel, snapshot(cells), ['B1'])[0];
		deepStrictEqual(unresolved.status === 'notEvaluated' ? unresolved.reason : undefined, 'cacheMissing');
		const unsupported = resultsFor(unsupportedModel, snapshot(cells), ['B1'])[0];
		deepStrictEqual(unsupported.status === 'notEvaluated' ? unsupported.reason : undefined, 'unsupportedFunction');
		const wrongTarget = resultsFor(wrongTargetModel, snapshot(cells), ['B1'])[0];
		deepStrictEqual(wrongTarget.status === 'notEvaluated' ? wrongTarget.reason : undefined, 'unsupportedExpression');
	});

	test('uses the workbook 1904 epoch for week and month time periods', () => {
		const cells = new Map<string, ParadisSemanticCell>([['C1', number(1)], ['C2', number(31)]]);
		const model = parse(`
			<conditionalFormatting sqref="C1"><cfRule type="timePeriod" priority="1" timePeriod="thisWeek"><formula>AND(TODAY()-ROUNDDOWN(C1,0)&lt;=WEEKDAY(TODAY())-1,ROUNDDOWN(C1,0)-TODAY()&lt;=7-WEEKDAY(TODAY()))</formula></cfRule></conditionalFormatting>
			<conditionalFormatting sqref="C2"><cfRule type="timePeriod" priority="2" timePeriod="nextMonth"><formula>AND(MONTH(C2)=MONTH(EDATE(TODAY(),0+1)),YEAR(C2)=YEAR(EDATE(TODAY(),0+1)))</formula></cfRule></conditionalFormatting>`);
		const results = resultsFor(model, snapshot(cells, new Map(), true), ['C1', 'C2'], 2);
		strictEqual(exactResult(results, 'C1', 1).applies, false, '1904-01-02 is before the week beginning Sunday 1904-01-03');
		strictEqual(exactResult(results, 'C2', 2).applies, true, 'serial 31 is 1904-02-01');
	});

	test('evaluates direct and cached ISO date values without host Date or formula recalculation', () => {
		const cells = new Map<string, ParadisSemanticCell>([
			['C1', { storedType: 'date', rawType: 'd', rawValue: { present: true, text: '2024-01-01T00:00:00Z' } }],
			['C2', formula('999+1', { present: true, type: 'date', rawValue: '2024-01-02T00:00:00' })],
		]);
		const model = parse(`
			<conditionalFormatting sqref="C1"><cfRule type="timePeriod" priority="1" timePeriod="today"/></conditionalFormatting>
			<conditionalFormatting sqref="C2"><cfRule type="timePeriod" priority="2" timePeriod="tomorrow"/></conditionalFormatting>`);
		const results = resultsFor(model, snapshot(cells), ['C1', 'C2'], 45_292);
		strictEqual(exactResult(results, 'C1', 1).applies, true);
		strictEqual(exactResult(results, 'C2', 2).applies, true);
	});

	test('retains and evaluates the standard blank and error rules', () => {
		const cells = new Map<string, ParadisSemanticCell>([
			['B2', text('value')], ['B3', { storedType: 'error', rawType: 'e', rawValue: { present: true, text: '#N/A' } }],
			['B4', text('')], ['B5', text('   ')], ['B6', formula('999+1', { present: true, type: 'string', rawValue: '' })],
		]);
		const model = parse(`
			<conditionalFormatting sqref="B1:B6">
				<cfRule type="containsBlanks" priority="1"/>
				<cfRule type="notContainsBlanks" priority="2"/>
				<cfRule type="containsErrors" priority="3"/>
				<cfRule type="notContainsErrors" priority="4"/>
			</conditionalFormatting>`);
		const results = resultsFor(model, snapshot(cells), ['B1', 'B2', 'B3', 'B4', 'B5', 'B6']);
		strictEqual(model.rules.length, 4);
		strictEqual(exactResult(results, 'B1', 1).applies, true);
		strictEqual(exactResult(results, 'B2', 2).applies, true);
		strictEqual(exactResult(results, 'B3', 3).applies, true);
		strictEqual(exactResult(results, 'B2', 4).applies, true);
		for (const address of ['B4', 'B5', 'B6']) {
			strictEqual(exactResult(results, address, 1).applies, true);
			strictEqual(exactResult(results, address, 2).applies, false);
		}
	});

	test('accepts typed markup-compatibility attributes on worksheet and styles roots', () => {
		const compatibility = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
		const extension = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
		const revision = 'http://schemas.microsoft.com/office/spreadsheetml/2014/revision';
		const worksheetXml = `<worksheet xmlns="${namespace}" xmlns:mc="${compatibility}" xmlns:x14="${extension}" xmlns:xr="${revision}" mc:Ignorable="x14 xr" xr:uid="{00000000-0001-0002-0003-000000000004}"><sheetData/><conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>1=1</formula></cfRule></conditionalFormatting></worksheet>`;
		const stylesXml = `<styleSheet xmlns="${namespace}" xmlns:mc="${compatibility}" xmlns:x14="${extension}" mc:Ignorable="x14"><dxfs count="0"/></styleSheet>`;
		const model = parseSpreadsheetConditionalFormatting({
			worksheetXml, worksheetSource: sourceFor(worksheetSource.partId, worksheetXml),
			stylesXml, stylesSource: sourceFor(stylesSource.partId, stylesXml),
		});
		strictEqual(model.rules.length, 1);
		strictEqual(model.differentialStyles.length, 0);
	});

	test('produces separate exact render overlays for color scales, data bars, and icon sets', () => {
		const cells = new Map<string, ParadisSemanticCell>([['D1', number(0)], ['D2', number(50)], ['D3', number(100)]]);
		const model = parse(`
			<conditionalFormatting sqref="D1:D3">
				<cfRule type="colorScale" priority="1"><colorScale>
					<cfvo type="min"/><cfvo type="max"/><color rgb="FFFF0000"/><color rgb="FF00FF00"/>
				</colorScale></cfRule>
				<cfRule type="dataBar" priority="2"><dataBar showValue="0" gradient="0" minLength="20" maxLength="80">
					<cfvo type="min"/><cfvo type="max"/><color rgb="FF0000FF"/>
				</dataBar></cfRule>
				<cfRule type="iconSet" priority="3"><iconSet iconSet="3TrafficLights1" reverse="0" showValue="1">
					<cfvo type="percent" val="0"/><cfvo type="percent" val="33"/><cfvo type="percent" val="67"/>
				</iconSet></cfRule>
				<cfRule type="dataBar" priority="4"><formula>0</formula><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF000000"/></dataBar></cfRule>
			</conditionalFormatting>`);
		const results = resultsFor(model, snapshot(cells), ['D1', 'D2', 'D3']);

		deepStrictEqual(exactResult(results, 'D2', 1).renderOverlay, {
			kind: 'colorScale', position: 0.5,
			lowerColor: { kind: 'rgb', rgb: 'FFFF0000' }, upperColor: { kind: 'rgb', rgb: 'FF00FF00' }, mix: 0.5,
		});
		deepStrictEqual(exactResult(results, 'D2', 2).renderOverlay, {
			kind: 'dataBar', ratio: 0.5, color: { kind: 'rgb', rgb: 'FF0000FF' }, showValue: false,
			gradient: false, minLength: 20, maxLength: 80,
		});
		deepStrictEqual(exactResult(results, 'D2', 3).renderOverlay, {
			kind: 'iconSet', iconSet: '3TrafficLights1', iconIndex: 1, showValue: true, reverse: false,
		});
		strictEqual(exactResult(results, 'D2', 4).applies, false);
		strictEqual(exactResult(results, 'D2', 4).renderOverlay, undefined);
	});

	test('uses zero-aware autoMin/autoMax and treats known blank/text numeric targets as exact non-matches', () => {
		const cells = new Map<string, ParadisSemanticCell>([
			['D1', number(10)], ['D2', number(20)], ['D4', text('known text')],
		]);
		const model = parse(`
			<conditionalFormatting sqref="D1:D4">
				<cfRule type="dataBar" priority="1"><dataBar minLength="0" maxLength="100"><cfvo type="autoMin"/><cfvo type="autoMax"/><color rgb="FF0000FF"/></dataBar></cfRule>
				<cfRule type="top10" priority="2" rank="1"/>
				<cfRule type="aboveAverage" priority="3"/>
				<cfRule type="colorScale" priority="4"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FFFF0000"/><color rgb="FF00FF00"/></colorScale></cfRule>
				<cfRule type="iconSet" priority="5"><iconSet><cfvo type="percent" val="0"/><cfvo type="percent" val="33"/><cfvo type="percent" val="67"/></iconSet></cfRule>
				<cfRule type="timePeriod" priority="6" timePeriod="today"/>
			</conditionalFormatting>`);
		const results = resultsFor(model, snapshot(cells), ['D1', 'D3', 'D4'], 45_000);
		deepStrictEqual(exactResult(results, 'D1', 1).renderOverlay, {
			kind: 'dataBar', ratio: 0.5, color: { kind: 'rgb', rgb: 'FF0000FF' }, showValue: true,
			gradient: true, minLength: 0, maxLength: 100,
		});
		for (const address of ['D3', 'D4']) {
			for (let priority = 1; priority <= 6; priority++) {
				const result = exactResult(results, address, priority);
				strictEqual(result.applies, false, `${address} priority ${priority}`);
				strictEqual(result.renderOverlay, undefined);
			}
		}
	});

	test('evaluates finite extreme aggregates and visual ratios without intermediate overflow', () => {
		const maximum = Number.MAX_VALUE;
		const cells = new Map<string, ParadisSemanticCell>([
			['A1', number(maximum)], ['A2', number(maximum)], ['A3', number(-maximum)], ['A4', number(-maximum)],
			['B1', number(-maximum)], ['B2', number(0)], ['B3', number(maximum)],
		]);
		const model = parse(`
			<conditionalFormatting sqref="A1:A4"><cfRule type="aboveAverage" priority="1"/></conditionalFormatting>
			<conditionalFormatting sqref="B1:B3">
				<cfRule type="colorScale" priority="2"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FFFF0000"/><color rgb="FF00FF00"/></colorScale></cfRule>
				<cfRule type="dataBar" priority="3"><dataBar minLength="0" maxLength="100"><cfvo type="min"/><cfvo type="max"/><color rgb="FF0000FF"/></dataBar></cfRule>
			</conditionalFormatting>`);
		const results = resultsFor(model, snapshot(cells), ['A1', 'B2']);
		strictEqual(exactResult(results, 'A1', 1).applies, true);
		deepStrictEqual(exactResult(results, 'B2', 2).renderOverlay, {
			kind: 'colorScale', position: 0.5,
			lowerColor: { kind: 'rgb', rgb: 'FFFF0000' }, upperColor: { kind: 'rgb', rgb: 'FF00FF00' }, mix: 0.5,
		});
		deepStrictEqual(exactResult(results, 'B2', 3).renderOverlay, {
			kind: 'dataBar', ratio: 0.5, color: { kind: 'rgb', rgb: 'FF0000FF' }, showValue: true,
			gradient: true, minLength: 0, maxLength: 100,
		});
	});

	test('keeps conditional diagonal dxf provenance separate from raw base diagonal style and evaluation state', () => {
		const baseCell = number(10, 1);
		const workbook = snapshot(new Map([['A1', baseCell]]));
		const baseBorder = workbook.styles.borders[1];
		const baseDiagonal = baseBorder.diagonal;
		const model = parse(`
			<conditionalFormatting sqref="A1">
				<cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>0</formula></cfRule>
			</conditionalFormatting>`, `
			<dxfs count="1"><dxf><border diagonalUp="0" diagonalDown="1">
				<diagonal style="double"><color theme="4" tint="-0.25"/></diagonal>
			</border></dxf></dxfs>`);
		const rule = model.rules[0];
		const result = exactResult(resultsFor(model, workbook, ['A1']), 'A1', 1);

		strictEqual(rule.differentialStyleRef, 0);
		deepStrictEqual(model.differentialStyles[0].border, {
			diagonalUp: false, diagonalDown: true,
			diagonal: { style: 'double', color: { kind: 'theme', theme: 4, tint: '-0.25' } },
		});
		strictEqual(result.applies, true);
		strictEqual(result.renderOverlay?.kind, 'differentialStyle');
		notStrictEqual(result.renderOverlay, model.differentialStyles[0]);
		notStrictEqual(model.differentialStyles[0].border, baseBorder);
		notStrictEqual(model.differentialStyles[0].border?.diagonal, baseDiagonal);
		strictEqual(workbook.sheets[0].cells.get('A1'), baseCell);
		strictEqual(workbook.styles.borders[1], baseBorder);
		strictEqual(workbook.styles.borders[1].diagonal, baseDiagonal);
		deepStrictEqual(workbook.styles.borders[1], {
			index: 1, diagonalUp: true, diagonalDown: false,
			diagonal: { style: 'dashDot', color: { kind: 'rgb', rgb: 'FFFF0000' } },
		});
	});

	test('retains standard dxf alignment, protection, font metadata, and gradient fill semantics', () => {
		const model = parse(`
			<conditionalFormatting sqref="A1"><cfRule type="expression" dxfId="0" priority="1"><formula>1=1</formula></cfRule></conditionalFormatting>`, `
			<dxfs count="1"><dxf>
				<font><outline/><shadow val="0"/><vertAlign val="superscript"/><scheme val="minor"/><family val="2"/><charset val="1"/><condense/><extend val="0"/></font>
				<fill><gradientFill type="linear" degree="45"><stop position="0"><color rgb="FFFF0000"/></stop><stop position="1"><color rgb="FF0000FF"/></stop></gradientFill></fill>
				<alignment horizontal="center" vertical="top" textRotation="45" wrapText="1" shrinkToFit="0" indent="2" relativeIndent="-1" readingOrder="1"/>
				<protection locked="1" hidden="0"/>
				<extLst><ext uri="urn:test"/></extLst>
			</dxf></dxfs>`);
		deepStrictEqual(model.differentialStyles[0].font, {
			outline: true, shadow: false, verticalAlign: 'superscript', scheme: 'minor', family: '2', charset: '1', condense: true, extend: false,
		});
		deepStrictEqual(model.differentialStyles[0].fill, {
			gradient: {
				type: 'linear', degree: '45', stops: [
					{ position: '0', color: { kind: 'rgb', rgb: 'FFFF0000' } },
					{ position: '1', color: { kind: 'rgb', rgb: 'FF0000FF' } },
				],
			},
		});
		deepStrictEqual(model.differentialStyles[0].alignment, {
			horizontal: 'center', vertical: 'top', textRotation: 45, wrapText: true, shrinkToFit: false, indent: 2, relativeIndent: -1, readingOrder: 1,
		});
		deepStrictEqual(model.differentialStyles[0].protection, { locked: true, hidden: false });
		strictEqual(model.differentialStyles[0].hasExtensions, true);
		strictEqual(exactResult(resultsFor(model, snapshot(new Map([['A1', number(1)]])), ['A1']), 'A1', 1).applies, true);
	});

	test('retains pivot and extension presence while keeping extension XML out of render results', () => {
		const model = parse(`
			<conditionalFormatting sqref="A1" pivot="1">
				<cfRule type="expression" priority="1"><formula>1=1</formula><extLst><ext uri="urn:test"/></extLst></cfRule>
				<extLst><ext uri="urn:block"/></extLst>
			</conditionalFormatting>`);
		strictEqual(model.rules[0].pivot, true);
		strictEqual(model.rules[0].hasExtensions, true);
		strictEqual(exactResult(resultsFor(model, snapshot(new Map([['A1', number(1)]])), ['A1']), 'A1', 1).applies, true);
	});

	test('retains x14 data-bar negative and axis semantics with explicit unsupported evaluation', () => {
		const x14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
		const xm = 'http://schemas.microsoft.com/office/excel/2006/main';
		const xml = `<worksheet xmlns="${namespace}" xmlns:x14="${x14}" xmlns:xm="${xm}"><sheetData/><extLst><ext uri="{TEST}"><x14:conditionalFormattings><x14:conditionalFormatting><x14:cfRule type="dataBar" priority="1" id="{RULE}"><x14:dataBar minLength="5" maxLength="95" showValue="0" border="1" gradient="0" direction="rightToLeft" axisPosition="middle" negativeBarColorSameAsPositive="0" negativeBarBorderColorSameAsPositive="0"><x14:cfvo type="formula" gte="1"><xm:f>A1</xm:f></x14:cfvo><x14:cfvo type="autoMax"/><x14:fillColor rgb="FF00FF00"/><x14:borderColor rgb="FF008800"/><x14:negativeFillColor rgb="FFFF0000"/><x14:negativeBorderColor rgb="FF880000"/><x14:axisColor rgb="FF000000"/></x14:dataBar></x14:cfRule><x14:cfRule type="iconSet" priority="2" id="{ICON}" stopIfTrue="1" activePresent="0"><x14:iconSet iconSet="3Stars" custom="1"/></x14:cfRule><xm:sqref>A1:A2</xm:sqref></x14:conditionalFormatting></x14:conditionalFormattings></ext></extLst></worksheet>`;
		const model = parseRawWorksheet(xml);
		deepStrictEqual(model.rules[0].x14DataBar, {
			id: '{RULE}', minLength: 5, maxLength: 95, showValue: false, border: true, gradient: false,
			direction: 'rightToLeft', axisPosition: 'middle', negativeBarColorSameAsPositive: false,
			negativeBarBorderColorSameAsPositive: false,
			values: [{ type: 'formula', value: 'A1', greaterThanOrEqual: true }, { type: 'autoMax' }],
			fillColor: { kind: 'rgb', rgb: 'FF00FF00' }, borderColor: { kind: 'rgb', rgb: 'FF008800' },
			negativeFillColor: { kind: 'rgb', rgb: 'FFFF0000' }, negativeBorderColor: { kind: 'rgb', rgb: 'FF880000' },
			axisColor: { kind: 'rgb', rgb: 'FF000000' },
		});
		const opaqueIcon = model.rules[1].x14OpaqueRule!;
		deepStrictEqual({ type: opaqueIcon.type, id: opaqueIcon.id, childType: opaqueIcon.childType, attributes: opaqueIcon.attributes }, {
			type: 'iconSet', id: '{ICON}', childType: 'cfRule', attributes: { activePresent: '0', id: '{ICON}', priority: '2', stopIfTrue: '1', type: 'iconSet' },
		});
		deepStrictEqual(opaqueIcon.elements.map(element => [element.parentIndex, element.depth, element.ordinal, element.path, element.local]), [
			[undefined, 0, 0, '0', 'cfRule'], [0, 1, 0, '0/0', 'iconSet'],
		]);
		deepStrictEqual(opaqueIcon.events.map(event => [event.kind, event.path]), [['start', '0'], ['start', '0/0'], ['end', '0/0'], ['end', '0']]);
		strictEqual(model.rules[1].stopIfTrue, true);
		const flatXml = xml.replace('<x14:iconSet iconSet="3Stars" custom="1"/>', '<x14:iconSet iconSet="3Stars" custom="1"><x14:cfIcon iconSet="3Stars" iconId="0"/><x14:cfIcon iconSet="3Stars" iconId="1"/></x14:iconSet>');
		const nestedXml = xml.replace('<x14:iconSet iconSet="3Stars" custom="1"/>', '<x14:iconSet iconSet="3Stars" custom="1"><x14:cfIcon iconSet="3Stars" iconId="0"><x14:cfIcon iconSet="3Stars" iconId="1"/></x14:cfIcon></x14:iconSet>');
		notStrictEqual(JSON.stringify(parseRawWorksheet(flatXml).rules[1].x14OpaqueRule?.elements), JSON.stringify(parseRawWorksheet(nestedXml).rules[1].x14OpaqueRule?.elements));
		const results = resultsFor(model, snapshot(new Map([['A1', number(-1)]])), ['A1']);
		deepStrictEqual(results.map(result => result.status === 'notEvaluated' ? result.reason : undefined), ['unsupportedExtension', 'unsupportedExtension']);
		const amplified = xml.replace('</x14:conditionalFormattings>', '<x14:conditionalFormatting><x14:cfRule type="iconSet" priority="3"><x14:iconSet iconSet="3Stars"/></x14:cfRule><xm:sqref>B1</xm:sqref></x14:conditionalFormatting></x14:conditionalFormattings>');
		throws(() => parseRawWorksheet(amplified, { limits: { ranges: 1 } }), error => error instanceof ParadisOfficePackageError && error.code === 'limitExceeded');
		throws(() => parseRawWorksheet(xml, { limits: { rules: 1 } }), error => error instanceof ParadisOfficePackageError && error.code === 'limitExceeded');
		const tooManyValues = xml.replace('<x14:fillColor', '<x14:cfvo type="num"><xm:f>0</xm:f></x14:cfvo><x14:fillColor');
		const tooManyValuesModel = parseRawWorksheet(tooManyValues);
		strictEqual(tooManyValuesModel.rules[0].x14DataBar, undefined);
		strictEqual(tooManyValuesModel.rules[0].type, 'unsupported');
		const tooManyFormulas = xml.replace('<x14:dataBar', '<xm:f>1</xm:f><xm:f>2</xm:f><xm:f>3</xm:f><xm:f>4</xm:f><x14:dataBar');
		throws(() => parseRawWorksheet(tooManyFormulas), error => error instanceof ParadisOfficePackageError && error.code === 'limitExceeded');
		const futureDataBar = xml
			.replace('axisPosition="middle"', 'axisPosition="middle" futureFlag="1"')
			.replace('</x14:dataBar>', '<x14:futureChild val="1"/></x14:dataBar>');
		const futureModel = parseRawWorksheet(futureDataBar);
		strictEqual(futureModel.rules[0].x14DataBar, undefined);
		strictEqual(futureModel.rules[0].type, 'unsupported');
		strictEqual(futureModel.rules[0].x14OpaqueRule?.elements.some(element => element.local === 'futureChild'), true);
		const futureResult = resultsFor(futureModel, snapshot(new Map([['A1', number(1)]])), ['A1'])[0];
		deepStrictEqual(futureResult.status === 'notEvaluated' ? futureResult.reason : undefined, 'unsupportedExtension');
		const futureTextModel = parseRawWorksheet(xml.replace('<x14:dataBar', 'future<x14:dataBar'));
		strictEqual(futureTextModel.rules[0].x14DataBar, undefined);
		strictEqual(futureTextModel.rules[0].x14OpaqueRule?.events.some(event => event.kind === 'text' && event.text === 'future'), true);
	});

	test('joins an optional-priority x14 data bar to its base rule extension id', () => {
		const x14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
		const xm = 'http://schemas.microsoft.com/office/excel/2006/main';
		const xml = `<worksheet xmlns="${namespace}" xmlns:x14="${x14}" xmlns:xm="${xm}"><sheetData/><conditionalFormatting sqref="A1"><cfRule type="dataBar" priority="1"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF00FF00"/></dataBar><extLst><ext uri="{JOIN}"><x14:id>{LINK}</x14:id></ext></extLst></cfRule></conditionalFormatting><extLst><ext uri="{X14}"><x14:conditionalFormattings><x14:conditionalFormatting><x14:cfRule type="dataBar" id="{LINK}"><x14:dataBar direction="leftToRight"><x14:cfvo type="autoMin"/><x14:cfvo type="autoMax"/><x14:fillColor rgb="FF00FF00"/></x14:dataBar></x14:cfRule><xm:sqref>A1</xm:sqref></x14:conditionalFormatting></x14:conditionalFormattings></ext></extLst></worksheet>`;
		const model = parseRawWorksheet(xml);
		strictEqual(model.rules.length, 1);
		strictEqual(model.rules[0].extensionId, '{LINK}');
		strictEqual(model.rules[0].x14DataBar?.direction, 'leftToRight');
		const result = resultsFor(model, snapshot(new Map([['A1', number(1)]])), ['A1'])[0];
		deepStrictEqual(result.status === 'notEvaluated' ? result.reason : undefined, 'unsupportedExtension');
		const conflicting = parseRawWorksheet(xml.replace('<xm:sqref>A1</xm:sqref>', '<xm:sqref>B1</xm:sqref>'));
		strictEqual(conflicting.rules[0].x14DataBar, undefined);
		strictEqual(conflicting.rules.some(rule => rule.type === 'unsupported' && rule.x14OpaqueRule?.type === 'dataBar'), true);
	});

	test('preserves opaque x14 text and element event order without topology collisions', () => {
		const x14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
		const xm = 'http://schemas.microsoft.com/office/excel/2006/main';
		const wrap = (body: string) => `<worksheet xmlns="${namespace}" xmlns:x14="${x14}" xmlns:xm="${xm}"><sheetData/><extLst><ext uri="urn:test"><x14:conditionalFormattings><x14:conditionalFormatting><x14:cfRule type="iconSet" priority="1"><x14:iconSet>${body}</x14:iconSet></x14:cfRule><xm:sqref>A1</xm:sqref></x14:conditionalFormatting></x14:conditionalFormattings></ext></extLst></worksheet>`;
		const interleaved = parseRawWorksheet(wrap('a<x14:cfIcon iconId="0"/>b')).rules[0].x14OpaqueRule?.events;
		const grouped = parseRawWorksheet(wrap('ab<x14:cfIcon iconId="0"/>')).rules[0].x14OpaqueRule?.events;
		notStrictEqual(JSON.stringify(interleaved), JSON.stringify(grouped));
	});

	test('binds worksheet and styles all-byte sources to the evaluated semantic snapshot', () => {
		const model = parse(`
			<conditionalFormatting sqref="A1"><cfRule type="expression" dxfId="0" priority="1"><formula>1=1</formula></cfRule></conditionalFormatting>`,
			'<dxfs count="1"><dxf><font><b/></font></dxf></dxfs>');
		const rawWorkbook = snapshot(new Map([['A1', number(1)]]));
		const workbook: ParadisSpreadsheetSnapshot = {
			...rawWorkbook,
			sheets: [{ ...rawWorkbook.sheets[0], partId: model.worksheetSource.partId, source: model.worksheetSource }, rawWorkbook.sheets[1]],
			styles: { ...rawWorkbook.styles, source: model.stylesSource },
		};
		const wrongWorksheet = {
			...workbook,
			sheets: [{ ...workbook.sheets[0], partId: otherWorksheetSource.partId, source: otherWorksheetSource }, workbook.sheets[1]],
		};
		const wrongStyles = {
			...workbook,
			styles: { ...workbook.styles, source: { ...stylesSource, fingerprint: { ...stylesSource.fingerprint, value: '5'.repeat(64) } } },
		};
		const foreignChildSource = {
			...model,
			differentialStyles: [{ ...model.differentialStyles[0], source: { ...stylesSource, fingerprint: { ...stylesSource.fingerprint, value: '6'.repeat(64) } } }],
		};
		const foreignRuleSource = {
			...model,
			rules: [{ ...model.rules[0], source: otherWorksheetSource }],
		};
		const forgedFormulaModel = {
			...model,
			rules: [{ ...model.rules[0], formulas: ['0=1'] }],
		};
		const evaluate = (candidateModel: typeof model, candidateWorkbook: ParadisSpreadsheetSnapshot) => evaluateSpreadsheetConditionalFormattingOwned(candidateModel, candidateWorkbook, { sheetName: 'Sheet1', addresses: ['A1'] });
		throws(() => evaluate(model, wrongWorksheet), error => error instanceof ParadisOfficePackageError && error.code === 'unsafe');
		throws(() => evaluate(model, wrongStyles), error => error instanceof ParadisOfficePackageError && error.code === 'unsafe');
		throws(() => evaluate(foreignChildSource, workbook), error => error instanceof ParadisOfficePackageError && error.code === 'unsafe');
		throws(() => evaluate(foreignRuleSource, workbook), error => error instanceof ParadisOfficePackageError && error.code === 'unsafe');
		throws(() => evaluate(forgedFormulaModel, workbook), error => error instanceof ParadisOfficePackageError && error.code === 'unsafe');
	});

	test('enforces namespace, exact CF schema, reference, count, formula, ownership, cancellation, and deadline bounds', () => {
		const invalid = (fn: () => unknown, code: ParadisOfficePackageError['code']) => throws(fn, error => error instanceof ParadisOfficePackageError && error.code === code);
		deepStrictEqual(fingerprintSpreadsheetConditionalFormattingXml('abc'), {
			algorithm: 'sha256', value: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', byteLength: 3,
		});
		const authoritativeXml = worksheet('<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>0=1</formula></cfRule></conditionalFormatting>');
		invalid(() => parseSpreadsheetConditionalFormatting({
			worksheetXml: authoritativeXml.replace('0=1', '1=1'),
			worksheetSource: sourceFor(worksheetSource.partId, authoritativeXml),
		}), 'unsafe');
		invalid(() => parseRawWorksheet('<worksheet xmlns="urn:wrong"><sheetData/><conditionalFormatting sqref="A1"/></worksheet>'), 'malformed');
		invalid(() => parse('<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1" surprise="yes"><formula>1=1</formula></cfRule></conditionalFormatting>'), 'malformed');
		invalid(() => parse('<conditionalFormatting sqref="XFE1"><cfRule type="expression" priority="1"><formula>1=1</formula></cfRule></conditionalFormatting>'), 'malformed');
		invalid(() => parse('<conditionalFormatting sqref="A1048577"><cfRule type="expression" priority="1"><formula>1=1</formula></cfRule></conditionalFormatting>'), 'malformed');
		invalid(() => parse('<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>1=1</formula></cfRule><cfRule type="expression" priority="1"><formula>1=1</formula></cfRule></conditionalFormatting>'), 'malformed');
		invalid(() => parse('<conditionalFormatting sqref="A1"><cfRule type="top10" priority="1" rank="101" percent="1"/></conditionalFormatting>'), 'malformed');
		invalid(() => parse('<conditionalFormatting sqref="A1"><cfRule type="top10" priority="1" rank="1001"/></conditionalFormatting>'), 'malformed');
		invalid(() => parse('<conditionalFormatting sqref="A1"><cfRule type="aboveAverage" priority="1" equalAverage="1" stdDev="1"/></conditionalFormatting>'), 'malformed');
		invalid(() => parse('<conditionalFormatting sqref="A1"><cfRule type="aboveAverage" priority="1" equalAverage="1" stdDev="0"/></conditionalFormatting>'), 'malformed');
		invalid(() => parse('<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1" rank="1"><formula>1=1</formula></cfRule></conditionalFormatting>'), 'malformed');
		invalid(() => parse('<conditionalFormatting sqref="A1"><cfRule type="dataBar" priority="1"><dataBar minLength="80" maxLength="20"><cfvo type="min"/><cfvo type="max"/><color rgb="FF000000"/></dataBar></cfRule></conditionalFormatting>'), 'malformed');
		invalid(() => parse('<conditionalFormatting sqref="A1"><cfRule type="dataBar" priority="1"><dataBar minLength="95"><cfvo type="min"/><cfvo type="max"/><color rgb="FF000000"/></dataBar></cfRule></conditionalFormatting>'), 'malformed');
		invalid(() => parse('<conditionalFormatting sqref="A1"><cfRule type="dataBar" priority="1"><dataBar maxLength="5"><cfvo type="min"/><cfvo type="max"/><color rgb="FF000000"/></dataBar></cfRule></conditionalFormatting>'), 'malformed');
		invalid(() => parse('<conditionalFormatting sqref="A1"><cfRule type="colorScale" priority="1"><colorScale><cfvo type="min">EVIL</cfvo><cfvo type="max"/><color rgb="FFFF0000"/><color rgb="FF00FF00"/></colorScale></cfRule></conditionalFormatting>'), 'malformed');
		invalid(() => parse('<conditionalFormatting sqref="A1"><cfRule type="expression" dxfId="0" priority="1"><formula>1=1</formula></cfRule></conditionalFormatting>', '<dxfs count="1"><dxf><font><b>EVIL</b></font></dxf></dxfs>'), 'malformed');
		invalid(() => parse('<conditionalFormatting sqref="A1">EVIL<cfRule type="expression" priority="1"><formula>1=1</formula></cfRule></conditionalFormatting>'), 'malformed');
		invalid(() => parse('<conditionalFormatting sqref="A1"/>'), 'malformed');
		invalid(() => parseRawWorksheet(worksheet('<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>1=1</formula></cfRule><cfRule type="expression" priority="2"><formula>1=1</formula></cfRule></conditionalFormatting>'), { limits: { rules: 1 } }), 'limitExceeded');
		invalid(() => parseRawWorksheet(worksheet('<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>12345</formula></cfRule></conditionalFormatting>'), { limits: { formulaBytes: 4 } }), 'limitExceeded');
		invalid(() => parseRawWorksheet(worksheet('<conditionalFormatting sqref="A1"><cfRule type="colorScale" priority="1"><colorScale><cfvo type="formula" val="12345"/><cfvo type="max"/><color rgb="FFFF0000"/><color rgb="FF00FF00"/></colorScale></cfRule></conditionalFormatting>'), { limits: { formulaBytes: 4 } }), 'limitExceeded');
		invalid(() => parseRawWorksheet(worksheet('<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>1=1</formula></cfRule></conditionalFormatting>'), { cancellationToken: CancellationToken.Cancelled }), 'cancelled');
		invalid(() => parseRawWorksheet(worksheet('<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>1=1</formula></cfRule></conditionalFormatting>'), { limits: { outputNodes: 1 } }), 'limitExceeded');

		let clock = 0;
		invalid(() => parseRawWorksheet(worksheet('<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>1=1</formula></cfRule></conditionalFormatting>'), { now: () => clock++, deadlineMilliseconds: 1 }), 'limitExceeded');
		invalid(() => parseSpreadsheetConditionalFormatting(new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error('secret'); } }) as never), 'unsafe');
		invalid(() => parseSpreadsheetConditionalFormatting(Object.defineProperty({}, 'worksheetXml', { get: () => worksheet('') }) as never), 'unsafe');
		const cancelledModel = parse('<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>1=1</formula></cfRule></conditionalFormatting>');
		invalid(() => evaluateSpreadsheetConditionalFormattingOwned(cancelledModel, snapshot(new Map([['A1', number(1)]])), { sheetName: 'Sheet1', addresses: ['A1'], cancellationToken: CancellationToken.Cancelled }), 'cancelled');
	});

	test('evaluates a 100k-cell top rule within the bounded linear selection budget', () => {
		const cells = new Map<string, ParadisSemanticCell>();
		for (let row = 1; row <= 100_000; row++) {
			cells.set(`A${row}`, number(row));
		}
		const model = parse('<conditionalFormatting sqref="A1:A100000"><cfRule type="top10" priority="1" rank="10"/></conditionalFormatting>');
		strictEqual(exactResult(resultsFor(model, snapshot(cells), ['A100000']), 'A100000', 1).applies, true);
	});

	test('owns a block-shared range list once across many rules', () => {
		const sqref = Array.from({ length: 100 }, () => 'A1').join(' ');
		const rules = Array.from({ length: 1001 }, (_, index) => `<cfRule type="containsText" priority="${index + 1}" text="x"/>`).join('');
		const model = parse(`<conditionalFormatting sqref="${sqref}">${rules}</conditionalFormatting>`);
		strictEqual(model.rules[0].ranges, model.rules[1000].ranges);
		strictEqual(resultsFor(model, snapshot(new Map([['A1', text('x')]])), ['A1']).length, 1001);
	});

	test('bounds formula recursion, aggregate work, serial dates, and caller-programmable arrays', () => {
		const unaryModel = parse(`<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>${'-'.repeat(32)}1</formula></cfRule></conditionalFormatting>`);
		const unaryWorkbook = bindSnapshot(unaryModel, snapshot(new Map([['A1', number(1)]])));
		throws(() => evaluateSpreadsheetConditionalFormattingOwned(unaryModel, unaryWorkbook, {
			sheetName: 'Sheet1', addresses: ['A1'], limits: { formulaDepth: 8 },
		}), error => error instanceof ParadisOfficePackageError && error.code === 'limitExceeded');
		const formulaBudgetModel = parse('<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>1=1</formula></cfRule></conditionalFormatting>');
		const formulaBudgetWorkbook = bindSnapshot(formulaBudgetModel, snapshot(new Map([['A1', formula('B1+1', { present: false })]])));
		throws(() => evaluateSpreadsheetConditionalFormattingOwned(formulaBudgetModel, formulaBudgetWorkbook, {
			sheetName: 'Sheet1', addresses: ['A1'], limits: { formulaBytes: 4 },
		}), error => error instanceof ParadisOfficePackageError && error.code === 'limitExceeded');

		const aggregateModel = parse('<conditionalFormatting sqref="A1:A3"><cfRule type="top10" priority="1" rank="1"/></conditionalFormatting>');
		const aggregateWorkbook = bindSnapshot(aggregateModel, snapshot(new Map([['A1', number(1)], ['A2', number(2)], ['A3', number(3)]])));
		throws(() => evaluateSpreadsheetConditionalFormattingOwned(aggregateModel, aggregateWorkbook, {
			sheetName: 'Sheet1', addresses: ['A1'], limits: { evaluationOperations: 2 },
		}), error => error instanceof ParadisOfficePackageError && error.code === 'limitExceeded');

		const timeModel = parse('<conditionalFormatting sqref="A1"><cfRule type="timePeriod" priority="1" timePeriod="thisMonth"/></conditionalFormatting>');
		const timeResult = resultsFor(timeModel, snapshot(new Map([['A1', number(2_958_466)]])), ['A1'], 2_958_466)[0];
		deepStrictEqual(timeResult.status === 'notEvaluated' ? timeResult.reason : undefined, 'invalidValue');

		let speciesReads = 0;
		class HostileArray<T> extends Array<T> {
			static override get [Symbol.species](): ArrayConstructor {
				speciesReads++;
				return Array;
			}
		}
		const visualModel = parse('<conditionalFormatting sqref="A1"><cfRule type="colorScale" priority="1"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FFFF0000"/><color rgb="FF00FF00"/></colorScale></cfRule></conditionalFormatting>');
		const visualRule = visualModel.rules[0].visualRule!;
		const colors = visualRule.kind === 'colorScale' ? visualRule.colors : [];
		const hostileModel = {
			...visualModel,
			rules: [{ ...visualModel.rules[0], visualRule: { ...visualRule, colors: new HostileArray(...colors) } }],
		};
		throws(() => resultsFor(hostileModel, snapshot(new Map([['A1', number(1)]])), ['A1']), error => error instanceof ParadisOfficePackageError && error.code === 'unsafe');
		strictEqual(speciesReads, 0);

		const overflowModel = parse('<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>1E308*10&gt;0</formula></cfRule></conditionalFormatting>');
		const overflow = resultsFor(overflowModel, snapshot(new Map([['A1', number(1)]])), ['A1'])[0];
		deepStrictEqual(overflow.status === 'notEvaluated' ? overflow.reason : undefined, 'invalidValue');
	});
});
