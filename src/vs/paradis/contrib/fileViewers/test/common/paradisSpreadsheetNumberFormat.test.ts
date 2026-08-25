/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, notStrictEqual, ok, strictEqual, throws } from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { diagnoseSpreadsheetProjection, type IParadisCellData, type IParadisWorkbookData } from '../../common/paradisSpreadsheet.js';
import {
	formatSpreadsheetValue,
	type ParadisFormattedCellValue,
} from '../../common/spreadsheet/paradisSpreadsheetNumberFormat.js';
import type { ParadisSemanticCell, ParadisSpreadsheetSnapshot } from '../../common/spreadsheet/paradisSpreadsheetSemantic.js';
import { formatSpreadsheetRenderProjection } from '../../common/spreadsheet/paradisSpreadsheetSemanticParser.js';

function exact(text: string): ParadisFormattedCellValue {
	return { text, status: 'exact', unsupportedTokens: [] };
}

function format(value: unknown, code: number | string, context: Parameters<typeof formatSpreadsheetValue>[2] = {}): ParadisFormattedCellValue {
	return formatSpreadsheetValue(value, code, context);
}

suite('ParadisSpreadsheetNumberFormat', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('implements every defined built-in format from 0 through 49 and reports reserved IDs', () => {
		const exactIds = new Set([
			0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
			27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 45, 46, 47, 48, 49,
		]);
		const accountingIds = new Set([41, 42, 43, 44]);
		for (let id = 0; id <= 49; id++) {
			const value = id === 49 ? 'alpha' : id >= 14 && id <= 36 || id >= 45 && id <= 47 ? 2.5 : 1234.5;
			const result = format(value, id, { applicationLocale: 'en-US' });
			ok(result.text.length > 0, `built-in ${id} must produce visible output`);
			if (exactIds.has(id)) {
				strictEqual(result.status, 'exact', `built-in ${id}`);
				deepStrictEqual(result.unsupportedTokens, [], `built-in ${id}`);
			} else if (accountingIds.has(id)) {
				strictEqual(result.status, 'approximated', `built-in ${id}`);
				ok(result.unsupportedTokens.every(token => token.startsWith('*')), `built-in ${id}`);
			} else {
				strictEqual(result.status, 'approximated', `reserved built-in ${id}`);
				deepStrictEqual(result.unsupportedTokens, [`built-in:${id}`]);
				ok(result.text.includes(`built-in:${id}`), `reserved built-in ${id} must retain its raw identity`);
			}
		}
	});

	test('formats the invariant numeric built-ins deterministically', () => {
		deepStrictEqual(format(1234.5, 0), exact('1234.5'));
		deepStrictEqual(format('alpha', 0), exact('alpha'));
		deepStrictEqual(format(true, 0), exact('TRUE'));
		deepStrictEqual(format(1234.5, 1), exact('1235'));
		deepStrictEqual(format(1234.5, 2), exact('1234.50'));
		deepStrictEqual(format(1234.5, 3), exact('1,235'));
		deepStrictEqual(format(1234.5, 4), exact('1,234.50'));
		deepStrictEqual(format(0.125, 9), exact('13%'));
		deepStrictEqual(format(0.125, 10), exact('12.50%'));
		deepStrictEqual(format(1234, 11), exact('1.23E+03'));
		deepStrictEqual(format(2.125, 12), exact('2 1/8'));
		deepStrictEqual(format(2.125, 13), exact('2  1/ 8'));
		deepStrictEqual(format(1234, 48), exact('1.2E+3'));
		deepStrictEqual(format('alpha', 49), exact('alpha'));
		strictEqual(format(1234, 5).text.trim(), '$1,234');
		deepStrictEqual(format(60, 14), exact('02-29-00'));
		deepStrictEqual(format(2, 15), exact('2-Jan-00'));
		deepStrictEqual(format(2, 16), exact('2-Jan'));
		deepStrictEqual(format(2, 17), exact('Jan-00'));
		deepStrictEqual(format(0.5, 18), exact('12:00 PM'));
		deepStrictEqual(format(0.5, 19), exact('12:00:00 PM'));
		deepStrictEqual(format(0.5, 20), exact('12:00'));
		deepStrictEqual(format(0.5, 21), exact('12:00:00'));
		deepStrictEqual(format(2.5, 22), exact('1/2/00 12:00'));
		deepStrictEqual(format(0.5, 45), exact('00:00'));
		deepStrictEqual(format(1.5, 46), exact('36:00:00'));
		deepStrictEqual(format(0.5, 47), exact('0000.0'));
	});

	test('selects positive, negative, zero, and text sections without changing the source value', () => {
		const code = '0.0;[Red](0.0);"-";"text:"@';
		deepStrictEqual(format(1.25, code), exact('1.3'));
		deepStrictEqual(format(-1.25, code), exact('(1.3)'));
		deepStrictEqual(format(0, code), exact('-'));
		deepStrictEqual(format('alpha', code), exact('text:alpha'));
		deepStrictEqual(format(-1.25, '0.0;0.00'), exact('1.25'));
		deepStrictEqual(format('hello', 'yyyy-mm-dd'), exact('hello'));
		deepStrictEqual(format('hello', '"USD "0.00'), exact('hello'));
		deepStrictEqual(format(true, '0.00'), exact('TRUE'));
		deepStrictEqual(format(null, '0.00;[Red](0.00);"zero";"text:"@'), exact(''));
		deepStrictEqual(format('hidden', '0;0;0;'), exact(''));
		deepStrictEqual(format(false, '0;0;0;"bool:"@'), exact('FALSE'));
	});

	test('preserves literal token positions and localizes only semantic currency directives', () => {
		deepStrictEqual(format(1234, '00"-"00'), exact('12-34'));
		deepStrictEqual(format(123, '0\\$00', { workbookLocale: 'de-DE' }), exact('1$23'));
		deepStrictEqual(format(12, '0"$"0', { workbookLocale: 'ja-JP' }), exact('1$2'));
		deepStrictEqual(format(1234.5, '[$€-407]#,##0.00', { applicationLocale: 'en-US' }), exact('€1.234,50'));
	});

	test('evaluates ordered conditions and accepts color directives as non-display metadata', () => {
		const code = '[Red][>=100]0.0;[Blue][<100]0.00;0';
		deepStrictEqual(format(150, code), exact('150.0'));
		deepStrictEqual(format(50, code), exact('50.00'));
		deepStrictEqual(format(-1, code), exact('-1.00'));
	});

	test('formats percent, accounting, fractions, scientific notation, escapes, and quoted text', () => {
		deepStrictEqual(format(0.125, '0.00%'), exact('12.50%'));
		deepStrictEqual(format(2.125, '# ??/??'), exact('2  1/ 8'));
		deepStrictEqual(format(0.2, '# ?/8'), exact('0 2/8'));
		deepStrictEqual(format(1234, '0.00E+00'), exact('1.23E+03'));
		deepStrictEqual(format(1_234_000, '#,##0,,'), exact('1'));
		deepStrictEqual(format(1234, '0.0,'), exact('1.2'));
		deepStrictEqual(format(1234, '"USD "0.00E+00'), exact('USD 1.23E+03'));
		deepStrictEqual(format(-1234, '0.00E+00;[Red](0.00E+00)'), exact('(1.23E+03)'));
		deepStrictEqual(format(2.125, '"qty "# ?/?" kg"'), exact('qty 2 1/8 kg'));
		deepStrictEqual(format(-2.125, '# ?/?;[Red](# ?/?)'), exact('(2 1/8)'));
		deepStrictEqual(format(2.125, '?/??'), exact('17/ 8'));
		deepStrictEqual(format(0.2, '?/8'), exact('2/8'));
		const invalidFraction = format(0.2, '?/999999999999999999');
		strictEqual(invalidFraction.status, 'approximated');
		ok(invalidFraction.text.startsWith('0.2'));
		ok(invalidFraction.text.includes('?/999999999999999999'));
		const duplicateSlash = format(0.2, '?/??/??');
		strictEqual(duplicateSlash.status, 'approximated');
		ok(duplicateSlash.text.startsWith('0.2'));
		deepStrictEqual(format(12_345, '##0.0E+0'), exact('12.3E+3'));
		deepStrictEqual(format(0.1234, '0.00E+00%'), exact('1.23E+01%'));
		deepStrictEqual(format(0.1234, '##0.0E+0%'), exact('12.3E+0%'));
		deepStrictEqual(format(0.125, '# ?/?%'), exact('12 1/2%'));
		deepStrictEqual(format(1.5, '0.0\\ kg "net"'), exact('1.5 kg net'));

		const accounting = format(1234.5, '_($* #,##0.00_);[Red]_($* (#,##0.00);_($* "-"??_);_(@_)');
		strictEqual(accounting.text.trim(), '$ 1,234.50');
		strictEqual(accounting.status, 'approximated');
		deepStrictEqual(accounting.unsupportedTokens, ['* ']);
	});

	test('implements optional and spacing placeholders for zero, large finite numbers, and percent rounding', () => {
		deepStrictEqual(format(0, '#'), exact(''));
		deepStrictEqual(format(0, '?'), exact(' '));
		deepStrictEqual(format(12, '????'), exact('  12'));
		deepStrictEqual(format(1e21, '0'), exact('1000000000000000000000'));
		deepStrictEqual(format(1.2, '#.##'), exact('1.2'));
		deepStrictEqual(format(0.126, '0.0%'), exact('12.6%'));
		const overflow = format(Number.MAX_VALUE, '0%');
		strictEqual(overflow.status, 'approximated');
		deepStrictEqual(overflow.unsupportedTokens, ['numeric-overflow']);
		ok(!overflow.text.includes('Infinity'));
		ok(overflow.text.includes('0%'));
		deepStrictEqual(format(1234, '0.0e+0'), exact('1.2e+3'));
	});

	test('computes 1900 and 1904 dates without a host timezone and preserves serial 60', () => {
		deepStrictEqual(format(1, 'yyyy-mm-dd', { date1904: false }), exact('1900-01-01'));
		deepStrictEqual(format(59, 'yyyy-mm-dd', { date1904: false }), exact('1900-02-28'));
		deepStrictEqual(format(60.5, 'yyyy-mm-dd hh:mm:ss.000', { date1904: false }), exact('1900-02-29 12:00:00.000'));
		deepStrictEqual(format(61, 'yyyy-mm-dd', { date1904: false }), exact('1900-03-01'));
		deepStrictEqual(format(0, 'yyyy-mm-dd', { date1904: true }), exact('1904-01-01'));

		const previousTimezone = process.env.TZ;
		try {
			process.env.TZ = 'Pacific/Kiritimati';
			const east = format(45_000.75, 'yyyy-mm-dd hh:mm:ss', { date1904: false });
			process.env.TZ = 'America/Adak';
			const west = format(45_000.75, 'yyyy-mm-dd hh:mm:ss', { date1904: false });
			deepStrictEqual(east, west);
		} finally {
			if (previousTimezone === undefined) {
				delete process.env.TZ;
			} else {
				process.env.TZ = previousTimezone;
			}
		}
	});

	test('uses workbook locale before application locale and otherwise falls back to the application locale', () => {
		deepStrictEqual(format(2, 31, { workbookLocale: 'ja-JP', applicationLocale: 'ko-KR' }), exact('1900年1月2日'));
		deepStrictEqual(format(2, 31, { applicationLocale: 'ko-KR' }), exact('1900년 1월 2일'));
		deepStrictEqual(format(1234.5, '#,##0.00', { workbookLocale: 'de-DE', applicationLocale: 'en-US' }), exact('1.234,50'));
		deepStrictEqual(format(1234.5, '#,##0.00', { workbookLocale: '', applicationLocale: 'de-DE' }), exact('1.234,50'));
		deepStrictEqual(format(1, 'dddd', { workbookLocale: 'de-DE' }), exact('Montag'));
		deepStrictEqual(format(1, 'dddd', { workbookLocale: 'fr-FR' }), exact('lundi'));
		const regionalFallback = format(1234.5, '#,##0.00', { workbookLocale: 'en-GB' });
		deepStrictEqual(regionalFallback, { text: '1,234.50', status: 'approximated', unsupportedTokens: ['locale:en-GB'] });
		const unknownLocale = format(1234.5, '#,##0.00', { workbookLocale: 'pt-BR' });
		deepStrictEqual(unknownLocale, { text: '1,234.50', status: 'approximated', unsupportedTokens: ['locale:pt-BR'] });
	});

	test('rejects invalid condition and color grammar without a silent blank fallback', () => {
		for (const code of ['[Red][Blue]0', '[>0][<2]0', '0[Red]', '[oops]0', '[Red0', '"unterminated']) {
			const result = format(1, code);
			strictEqual(result.status, 'approximated', code);
			ok(result.text.includes(code), code);
			ok(result.text.length > code.length, code);
		}
		const noMatch = format(5, '[>10]0;[<0]0');
		strictEqual(noMatch.status, 'approximated');
		strictEqual(noMatch.text, '5 ⟦[>10]0;[<0]0⟧');
		deepStrictEqual(noMatch.unsupportedTokens, ['condition:no-match']);
	});

	test('marks unknown tokens as approximated and retains the raw code instead of silently using General', () => {
		const result = format(12.34, '0.00[DBNum1]');
		strictEqual(result.status, 'approximated');
		deepStrictEqual(result.unsupportedTokens, ['[DBNum1]']);
		ok(result.text.startsWith('12.34'));
		ok(result.text.includes('0.00[DBNum1]'));
		ok(result.text !== '12.34', 'General fallback must not be indistinguishable from the requested format');

		const localeToken = format(12.34, '[$-FFFF]0.00');
		strictEqual(localeToken.status, 'approximated');
		deepStrictEqual(localeToken.unsupportedTokens, ['[$-FFFF]']);
		ok(localeToken.text.includes('[$-FFFF]0.00'));

		const missingCustom = format(12.34, '[numFmtId:50]');
		strictEqual(missingCustom.status, 'approximated');
		ok(missingCustom.text.startsWith('12.34'));
		ok(missingCustom.text.includes('[numFmtId:50]'));
	});

	test('bounds format input, section count, token count, text input, and rendered output', () => {
		throws(() => format(1, '0'.repeat(4097)), /limitExceeded/);
		throws(() => format(1, '0;0;0;0;0'), /limitExceeded/);
		throws(() => format(1, '0"x"'.repeat(513)), /limitExceeded/);
		throws(() => format('x'.repeat(1_048_577), '@'), /limitExceeded/);
		throws(() => format(1, '"x"'.repeat(3000), { limits: { outputCharacters: 1024 } }), /limitExceeded/);
	});

	test('owns option data, rejects accessors and proxies, observes cancellation, and enforces a monotonic deadline', () => {
		const accessorContext = {} as Record<string, unknown>;
		Object.defineProperty(accessorContext, 'workbookLocale', { enumerable: true, get: () => 'ja-JP' });
		throws(() => format(1, 0, accessorContext), /unsafe/);

		const proxyContext = new Proxy({}, { ownKeys: () => { throw new Error('attacker detail'); } });
		throws(() => format(1, 0, proxyContext), /unsafe/);
		throws(() => format(1, 0, { cancellationToken: CancellationToken.Cancelled }), /cancelled/);
		let cancellationReads = 0;
		const incrementalCancellation = {
			get isCancellationRequested() { return ++cancellationReads > 1; },
			onCancellationRequested: () => ({ dispose() { } }),
		};
		throws(() => format('x'.repeat(4096), 0, { cancellationToken: incrementalCancellation }), /cancelled/);

		let clock = 0;
		throws(() => format(1, '0"x"'.repeat(200), { now: () => ++clock, deadlineMilliseconds: 3 }), /limitExceeded/);
	});

	test('hardens malformed Unicode and locale input without invoking locale-sensitive host formatting', () => {
		const unicode = format('a\uD800b', ';;;"prefix:"@');
		deepStrictEqual(unicode, { text: 'prefix:a\uFFFDb', status: 'approximated', unsupportedTokens: ['unicode'] });
		throws(() => format(1, 0, { workbookLocale: 'x'.repeat(129) }), /limitExceeded/);
		const locale = format(1234.5, '#,##0.00', { workbookLocale: '__proto__' });
		deepStrictEqual(locale, { text: '1,234.50', status: 'approximated', unsupportedTokens: ['locale:__proto__'] });
	});

	test('formats only the render projection while retaining raw semantic and diagonal provenance', () => {
		const rawColor = { kind: 'rgb' as const, rgb: 'FFFF0000' };
		const semanticDiagonal = { index: 1, diagonalUp: true, diagonal: { style: 'thin', color: rawColor } };
		const semanticCell = {
			storedType: 'number' as const,
			rawValue: { present: true as const, text: '1234.5' },
			styleRef: 1,
			effectiveStyleRef: 1,
			effectiveStyleOrigin: 'cell' as const,
		};
		const snapshot: ParadisSpreadsheetSnapshot = {
			workbookSource: { partId: '/xl/workbook.xml', fingerprint: { algorithm: 'sha256', value: 'workbook', byteLength: 1 } },
			date1904: false,
			definedNames: [],
			workbookViews: [],
			sheets: [{
				name: 'Sheet1', sheetId: '1', order: 0, state: 'visible', relationshipId: 'rId1', partId: '/xl/worksheets/sheet1.xml',
				source: { partId: '/xl/worksheets/sheet1.xml', fingerprint: { algorithm: 'sha256', value: 'sheet', byteLength: 1 } },
				views: [], rows: new Map([[1, { index: 1 }]]), columns: [], merges: [], cells: new Map([['A1', semanticCell]]),
			}],
			styles: {
				source: { partId: '/xl/styles.xml', fingerprint: { algorithm: 'sha256', value: 'styles', byteLength: 1 } },
				numberFormats: [{ id: 165, code: '#,##0.00' }],
				cellFormats: [{ index: 0, numberFormatId: 0 }, { index: 1, numberFormatId: 165, borderRef: 1 }],
				borders: [{ index: 0 }, semanticDiagonal],
				completeness: { parsedCellFormats: 2, parsedBorders: 2, cellsWithStyleRefs: 1, unresolvedStyleRefs: 0, cellsWithDiagonalStyleRefs: 1 },
			},
			completeness: { expectedParts: 4, visitedParts: 4, parsedParts: 4, expectedSheets: 1, parsedSheets: 1, expectedCells: 1, parsedCells: 1, unknownElements: 0, unknownAttributes: 0, unresolvedReferences: 0, terminal: true },
			projectionDiagnostics: [],
		};
		const style = { color: '#000000' };
		const diagonal = { up: true, down: false, style: '1px solid', color: '#ff0000', rawStyle: 'thin', rawColor };
		const projectedCell: IParadisCellData = { value: '1234.5', style, diagonal };
		const projection: IParadisWorkbookData = {
			sheets: [{ name: 'Sheet1', rows: [{ excelRow: 1, height: 20, cells: [projectedCell] }], columnCount: 1, columnWidths: [100], truncated: false, minCol: 1 }],
		};
		const diagnostics = diagnoseSpreadsheetProjection(snapshot, projection);
		const result = formatSpreadsheetRenderProjection(snapshot, projection, { applicationLocale: 'en-US' });

		strictEqual(result.projection.sheets[0].rows[0].cells[0].value, '1,234.50');
		deepStrictEqual(result.projection.sheets[0].rows[0].cells[0].style, style);
		notStrictEqual(result.projection.sheets[0].rows[0].cells[0].style, style);
		deepStrictEqual(result.projection.sheets[0].rows[0].cells[0].diagonal, diagonal);
		notStrictEqual(result.projection.sheets[0].rows[0].cells[0].diagonal, diagonal);
		strictEqual(projection.sheets[0].rows[0].cells[0], projectedCell);
		strictEqual(projection.sheets[0].rows[0].cells[0].value, '1234.5');
		strictEqual(snapshot.sheets[0].cells.get('A1'), semanticCell);
		strictEqual(snapshot.sheets[0].cells.get('A1')?.styleRef, 1);
		strictEqual(snapshot.styles.borders[1], semanticDiagonal);
		strictEqual(snapshot.styles.borders[1].diagonal?.color, rawColor);
		notStrictEqual(result.diagnostics, snapshot.projectionDiagnostics);
		deepStrictEqual(result.diagnostics, diagnostics);
		deepStrictEqual(result.diagnostics, []);
		strictEqual(result.formatDiagnosticsTruncated, false);
	});

	test('uses a present formula cache for display and never recalculates or invents a missing cache', () => {
		const cached = formatSpreadsheetRenderProjection(
			projectionSnapshot({ storedType: 'formula', formula: { text: 'SUM(A1:A2)', kind: 'normal' }, cachedResult: { present: true, type: 'number', rawValue: '2.5' }, effectiveStyleRef: 0 }),
			oneCellProjection('2.5'),
		);
		strictEqual(cached.projection.sheets[0].rows[0].cells[0].value, '2.50');

		const absent = formatSpreadsheetRenderProjection(
			projectionSnapshot({ storedType: 'formula', formula: { text: 'NOW()', kind: 'normal' }, cachedResult: { present: false }, effectiveStyleRef: 0 }),
			oneCellProjection('=NOW()'),
		);
		strictEqual(absent.projection.sheets[0].rows[0].cells[0].value, '=NOW()');

		const date = formatSpreadsheetRenderProjection(
			projectionSnapshot({ storedType: 'date', rawType: 'd', rawValue: { present: true, text: '2024-01-02T00:00:00Z' }, effectiveStyleRef: 0 }, 14),
			oneCellProjection('2024-01-02'),
		);
		strictEqual(date.projection.sheets[0].rows[0].cells[0].value, '2024-01-02');

		const sharedStringCache = formatSpreadsheetRenderProjection(
			projectionSnapshot({ storedType: 'formula', rawType: 's', formula: { text: 'A1', kind: 'normal' }, cachedResult: { present: true, type: 'string', rawValue: '0' }, effectiveStyleRef: 0 }),
			oneCellProjection('resolved shared string'),
		);
		strictEqual(sharedStringCache.projection.sheets[0].rows[0].cells[0].value, 'resolved shared string');
	});

	test('bounds and cancels the render-projection operation as a whole', () => {
		const snapshot = projectionSnapshot({ storedType: 'number', rawValue: { present: true, text: '2.5' }, effectiveStyleRef: 0 }, 41);
		const projection = oneCellProjection('2.5');
		throws(() => formatSpreadsheetRenderProjection(snapshot, projection, {}, { cells: 0 }), /limitExceeded/);
		throws(() => formatSpreadsheetRenderProjection(snapshot, projection, { cancellationToken: CancellationToken.Cancelled }), /cancelled/);
		const capped = formatSpreadsheetRenderProjection(snapshot, projection, {}, { formatDiagnostics: 0 });
		deepStrictEqual(capped.formatDiagnostics, []);
		strictEqual(capped.formatDiagnosticsTruncated, true);

		const twoCells = twoCellProjection();
		const twoCellSnapshot = twoCellProjectionSnapshot();
		throws(() => formatSpreadsheetRenderProjection(twoCellSnapshot, twoCells, {}, { inputCharacters: 1 }), /limitExceeded/);
		throws(() => formatSpreadsheetRenderProjection(twoCellSnapshot, twoCells, {}, { inputUtf8Bytes: 1 }), /limitExceeded/);
		throws(() => formatSpreadsheetRenderProjection(
			projectionSnapshot({ storedType: 'string', rawValue: { present: true, text: '😀' }, text: '😀', effectiveStyleRef: 0 }, 0),
			oneCellProjection('😀'),
			{},
			{ inputCharacters: 2, inputUtf8Bytes: 3 },
		), /limitExceeded/);
		const longSheetName = '😀'.repeat(1000);
		const namedSnapshot = projectionSnapshot({ storedType: 'blank', rawValue: { present: false } });
		throws(() => formatSpreadsheetRenderProjection(
			{ ...namedSnapshot, sheets: [{ ...namedSnapshot.sheets[0], name: longSheetName }] },
			{ sheets: [{ ...oneCellProjection('').sheets[0], name: longSheetName }] },
			{},
			{ inputCharacters: 512, outputCharacters: 512, inputUtf8Bytes: 1024, outputUtf8Bytes: 1024 },
		), /limitExceeded/);
		const diagnosedSnapshot = projectionSnapshot({ storedType: 'blank', rawValue: { present: false } });
		throws(() => formatSpreadsheetRenderProjection(
			{ ...diagnosedSnapshot, projectionDiagnostics: [{ kind: 'cellMissing', sheetName: 'Sheet1', cellAddress: 'A1' }] },
			oneCellProjection(''),
			{},
			{ diagnosticCharacters: 0, diagnosticUtf8Bytes: 0 },
		), /limitExceeded/);
		throws(() => formatSpreadsheetRenderProjection(
			{ ...projectionSnapshot({ storedType: 'blank', rawValue: { present: false } }), sheets: [{ ...projectionSnapshot({ storedType: 'blank', rawValue: { present: false } }).sheets[0], cells: new Map() }] },
			oneCellProjection('unmatched'),
			{},
			{ inputCharacters: 1, inputUtf8Bytes: 1, outputCharacters: 1, outputUtf8Bytes: 1 },
		), /limitExceeded/);
		throws(() => formatSpreadsheetRenderProjection(twoCellSnapshot, twoCells, {}, { outputCharacters: 2 }), /limitExceeded/);
		throws(() => formatSpreadsheetRenderProjection(twoCellSnapshot, twoCells, {}, { outputUtf8Bytes: 2 }), /limitExceeded/);
		throws(() => formatSpreadsheetRenderProjection(twoCellSnapshot, twoCells, {}, { parsedFormats: 1 }), /limitExceeded/);
		throws(() => formatSpreadsheetRenderProjection(
			projectionSnapshot({ storedType: 'number', rawValue: { present: true, text: '2.5' }, effectiveStyleRef: 0 }, 41),
			oneCellProjection('2.5'),
			{},
			{ diagnosticCharacters: 1, diagnosticUtf8Bytes: 1 },
		), /limitExceeded/);
	});

	test('sanitizes poisoned render input and snapshots accessors without invoking them', () => {
		let getterReads = 0;
		const accessorProjection = {};
		Object.defineProperty(accessorProjection, 'sheets', { get: () => { getterReads++; return []; } });
		throws(() => formatSpreadsheetRenderProjection(projectionSnapshot({ storedType: 'number', rawValue: { present: true, text: '1' } }), accessorProjection as IParadisWorkbookData), /unsafe/);
		strictEqual(getterReads, 0);

		const poisoned = new Proxy({}, { getPrototypeOf: () => { throw new Error('private attacker detail'); } });
		let message = '';
		try {
			formatSpreadsheetRenderProjection(poisoned as ParadisSpreadsheetSnapshot, oneCellProjection('1'));
		} catch (error) {
			message = String(error);
		}
		strictEqual(message, 'Error: unsafe');

		const mutableLimits = { cells: 0 };
		const limitMutatingProjection = new Proxy(oneCellProjection('1'), {
			getOwnPropertyDescriptor: (target, property) => {
				if (property === 'sheets') {
					mutableLimits.cells = 1;
				}
				return Reflect.getOwnPropertyDescriptor(target, property);
			},
		});
		throws(() => formatSpreadsheetRenderProjection(
			projectionSnapshot({ storedType: 'number', rawValue: { present: true, text: '1' }, effectiveStyleRef: 0 }, 1),
			limitMutatingProjection,
			{},
			mutableLimits,
		), /limitExceeded/);

		const mutableContext = { workbookLocale: 'de-DE' };
		const contextMutatingProjection = new Proxy(oneCellProjection('1234.5'), {
			getOwnPropertyDescriptor: (target, property) => {
				if (property === 'sheets') {
					mutableContext.workbookLocale = 'en-US';
				}
				return Reflect.getOwnPropertyDescriptor(target, property);
			},
		});
		const ownedContext = formatSpreadsheetRenderProjection(
			projectionSnapshot({ storedType: 'number', rawValue: { present: true, text: '1234.5' }, effectiveStyleRef: 0 }, 4),
			contextMutatingProjection,
			mutableContext,
		);
		strictEqual(ownedContext.projection.sheets[0].rows[0].cells[0].value, '1.234,50');

		let styleDescriptorReads = 0;
		const largeStyle = new Proxy(Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`p${index}`, 'x'])), {
			getOwnPropertyDescriptor: (target, property) => {
				styleDescriptorReads++;
				return Reflect.getOwnPropertyDescriptor(target, property);
			},
		});
		const cloneCancellation: CancellationToken = {
			get isCancellationRequested() { return styleDescriptorReads >= 2; },
			onCancellationRequested: () => ({ dispose() { } }),
		};
		throws(() => formatSpreadsheetRenderProjection(
			projectionSnapshot({ storedType: 'number', rawValue: { present: true, text: '1' }, effectiveStyleRef: 0 }, 1),
			{ sheets: [{ ...oneCellProjection('1').sheets[0], rows: [{ excelRow: 1, height: 20, cells: [{ value: '1', style: largeStyle }] }] }] },
			{ cancellationToken: cloneCancellation },
		), /cancelled/);
		ok(styleDescriptorReads < 200);
	});
});

