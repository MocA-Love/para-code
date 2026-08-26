/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok, strictEqual, throws } from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ParadisOfficeChange, ParadisOfficeFingerprint } from '../../common/paradisOfficeProtocol.js';
import {
	alignSpreadsheetGrid,
	matchSpreadsheetSheets,
} from '../../common/spreadsheet/paradisSpreadsheetGridAlign.js';
import {
	compareSpreadsheetSemantics,
	selectSpreadsheetSheetAlignment,
	type ParadisSpreadsheetSemanticDiffPage,
} from '../../common/spreadsheet/paradisSpreadsheetSemanticDiff.js';
import type {
	ParadisSemanticCell,
	ParadisSemanticColumn,
	ParadisSemanticRow,
	ParadisSemanticSheet,
	ParadisSpreadsheetPartSource,
	ParadisSpreadsheetSnapshot,
} from '../../common/spreadsheet/paradisSpreadsheetSemantic.js';
import type { ParadisSpreadsheetObjects } from '../../common/spreadsheet/paradisSpreadsheetObjects.js';

function fingerprint(seed: string, byteLength = 1): ParadisOfficeFingerprint {
	return { algorithm: 'sha256', value: seed.repeat(64).slice(0, 64), byteLength };
}

function source(partId: string, seed = 'a'): ParadisSpreadsheetPartSource {
	return { partId, fingerprint: fingerprint(seed) };
}

function number(raw: string, styleRef?: number): ParadisSemanticCell {
	return { storedType: 'number', rawValue: { present: true, text: raw }, ...(styleRef === undefined ? {} : { styleRef, effectiveStyleRef: styleRef }) };
}

function text(raw: string, styleRef?: number): ParadisSemanticCell {
	return { storedType: 'string', rawType: 'str', rawValue: { present: true, text: raw }, ...(styleRef === undefined ? {} : { styleRef, effectiveStyleRef: styleRef }) };
}

function formula(expression: string, result = '1'): ParadisSemanticCell {
	return {
		storedType: 'formula', rawType: 'n', formula: { text: expression, kind: 'normal' },
		cachedResult: { present: true, type: 'number', rawValue: result },
	};
}

interface SheetOptions {
	readonly name?: string;
	readonly sheetId?: string;
	readonly order?: number;
	readonly state?: 'visible' | 'hidden' | 'veryHidden';
	readonly partId?: string;
	readonly sourceSeed?: string;
	readonly rows?: readonly ParadisSemanticRow[];
	readonly columns?: readonly ParadisSemanticColumn[];
	readonly merges?: readonly string[];
	readonly conditionalFormatting?: ParadisSemanticSheet['conditionalFormatting'];
	readonly annotations?: ParadisSemanticSheet['annotations'];
	readonly objects?: ParadisSpreadsheetObjects;
}

function range(ref: string) {
	const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref)!;
	const column = (value: string): number => [...value].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0);
	return { ref, minRow: Number(match[2]), minColumn: column(match[1]), maxRow: Number(match[4]), maxColumn: column(match[3]) };
}

function sheet(cells: Readonly<Record<string, ParadisSemanticCell>>, options: SheetOptions = {}): ParadisSemanticSheet {
	const partId = options.partId ?? '/xl/worksheets/sheet1.xml';
	return {
		name: options.name ?? 'Sheet1', sheetId: options.sheetId ?? '1', order: options.order ?? 0,
		state: options.state ?? 'visible', relationshipId: `rId${options.sheetId ?? '1'}`, partId,
		source: source(partId, options.sourceSeed ?? 'b'), views: [],
		rows: new Map((options.rows ?? []).map(row => [row.index, row])), columns: options.columns ?? [],
		merges: (options.merges ?? []).map(range), cells: new Map(Object.entries(cells)),
		...(options.conditionalFormatting ? { conditionalFormatting: options.conditionalFormatting } : {}),
		...(options.annotations ? { annotations: options.annotations } : {}),
		...(options.objects ? { objects: options.objects } : {}),
	} as ParadisSemanticSheet;
}

interface SnapshotOptions {
	readonly definedNames?: ParadisSpreadsheetSnapshot['definedNames'];
	readonly numberFormats?: ParadisSpreadsheetSnapshot['styles']['numberFormats'];
	readonly cellFormats?: ParadisSpreadsheetSnapshot['styles']['cellFormats'];
	readonly borders?: ParadisSpreadsheetSnapshot['styles']['borders'];
}

function snapshot(sheets: readonly ParadisSemanticSheet[], options: SnapshotOptions = {}): ParadisSpreadsheetSnapshot {
	return {
		workbookSource: source('/xl/workbook.xml', 'c'), date1904: false, definedNames: options.definedNames ?? [], workbookViews: [], sheets,
		styles: {
			source: source('/xl/styles.xml', 'd'), numberFormats: options.numberFormats ?? [], cellFormats: options.cellFormats ?? [], borders: options.borders ?? [],
			completeness: { parsedCellFormats: options.cellFormats?.length ?? 0, parsedBorders: options.borders?.length ?? 0, cellsWithStyleRefs: 0, unresolvedStyleRefs: 0, cellsWithDiagonalStyleRefs: 0 },
		},
		completeness: { expectedParts: 3, visitedParts: 3, parsedParts: 3, expectedSheets: sheets.length, parsedSheets: sheets.length, expectedCells: sheets.reduce((count, item) => count + item.cells.size, 0), parsedCells: sheets.reduce((count, item) => count + item.cells.size, 0), unknownElements: 0, unknownAttributes: 0, unresolvedReferences: 0, terminal: true },
		projectionDiagnostics: [],
	};
}

function changesOf(page: ParadisSpreadsheetSemanticDiffPage, kind: string): readonly ParadisOfficeChange[] {
	return page.changes.filter(change => change.subject.kind === kind);
}

function emptyObjects(overrides: Partial<ParadisSpreadsheetObjects> = {}): ParadisSpreadsheetObjects {
	return {
		images: [], drawings: [], charts: [], opaqueDrawings: [], pivots: [],
		security: { sheetProtections: [], unsafeParts: [], externalReferences: [] }, opaqueParts: [], ...overrides,
	};
}