function oneCellProjection(value: string): IParadisWorkbookData {
	return { sheets: [{ name: 'Sheet1', rows: [{ excelRow: 1, height: 20, cells: [{ value, style: {} }] }], columnCount: 1, columnWidths: [100], truncated: false, minCol: 1 }] };
}

function twoCellProjection(): IParadisWorkbookData {
	return {
		sheets: [{
			name: 'Sheet1', minCol: 1, columnCount: 2, columnWidths: [80, 90], truncated: false,
			rows: [{ excelRow: 1, height: 20, cells: [{ value: '1', style: {} }, { value: '2', style: {} }] }],
		}],
	};
}

function twoCellProjectionSnapshot(): ParadisSpreadsheetSnapshot {
	const snapshot = projectionSnapshot({ storedType: 'number', rawValue: { present: true, text: '1' }, effectiveStyleRef: 0 }, 1);
	return {
		...snapshot,
		sheets: [{
			...snapshot.sheets[0], cells: new Map([
				['A1', { storedType: 'number', rawValue: { present: true, text: '1' }, effectiveStyleRef: 0 }],
				['B1', { storedType: 'number', rawValue: { present: true, text: '2' }, effectiveStyleRef: 1 }],
			])
		}],
		styles: {
			...snapshot.styles,
			cellFormats: [{ index: 0, numberFormatId: 1 }, { index: 1, numberFormatId: 2 }],
			completeness: { ...snapshot.styles.completeness, parsedCellFormats: 2 },
		},
	};
}