suite('Paradis Spreadsheet Semantic Diff', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('compares formula identity and stored type even when the displayed result is unchanged', () => {
		const page = compareSpreadsheetSemantics(
			snapshot([sheet({ A1: formula('1+0'), B1: text('anchor-b'), C1: number('1'), D1: text('anchor-d') })]),
			snapshot([sheet({ A1: formula('2-1'), B1: text('anchor-b'), C1: text('1'), D1: text('anchor-d') })]),
		);
		strictEqual(changesOf(page, 'cell.formula').length, 1);
		strictEqual(changesOf(page, 'cell.storedType').length, 1);
		strictEqual(changesOf(page, 'cell.cachedResult').length, 0);
	});

	test('reports number-format and raw diagonal changes independently from conditional-format diagonals', () => {
		const originalCf = {
			worksheetSource: source('/xl/worksheets/sheet1.xml'), stylesSource: source('/xl/styles.xml'), rules: [],
			differentialStyles: [{ index: 0, source: source('/xl/styles.xml'), border: { diagonalUp: true, diagonal: { style: 'thin', color: { kind: 'rgb' as const, rgb: 'FFFF0000' } } } }],
		};
		const modifiedCf = {
			...originalCf,
			differentialStyles: [{ index: 0, source: source('/xl/styles.xml'), border: { diagonalDown: true, diagonal: { style: 'dashDot', color: { kind: 'theme' as const, theme: 2, tint: '-0.25' } } } }],
		};
		const original = snapshot([sheet({ A1: number('1', 0) }, { conditionalFormatting: originalCf })], {
			numberFormats: [{ id: 164, code: '0.00' }], cellFormats: [{ index: 0, numberFormatId: 164, borderRef: 0 }],
			borders: [{ index: 0, diagonalUp: true, diagonal: { style: 'thin', color: { kind: 'rgb', rgb: 'FFFF0000' } } }],
		});
		const modified = snapshot([sheet({ A1: number('1', 0) }, { conditionalFormatting: modifiedCf })], {
			numberFormats: [{ id: 164, code: '#,##0' }], cellFormats: [{ index: 0, numberFormatId: 164, borderRef: 0 }],
			borders: [{ index: 0, diagonalDown: true, diagonal: { style: 'dashDot', color: { kind: 'theme', theme: 2, tint: '-0.25' } } }],
		});
		const page = compareSpreadsheetSemantics(original, modified);
		strictEqual(changesOf(page, 'cell.numberFormat').length, 1);
		strictEqual(changesOf(page, 'cell.diagonalBorder').length, 1);
		strictEqual(changesOf(page, 'conditionalFormatting.diagonalBorder').length, 1);
		for (const change of [...changesOf(page, 'cell.diagonalBorder'), ...changesOf(page, 'conditionalFormatting.diagonalBorder')]) {
			strictEqual(change.category, 'formatting');
		}
	});

	test('aligns inserted and moved rows and columns from content without using styles', () => {
		const original = sheet({ A1: text('a', 0), B1: text('x'), A2: text('b'), B2: text('y'), A3: text('c'), B3: text('z') });
		const modified = sheet({ A1: text('c', 9), B1: text('z'), A2: text('new'), B2: text('n'), A3: text('a', 8), B3: text('x'), A4: text('b'), B4: text('y') });
		const alignment = alignSpreadsheetGrid(original, modified);
		ok(alignment.rows.some(entry => entry.original === 3 && entry.modified === 1 && entry.status === 'moved'));
		ok(alignment.rows.some(entry => entry.original === undefined && entry.modified === 2 && entry.status === 'added'));
		ok(alignment.rows.some(entry => entry.original === 1 && entry.modified === 3));
		const insertionOnly = alignSpreadsheetGrid(
			sheet({ A1: text('a'), B1: text('p'), A2: text('b'), B2: text('q') }),
			sheet({ A1: text('new'), B1: text('n'), A2: text('a'), B2: text('p'), A3: text('b'), B3: text('q') }),
		);
		strictEqual(insertionOnly.columns.filter(entry => entry.original !== undefined && entry.modified !== undefined).length, 2);
		const insertedRows = insertionOnly.rows;
		strictEqual(insertedRows.filter(entry => entry.original !== undefined && entry.modified !== undefined).every(entry => entry.status === 'aligned'), true);

		const originalColumns = sheet({ A1: text('a'), B1: text('b'), C1: text('c'), A2: text('p'), B2: text('q'), C2: text('r') });
		const modifiedColumns = sheet({ A1: text('c'), B1: text('new'), C1: text('a'), D1: text('b'), A2: text('r'), B2: text('n'), C2: text('p'), D2: text('q') });
		const columnMove = alignSpreadsheetGrid(originalColumns, modifiedColumns);
		strictEqual(columnMove.rows.filter(entry => entry.original !== undefined && entry.modified !== undefined).length, 2);
		const columns = columnMove.columns;
		ok(columns.some(entry => entry.original === 3 && entry.modified === 1 && entry.status === 'moved'));
		ok(columns.some(entry => entry.original === undefined && entry.modified === 2 && entry.status === 'added'));
	});

	test('keeps duplicate ties explicit and handles the 2,000-row boundary without index fallback', () => {
		const duplicateOriginal = sheet({ A1: text('same'), A2: text('same') });
		const duplicateModified = sheet({ A1: text('same'), A2: text('same'), A3: text('same') });
		const duplicate = alignSpreadsheetGrid(duplicateOriginal, duplicateModified).rows;
		strictEqual(duplicate.filter(entry => entry.certainty === 'ambiguous').length, 5);
		strictEqual(duplicate.some(entry => entry.original !== undefined && entry.modified !== undefined), false);
		const duplicateColumns = alignSpreadsheetGrid(
			sheet({ A1: text('same'), B1: text('same') }),
			sheet({ A1: text('same'), B1: text('same'), C1: text('same') }),
		).columns;
		strictEqual(duplicateColumns.filter(entry => entry.certainty === 'ambiguous').length, 5);

		const cells: Record<string, ParadisSemanticCell> = {};
		for (let row = 1; row <= 2_000; row++) {
			cells[`A${row}`] = text(`row-${row}`);
		}
		const aligned = alignSpreadsheetGrid(sheet(cells), sheet(cells)).rows;
		strictEqual(aligned.length, 2_000);
		deepStrictEqual(aligned[1_999], { original: 2_000, modified: 2_000, status: 'aligned', certainty: 'exact' });
	});

	test('reports hidden rows, row and column sizes, merges, sheet rename/order/state, and defined names', () => {
		const originalSheet = sheet({ A1: text('stable') }, {
			name: 'Before', order: 0, rows: [{ index: 1, height: '15', hidden: false }], columns: [{ min: 1, max: 1, width: '8' }], merges: ['A1:B1'],
		});
		const modifiedSheet = sheet({ A1: text('stable') }, {
			name: 'After', order: 2, state: 'veryHidden', rows: [{ index: 1, height: '20', hidden: true }], columns: [{ min: 1, max: 1, width: '12' }], merges: ['A1:C1'],
		});
		const page = compareSpreadsheetSemantics(
			snapshot([originalSheet], { definedNames: [{ name: 'Named', text: 'Before!$A$1' }] }),
			snapshot([modifiedSheet], { definedNames: [{ name: 'Named', text: 'After!$A$1' }] }),
		);
		for (const kind of ['sheet.name', 'sheet.order', 'sheet.state', 'row.properties', 'column.properties', 'sheet.merges', 'workbook.definedNames']) {
			strictEqual(changesOf(page, kind).length, 1, kind);
		}
	});

	test('separates annotations, object line geometry, security, and opaque object parts', () => {
		const annotations = (suffix: string) => ({
			worksheetSource: source('/xl/worksheets/sheet1.xml'), contentTypesSource: source('/[Content_Types].xml'), rootRelationshipsSource: source('/_rels/.rels'), workbookSource: source('/xl/workbook.xml'), worksheetRelationshipsSource: source('/xl/worksheets/_rels/sheet1.xml.rels'), workbookRelationshipsSource: source('/xl/_rels/workbook.xml.rels'), validations: [], legacyNotes: [], threadedComments: [], persons: [], hyperlinks: [], opaqueFragments: [{ name: { namespace: 'urn:test', local: `opaque-${suffix}` }, path: '/worksheet/extLst/ext', ordinal: 0, source: source('/xl/worksheets/sheet1.xml'), fingerprint: fingerprint(suffix) }], cellOverlays: [], rangeOverlays: [],
		});
		const objects = (endRow: number, suffix: string): ParadisSpreadsheetObjects => emptyObjects({
			drawings: [{ id: 'line-1', kind: 'line', source: source('/xl/drawings/drawing1.xml'), anchor: { kind: 'twoCell', from: { row: 0, rowOffset: 0, column: 0, columnOffset: 0 }, to: { row: endRow, rowOffset: 0, column: 1, columnOffset: 0 } }, lineGeometry: { kind: 'cellAnchored', start: { row: 0, rowOffset: 0, column: 0, columnOffset: 0 }, end: { row: endRow, rowOffset: 0, column: 1, columnOffset: 0 }, diagonal: 'down' } }],
			security: { sheetProtections: [], unsafeParts: [{ kind: 'vba', contentType: 'application/vba', fingerprint: fingerprint(suffix), behavior: 'notExecuted' }], externalReferences: [] },
			opaqueParts: [{ contentType: 'application/test', fingerprint: fingerprint(suffix), evaluation: 'notEvaluated' }],
		});
		const page = compareSpreadsheetSemantics(
			snapshot([sheet({ A1: text('same') }, { annotations: annotations('a'), objects: objects(1, 'a') })]),
			snapshot([sheet({ A1: text('same') }, { annotations: annotations('b'), objects: objects(2, 'b') })]),
		);
		strictEqual(changesOf(page, 'sheet.annotations').length, 1);
		strictEqual(changesOf(page, 'object.lineGeometry').length, 1);
		strictEqual(changesOf(page, 'sheet.security').length, 1);
		const opaque = changesOf(page, 'object.opaquePart');
		strictEqual(opaque.length, 1);
		strictEqual(opaque[0].certainty, 'opaque');
		strictEqual(changesOf(page, 'object.lineGeometry')[0].category, 'object');
	});

	test('matches sheets by part identity, then name, then a unique content fingerprint', () => {
		const original = [
			sheet({ A1: text('one') }, { name: 'Renamed', partId: '/xl/worksheets/sheet1.xml' }),
			sheet({ A1: text('two') }, { name: 'Stable', sheetId: '2', partId: '/xl/worksheets/sheet2.xml' }),
			sheet({ A1: text('three') }, { name: 'Moved Part', sheetId: '3', partId: '/xl/worksheets/sheet3.xml' }),
		];
		const modified = [
			sheet({ A1: text('one') }, { name: 'New Name', partId: '/xl/worksheets/sheet1.xml' }),
			sheet({ A1: text('changed') }, { name: 'Stable', sheetId: '2', partId: '/xl/worksheets/replaced.xml' }),
			sheet({ A1: text('three') }, { name: 'Elsewhere', sheetId: '3', partId: '/xl/worksheets/other.xml' }),
		];
		deepStrictEqual(matchSpreadsheetSheets(original, modified).map(match => match.matchedBy), ['partIdentity', 'name', 'contentFingerprint']);
	});

	test('uses Part sources as provenance without turning unrelated Part-byte changes into semantic changes', () => {
		const conditionalFormatting = (seed: string) => ({
			worksheetSource: source('/xl/worksheets/sheet1.xml', seed), stylesSource: source('/xl/styles.xml', seed), rules: [], differentialStyles: [],
		});
		const annotations = (seed: string) => ({
			worksheetSource: source('/xl/worksheets/sheet1.xml', seed), contentTypesSource: source('/[Content_Types].xml', seed), rootRelationshipsSource: source('/_rels/.rels', seed), workbookSource: source('/xl/workbook.xml', seed), worksheetRelationshipsSource: source('/xl/worksheets/_rels/sheet1.xml.rels', seed), workbookRelationshipsSource: source('/xl/_rels/workbook.xml.rels', seed), validations: [], legacyNotes: [], threadedComments: [], persons: [], hyperlinks: [], opaqueFragments: [], cellOverlays: [], rangeOverlays: [],
		});
		const objects = (seed: string) => emptyObjects({
			security: { sheetProtections: [{ source: source('/xl/worksheets/sheet1.xml', seed), sheet: true }], unsafeParts: [], externalReferences: [] },
		});
		const page = compareSpreadsheetSemantics(
			snapshot([sheet({ A1: number('1') }, { sourceSeed: 'a', conditionalFormatting: conditionalFormatting('a'), annotations: annotations('a'), objects: objects('a') })]),
			snapshot([sheet({ A1: number('2') }, { sourceSeed: 'b', conditionalFormatting: conditionalFormatting('b'), annotations: annotations('b'), objects: objects('b') })]),
		);
		strictEqual(page.changes.some(change => change.category === 'formatting' || change.category === 'annotation' || change.category === 'security'), false);
		strictEqual(changesOf(page, 'cell.rawValue').length, 1);
	});

	test('selects rename swaps by modified-side identity instead of the first matching alias', () => {
		const alignments = [
			{ originalName: 'A', modifiedName: 'B', originalIndex: 0, modifiedIndex: 0, matchedBy: 'partIdentity' as const, certainty: 'exact' as const },
			{ originalName: 'B', modifiedName: 'A', originalIndex: 1, modifiedIndex: 1, matchedBy: 'partIdentity' as const, certainty: 'exact' as const },
		];
		deepStrictEqual(selectSpreadsheetSheetAlignment(alignments, 'A', 'modified'), alignments[1]);
		deepStrictEqual(selectSpreadsheetSheetAlignment(alignments, 'B', 'modified'), alignments[0]);
	});

	test('pages deterministic changes with category filters, terminal completeness, and tolerance-only diagnostics', () => {
		const original = snapshot([sheet({ A1: number('1.000'), A2: text('anchor-2'), A3: text('a'), A4: text('anchor-4'), A5: text('b') })]);
		const modified = snapshot([sheet({ A1: number('1.001'), A2: text('anchor-2'), A3: text('x'), A4: text('anchor-4'), A5: text('y') })]);
		const first = compareSpreadsheetSemantics(original, modified, { pageSize: 2, numericTolerance: 0.01 });
		strictEqual(first.changes.length, 2);
		strictEqual(first.terminal, false);
		strictEqual(first.completeness.terminal, false);
		ok(first.nextCursor);
		ok(first.diagnostics.some(diagnostic => diagnostic.kind === 'numericWithinTolerance' && diagnostic.locator.endsWith('!A1')));
		ok(first.changes.some(change => change.subject.locator.endsWith('!A1')));
		const second = compareSpreadsheetSemantics(original, modified, { pageSize: 2, cursor: first.nextCursor });
		strictEqual(second.terminal, true);
		strictEqual(second.completeness.terminal, true);
		strictEqual(second.completeness.visitedSemanticUnits, second.completeness.expectedSemanticUnits);
		strictEqual(compareSpreadsheetSemantics(original, modified, { categories: ['formatting'] }).changes.length, 0);
	});

	test('owns output values and enforces cancellation, deadline, cursor, and configured limits', () => {
		const originalCell = number('1') as { rawValue?: { present: boolean; text: string } };
		const original = snapshot([sheet({ A1: originalCell as ParadisSemanticCell })]);
		const modified = snapshot([sheet({ A1: text('after') })]);
		const page = compareSpreadsheetSemantics(original, modified);
		originalCell.rawValue!.text = 'mutated';
		strictEqual(JSON.stringify(page.changes).includes('mutated'), false);
		throws(() => compareSpreadsheetSemantics(original, modified, { cancellationToken: CancellationToken.Cancelled }), /cancelled/);
		let clock = 0;
		throws(() => compareSpreadsheetSemantics(original, modified, { now: () => ++clock, deadlineMilliseconds: 0 }), /limitExceeded/);
		throws(() => compareSpreadsheetSemantics(original, modified, { cursor: 'invalid' }), /unsafe/);
		throws(() => compareSpreadsheetSemantics(original, modified, { limits: { changes: 1 } }), /limitExceeded/);
		const cyclic: Record<string, unknown> = {};
		cyclic.loop = cyclic;
		const cyclicSheet = { ...sheet({ A1: text('same') }), annotations: cyclic } as unknown as ParadisSemanticSheet;
		throws(() => compareSpreadsheetSemantics(snapshot([cyclicSheet]), snapshot([cyclicSheet])), /unsafe/);
	});
});