function projectionSnapshot(cell: ParadisSemanticCell, numberFormatId = 2): ParadisSpreadsheetSnapshot {
	return {
		workbookSource: { partId: '/xl/workbook.xml', fingerprint: { algorithm: 'sha256', value: 'workbook', byteLength: 1 } },
		date1904: false,
		definedNames: [], workbookViews: [],
		sheets: [{
			name: 'Sheet1', sheetId: '1', order: 0, state: 'visible', relationshipId: 'rId1', partId: '/xl/worksheets/sheet1.xml',
			source: { partId: '/xl/worksheets/sheet1.xml', fingerprint: { algorithm: 'sha256', value: 'sheet', byteLength: 1 } }, views: [], rows: new Map([[1, { index: 1 }]]), columns: [], merges: [], cells: new Map([['A1', cell]]),
		}],
		styles: { numberFormats: [], cellFormats: [{ index: 0, numberFormatId }], borders: [], completeness: { parsedCellFormats: 1, parsedBorders: 0, cellsWithStyleRefs: 0, unresolvedStyleRefs: 0, cellsWithDiagonalStyleRefs: 0 } },
		completeness: { expectedParts: 3, visitedParts: 3, parsedParts: 3, expectedSheets: 1, parsedSheets: 1, expectedCells: 1, parsedCells: 1, unknownElements: 0, unknownAttributes: 0, unresolvedReferences: 0, terminal: true },
		projectionDiagnostics: [],
	};
}
