/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok, rejects, strictEqual } from 'assert';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { minimalJpeg, minimalPng } from '../common/paradisWordImageFixture.js';
import { minimalBmp } from '../common/paradisOfficeBmpFixture.js';
import { emfRecord, minimalEmf, ParadisMetafileBytes } from '../common/paradisOfficeMetafileFixture.js';
import { convertParadisSpreadsheetMetafiles } from '../../node/spreadsheet/paradisSpreadsheetMetafiles.js';
import { ParadisSpreadsheetMetafileWorkerBackend } from '../../node/spreadsheet/paradisSpreadsheetMetafileWorkerBackend.js';
import { ParadisWorker } from '../../../../node/paradisWorker.js';
import { collectParadisSpreadsheetSemanticDiagnostics } from '../../node/spreadsheet/paradisSpreadsheetSemanticDiagnostics.js';
import { PARADIS_SPREADSHEET_SVG_IMAGE_COUNT, ParadisSpreadsheetService, applyTint, formatDateFallback, getCellDiagonalForTest, resolveIndexedColor } from '../../node/paradisSpreadsheetService.js';

async function encodeWorkbook(configure: (workbook: ExcelJS.Workbook) => void): Promise<string> {
	const workbook = new ExcelJS.Workbook();
	configure(workbook);
	const bytes = await workbook.xlsx.writeBuffer();
	return Buffer.from(bytes).toString('base64');
}

/**
 * Invented workbook with five pictures whose media are an EMF, a broken EMF, a BMP, an SVG, and a TIFF.
 * exceljs only writes PNG pictures, so each picture's media part is replaced the way Excel stores the others.
 */
interface IPicturePart { readonly kind: string; readonly extension: string; readonly bytes: Uint8Array; readonly type: string }

async function picturesWorkbook(override?: readonly IPicturePart[]): Promise<{ readonly bytes: Uint8Array; readonly kindByRid: ReadonlyMap<string, string>; readonly parts: { readonly bmp: Uint8Array } }> {
	const words = (...values: number[]) => new ParadisMetafileBytes().u32(...values.map(value => value >>> 0));
	// A mapping to 80 x 40 device pixels and one filled rectangle.
	const emf = minimalEmf([
		emfRecord(17, words(8)), emfRecord(10, words(0, 0)), emfRecord(9, words(200, 100)), emfRecord(12, words(0, 0)), emfRecord(11, words(80, 40)),
		emfRecord(39, words(1, 0, 0x0000ff, 0)), emfRecord(37, words(1)), emfRecord(43, words(10, 10, 50, 30)),
	]);
	const bmp = minimalBmp(3, 2, { trailer: 8 });
	const parts: readonly IPicturePart[] = override ?? [
		{ kind: 'emf', extension: 'emf', bytes: emf, type: 'image/x-emf' },
		{ kind: 'brokenEmf', extension: 'emf', bytes: emf.slice(0, 120), type: 'image/x-emf' },
		{ kind: 'bmp', extension: 'bmp', bytes: bmp, type: 'image/bmp' },
		{ kind: 'svg', extension: 'svg', bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ff0000"/></svg>'), type: 'image/svg+xml' },
		{ kind: 'tif', extension: 'tif', bytes: minimalPng(1, 1), type: 'image/tiff' },
	];
	const book = new ExcelJS.Workbook();
	const sheet = book.addWorksheet('Images');
	parts.forEach((_, index) => {
		const id = book.addImage({ buffer: Buffer.from(minimalPng(index + 1, 1)) as unknown as ExcelJS.Buffer, extension: 'png' });
		sheet.addImage(id, { tl: { col: index * 2, row: 0 }, ext: { width: 10, height: 10 } });
	});
	const zip = await JSZip.loadAsync(await book.xlsx.writeBuffer());
	const relsName = Object.keys(zip.files).find(name => /^xl\/drawings\/_rels\/[^/]+\.rels$/.test(name))!;
	let rels = await zip.file(relsName)!.async('text');
	let types = await zip.file('[Content_Types].xml')!.async('text');
	const targets = [...rels.matchAll(/Target="\.\.\/media\/(?<name>[^"]+)"/g)].map(match => match.groups!.name);
	const kindByRid = new Map<string, string>();
	targets.forEach((target, index) => {
		const part = parts[index];
		const renamed = target.replace(/\.png$/, `.${part.extension}`);
		zip.remove(`xl/media/${target}`);
		zip.file(`xl/media/${renamed}`, part.bytes);
		rels = rels.replace(`../media/${target}"`, `../media/${renamed}"`);
		types = types.replace('</Types>', `<Override PartName="/xl/media/${renamed}" ContentType="${part.type}"/></Types>`);
		const rid = new RegExp(`Id="(?<id>[^"]+)"[^>]*Target="\\.\\./media/${renamed.replace('.', '\\.')}"`).exec(rels)?.groups?.id ?? '';
		kindByRid.set(rid, part.kind);
	});
	zip.file(relsName, rels);
	zip.file('[Content_Types].xml', types);
	return { bytes: await zip.generateAsync({ type: 'uint8array' }), kindByRid, parts: { bmp } };
}

suite('ParadisSpreadsheetService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('loads and shares the heavy runtime only when parsing starts', async () => {
		let runtimeLoads = 0;
		const service = new ParadisSpreadsheetService(async () => {
			runtimeLoads++;
			return { ExcelJS, JSZip };
		});
		const workbook = await encodeWorkbook(() => undefined);

		strictEqual(runtimeLoads, 0);
		await Promise.all([service.parseWorkbook(workbook), service.parseWorkbook(workbook)]);

		strictEqual(runtimeLoads, 1);
	});

	test('opens a workbook whose legacy comments use an absolute Target and a non-default part name', async () => {
		// ECMA-376 Part 2 §6.5.3 allows `/xl/comments/comment1.xml`; exceljs only finds `../comments1.xml`.
		const original = await encodeWorkbook(book => {
			const sheet = book.addWorksheet('Notes');
			sheet.getCell('A1').value = 'noted';
			sheet.getCell('A1').note = 'a note';
		});
		const zip = await JSZip.loadAsync(Buffer.from(original, 'base64'));
		const relsName = 'xl/worksheets/_rels/sheet1.xml.rels';
		const rels = await zip.file(relsName)!.async('string');
		const commentsName = Object.keys(zip.files).find(name => /^xl\/comments\d+\.xml$/.test(name))!;
		zip.file('xl/comments/comment1.xml', await zip.file(commentsName)!.async('uint8array'));
		zip.remove(commentsName);
		zip.file(relsName, rels.replace(/Target="[^"]*comments\d+\.xml"/, 'Target="/xl/comments/comment1.xml"').replace(/Target="\.\.\/drawings\//g, 'Target="/xl/drawings/'));
		const moved = Buffer.from(await zip.generateAsync({ type: 'uint8array' })).toString('base64');

		const result = await new ParadisSpreadsheetService().parseWorkbook(moved);

		deepStrictEqual(result.sheets.map(sheet => sheet.name), ['Notes']);
		strictEqual(result.sheets[0].rows[0].cells[0].value, 'noted');
	});

	test('returns the package error code when semantic diagnostics cannot run', async () => {
		const zip = new JSZip();
		zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
		zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
		const bytes = await zip.generateAsync({ type: 'uint8array' });

		const summary = await collectParadisSpreadsheetSemanticDiagnostics(bytes);

		deepStrictEqual([summary.available, summary.unavailableReason], [false, 'malformed']);
	});

	test('collects semantic diagnostics separately from the display projection', async () => {
		const workbook = await encodeWorkbook(book => { book.addWorksheet('One').getCell('A1').value = 1; });
		const service = new ParadisSpreadsheetService();

		const display = await service.parseWorkbook(workbook);
		const summary = await collectParadisSpreadsheetSemanticDiagnostics(new Uint8Array(Buffer.from(workbook, 'base64')));

		strictEqual(display.semanticDiagnostics, undefined);
		deepStrictEqual([summary.available, summary.terminal, summary.parsedSheets, summary.parsedCells], [true, true, 1, 1]);
		ok((summary.elapsedMilliseconds ?? -1) >= 0);
	});

	test('draws only images that pass the Word image checks, cuts trailing data, and keeps to the pixel budget', async () => {
		const png = minimalPng(2, 2);
		const big = minimalPng(7_000, 7_000);
		const encode = async (images: readonly Uint8Array[]) => {
			const book = new ExcelJS.Workbook();
			const sheet = book.addWorksheet('Images');
			images.forEach((image, index) => {
				const id = book.addImage({ buffer: Buffer.from(image) as unknown as ExcelJS.Buffer, extension: 'png' });
				sheet.addImage(id, { tl: { col: index * 2, row: 0 }, ext: { width: 10, height: 10 } });
			});
			return Buffer.from(await book.xlsx.writeBuffer()).toString('base64');
		};
		const media = async (images: readonly Uint8Array[], budget?: number) => {
			const result = await new ParadisSpreadsheetService().parseWorkbook(await encode(images), budget);
			return Object.values(result.drawingsBySheet?.[1]?.[0]?.media ?? {}).map(href => `${href.slice(0, href.indexOf(';'))}:${Buffer.from(href.slice(href.indexOf(',') + 1), 'base64').byteLength}`);
		};
		const polyglot = Uint8Array.from([...png, ...new TextEncoder().encode('<html></html>')]);
		const jpegNamedPng = minimalJpeg(2, 2);
		const reasons = async (images: readonly Uint8Array[], budget?: number) => Object.values((await new ParadisSpreadsheetService().parseWorkbook(await encode(images), budget)).drawingsBySheet?.[1]?.[0]?.rejectedMedia ?? {});
		deepStrictEqual({
			plain: await media([png]),
			polyglot: await media([polyglot]),
			mismatched: await media([jpegNamedPng]),
			mismatchedReason: await reasons([jpegNamedPng]),
			overBudgetReason: await reasons([big, big], 50_000_000),
			tooLargeReason: await reasons([minimalPng(40_000, 1)]),
			tooLargeMismatchedReason: await reasons([minimalJpeg(10_000, 10_000)]),
			budget: [(await media([big, big])).length, (await media([big, big], 50_000_000)).length, (await media([big], Number.POSITIVE_INFINITY)).length],
		}, {
			plain: [`data:image/png:${png.byteLength}`],
			polyglot: [`data:image/png:${png.byteLength}`],
			mismatched: [],
			mismatchedReason: ['unverified'],
			overBudgetReason: ['overBudget'],
			tooLargeReason: ['tooLarge'],
			tooLargeMismatchedReason: ['unverified'],
			budget: [2, 1, 1],
		});
	});

	test('draws BMP after its header checks and sanitized SVG, leaves EMF for the worker, and boxes the rest', async () => {
		const { bytes, kindByRid, parts } = await picturesWorkbook();
		const result = await new ParadisSpreadsheetService().parseWorkbook(Buffer.from(bytes).toString('base64'));
		const drawing = result.drawingsBySheet?.[1]?.[0];
		const decode = (href: string) => Buffer.from(href.slice(href.indexOf(',') + 1), 'base64');
		const drawn = Object.entries(drawing?.media ?? {}).map(([rid, href]) => [kindByRid.get(rid), href.slice(0, href.indexOf(';')), href.includes('image/bmp') ? decode(href).byteLength : /<svg\b/.test(decode(href).toString('utf8'))]);
		const rejected = Object.entries(drawing?.rejectedMedia ?? {}).map(([rid, reason]) => [kindByRid.get(rid), reason]);
		const pending = Object.entries(drawing?.metafileMedia ?? {}).map(([rid, name]) => [kindByRid.get(rid), name.endsWith('.emf')]);
		deepStrictEqual({ drawn: drawn.sort(), rejected: rejected.sort(), pending: pending.sort() }, {
			drawn: [['bmp', 'data:image/bmp', parts.bmp.byteLength - 8], ['svg', 'data:image/svg+xml', true]],
			rejected: [['brokenEmf', 'metafile'], ['emf', 'metafile'], ['tif', 'unsupportedFormat']],
			pending: [['brokenEmf', true], ['emf', true]],
		});
	});

	test('counts SVG pictures against the workbook limits before sanitizing them', async () => {
		const svg = (index: number) => new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="${index + 1}" height="10"/></svg>`);
		const many = Array.from({ length: PARADIS_SPREADSHEET_SVG_IMAGE_COUNT + 1 }, (_, index): IPicturePart => ({ kind: `svg${index}`, extension: 'svg', bytes: svg(index), type: 'image/svg+xml' }));
		const huge: IPicturePart = { kind: 'huge', extension: 'svg', bytes: new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><desc>${'x'.repeat(1024 * 1024)}</desc></svg>`), type: 'image/svg+xml' };
		const reasons = async (parts: readonly IPicturePart[]) => {
			const { bytes } = await picturesWorkbook(parts);
			const drawing = (await new ParadisSpreadsheetService().parseWorkbook(Buffer.from(bytes).toString('base64'))).drawingsBySheet?.[1]?.[0];
			return { drawn: Object.keys(drawing?.media ?? {}).length, rejected: Object.values(drawing?.rejectedMedia ?? {}) };
		};
		deepStrictEqual([await reasons(many), await reasons([huge])], [
			{ drawn: PARADIS_SPREADSHEET_SVG_IMAGE_COUNT, rejected: ['overBudget'] },
			{ drawn: 0, rejected: ['tooLarge'] },
		]);
	});

	test('also keeps the sanitized SVG output within the workbook limit when it grows past the input', async () => {
		// Each input is about 250 KB, but the sanitizer writes every `>` of the text as `&gt;`, so each output is
		// about 1 MB: 17 inputs fit the 16 MiB budget, while their outputs do not.
		const svg = (index: number) => new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><text>${index}${'>'.repeat(250_000)}</text></svg>`);
		const parts = Array.from({ length: 17 }, (_, index): IPicturePart => ({ kind: `svg${index}`, extension: 'svg', bytes: svg(index), type: 'image/svg+xml' }));
		const { bytes } = await picturesWorkbook(parts);
		const drawing = (await new ParadisSpreadsheetService().parseWorkbook(Buffer.from(bytes).toString('base64'))).drawingsBySheet?.[1]?.[0];
		deepStrictEqual({ drawn: Object.keys(drawing?.media ?? {}).length, rejected: Object.values(drawing?.rejectedMedia ?? {}) }, { drawn: 16, rejected: ['overBudget'] });
	});

	test('converts the EMF pictures of a workbook to SVG data URLs, leaving out the ones it cannot draw', async () => {
		const { bytes } = await picturesWorkbook();
		const images = await convertParadisSpreadsheetMetafiles(bytes);
		deepStrictEqual(Object.values(images).map(href => [href.slice(0, href.indexOf(';')), /<svg\b/.test(Buffer.from(href.slice(href.indexOf(',') + 1), 'base64').toString('utf8'))]), [['data:image/svg+xml', true]]);
	});

	test('converts the same EMF pictures in the metafile worker, started through the common worker entry', async function () {
		// The Electron renderer test host cannot launch worker_threads. The node unit runner is the
		// production execution boundary (the shared process) and runs this test.
		if (process.type === 'renderer') { this.skip(); }
		const { bytes } = await picturesWorkbook();
		const inProcess = await convertParadisSpreadsheetMetafiles(bytes);
		const workers: unknown[] = [];
		const factory = ParadisSpreadsheetMetafileWorkerBackend.workerFactory(FileAccess.asFileUri('vs/paradis/contrib/fileViewers/node/spreadsheet/paradisSpreadsheetMetafileWorkerMain.js').fsPath);
		const backend = new ParadisSpreadsheetMetafileWorkerBackend(() => { const worker = factory(); workers.push(worker); return worker; });
		try {
			const converted = await backend.convert(bytes, CancellationToken.None);
			// Without the common entry the packaged build cannot resolve jszip in the worker; the reply would be `failed`.
			deepStrictEqual({ converted, common: workers.map(worker => worker instanceof ParadisWorker) }, { converted: { images: { ...inProcess } }, common: [true] });
		} finally {
			backend.dispose();
		}
	});

	test('rejects bytes that are not an xlsx archive', async () => {
		const service = new ParadisSpreadsheetService();
		const malformed = Buffer.from('not an xlsx workbook').toString('base64');

		await rejects(service.parseWorkbook(malformed));
	});

	test('returns no sheets for a valid workbook with no worksheets', async () => {
		const service = new ParadisSpreadsheetService();
		const workbook = await encodeWorkbook(() => undefined);

		const result = await service.parseWorkbook(workbook);

		deepStrictEqual(result.sheets, []);
	});

	test('preserves worksheet order, names, and values across multiple sheets', async () => {
		const service = new ParadisSpreadsheetService();
		const workbook = await encodeWorkbook(book => {
			const first = book.addWorksheet('First');
			first.getCell('A1').value = 'alpha';
			const second = book.addWorksheet('Second');
			second.getCell('A1').value = 42;
			book.addWorksheet('Blank');
		});

		const result = await service.parseWorkbook(workbook);

		deepStrictEqual(result.sheets.map(sheet => sheet.name), ['First', 'Second', 'Blank']);
		strictEqual(result.sheets[0].rows[0].cells[0].value, 'alpha');
		strictEqual(result.sheets[1].rows[0].cells[0].value, '42');
		strictEqual(result.sheets[2].rows[0].cells[0].value, '');
	});

	test('formats a formula result that evaluates to a date like a direct date cell', async () => {
		const service = new ParadisSpreadsheetService();
		// 直値のセルと数式セルを並べ、同じ表示形式なら同じ文字列になることを見る。
		// 書き込み時に付く既定の表示形式は mm-dd-yy なので、それが適用された結果を期待する。
		const workbook = await encodeWorkbook(book => {
			const sheet = book.addWorksheet('Formulas');
			sheet.getCell('A1').value = { formula: 'TODAY()', result: new Date(Date.UTC(2026, 1, 3)) } as ExcelJS.CellFormulaValue;
			sheet.getCell('A2').value = new Date(Date.UTC(2026, 1, 3));
		});

		const result = await service.parseWorkbook(workbook);

		const [formula, direct] = result.sheets[0].rows.map(row => row.cells[0].value);
		strictEqual(formula, direct);
		strictEqual(formula, '02-03-26');
	});

	test('shows a formula error result as its error code instead of [object Object]', async () => {
		const service = new ParadisSpreadsheetService();
		const workbook = await encodeWorkbook(book => {
			const sheet = book.addWorksheet('Formulas');
			sheet.getCell('A1').value = { formula: 'A2/0', result: { error: '#DIV/0!' } } as ExcelJS.CellFormulaValue;
		});

		const result = await service.parseWorkbook(workbook);

		strictEqual(result.sheets[0].rows[0].cells[0].value, '#DIV/0!');
	});

	test('returns at most 2000 rows and marks a larger worksheet as truncated', async () => {
		const service = new ParadisSpreadsheetService();
		const workbook = await encodeWorkbook(book => {
			const sheet = book.addWorksheet('Large');
			for (let row = 1; row <= 2001; row++) {
				sheet.getCell(row, 1).value = `row-${row}`;
			}
		});

		const result = await service.parseWorkbook(workbook);
		const sheet = result.sheets[0];

		strictEqual(sheet.rows.length, 2000);
		strictEqual(sheet.truncated, true);
		strictEqual(sheet.rows[0].excelRow, 1);
		strictEqual(sheet.rows[1999].excelRow, 2000);
		strictEqual(sheet.rows[1999].cells[0].value, 'row-2000');
	});

	test('keeps data validation on otherwise empty cells as a sparse range', async () => {
		const service = new ParadisSpreadsheetService();
		const workbook = await encodeWorkbook(book => {
			const sheet = book.addWorksheet('Input');
			sheet.pageSetup.printArea = 'A1:A1';
			const validation: ExcelJS.DataValidation = {
				type: 'list',
				formulae: ['"A,B"'],
				showInputMessage: true,
				prompt: 'Select a value',
			};
			for (let row = 3; row <= 20; row++) {
				sheet.getCell(row, 3).dataValidation = validation;
			}
		});

		const result = await service.parseWorkbook(workbook);
		const sheet = result.sheets[0];

		strictEqual(sheet.minCol, 1);
		strictEqual(sheet.rows.length, 1);
		deepStrictEqual(sheet.dataValidations, [{
			range: { minR: 3, maxR: 20, minC: 3, maxC: 3 },
			validation: {
				type: 'list',
				formulae: ['"A,B"'],
				allowBlank: false,
				showInputMessage: true,
				prompt: 'Select a value',
				showErrorMessage: false,
				errorStyle: 'stop',
			},
		}]);
	});

	suite('shapes to the right of the shown columns', () => {
		/** A callout like Excel's, anchored to one cell, `widthPx` wide; `flipH` turns its tail to the right. */
		function callout(column: number, widthPx: number, flipH = false): string {
			return `<xdr:oneCellAnchor><xdr:from><xdr:col>${column}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="${widthPx * 9525}" cy="381000"/>`
				+ `<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="${column + 2}" name="Callout"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:xfrm${flipH ? ' flipH="1"' : ''}><a:off x="0" y="0"/><a:ext cx="${widthPx * 9525}" cy="381000"/></a:xfrm>`
				+ '<a:prstGeom prst="wedgeRoundRectCallout"><a:avLst><a:gd name="adj1" fmla="val -62000"/><a:gd name="adj2" fmla="val 12000"/><a:gd name="adj3" fmla="val 16667"/></a:avLst></a:prstGeom>'
				+ '<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></xdr:spPr>'
				+ '<xdr:txBody><a:bodyPr wrap="square" anchor="t"/><a:lstStyle/><a:p><a:r><a:t>Check the boundary marks.</a:t></a:r></a:p></xdr:txBody></xdr:sp><xdr:clientData fPrintsWithSheet="0"/></xdr:oneCellAnchor>';
		}

		/** A sheet printing A1:E3 with 75px columns whose drawing holds `anchors` (none: no drawing part at all). */
		async function calloutWorkbook(anchors: readonly string[] | undefined, printArea = true): Promise<string> {
			const book = new ExcelJS.Workbook();
			const sheet = book.addWorksheet('Form');
			sheet.columns = Array.from({ length: 12 }, () => ({ width: 10 }));
			for (let row = 1; row <= 3; row++) {
				for (let column = 1; column <= 5; column++) {
					sheet.getCell(row, column).value = `r${row}c${column}`;
				}
			}
			if (printArea) {
				sheet.pageSetup.printArea = 'A1:E3';
			}
			if (anchors) {
				sheet.addImage(book.addImage({ buffer: Buffer.from(minimalPng(1, 1)) as unknown as ExcelJS.Buffer, extension: 'png' }), { tl: { col: 0, row: 0 }, ext: { width: 1, height: 1 } });
			}
			const zip = await JSZip.loadAsync(await book.xlsx.writeBuffer());
			if (anchors) {
				const name = Object.keys(zip.files).find(candidate => /^xl\/drawings\/drawing\d+\.xml$/.test(candidate))!;
				zip.file(name, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' + anchors.join('') + '</xdr:wsDr>');
			}
			return Buffer.from(await zip.generateAsync({ type: 'uint8array' })).toString('base64');
		}

		async function shown(workbook: string) {
			const sheet = (await new ParadisSpreadsheetService().parseWorkbook(workbook)).sheets[0];
			return { columns: sheet.columnCount, widths: sheet.columnWidths, rows: sheet.rows.length, printArea: sheet.printArea, firstRow: sheet.rows[0].cells.map(cell => cell.value) };
		}

		test('extends the shown columns to the right edge of a callout outside the print area, keeping the print area and rows', async () => {
			// G (0-based 6) + 140px ends inside H; with its tail turned right (12% of the width) it reaches into I.
			deepStrictEqual([await shown(await calloutWorkbook([callout(6, 140)])), (await shown(await calloutWorkbook([callout(6, 140, true)]))).columns], [{
				columns: 8,
				widths: [75, 75, 75, 75, 75, 75, 75, 75],
				rows: 3,
				printArea: { minR: 1, maxR: 3, minC: 1, maxC: 5 },
				firstRow: ['r1c1', 'r1c2', 'r1c3', 'r1c4', 'r1c5', '', '', ''],
			}, 9]);
		});

		test('also extends a sheet without a print area, and stops at the column limit for a far-away shape', async () => {
			deepStrictEqual([
				(await shown(await calloutWorkbook([callout(6, 140)], false))).columns,
				(await shown(await calloutWorkbook([callout(500, 140)]))).columns,
			], [8, 5 + 64]);
		});

		test('keeps the shown columns when the shapes stay inside them or there are none', async () => {
			deepStrictEqual([
				(await shown(await calloutWorkbook([callout(1, 140)]))).columns,
				(await shown(await calloutWorkbook(undefined))).columns,
				(await shown(await calloutWorkbook(undefined, false))).columns,
			], [5, 5, 5]);
		});
	});

	suite('notes set to show on the sheet', () => {
		/** A note at B2 whose VML box is anchored from `from` to `to` (column, row; 0-based), shown or hidden. */
		function noteShape(visible: boolean, from: readonly [number, number], to: readonly [number, number]): string {
			return `<v:shape id="_x0000_s1025" type="#_x0000_t202" style='position:absolute;margin-left:80pt;margin-top:2pt;width:96pt;height:55.5pt;z-index:1;visibility:${visible ? 'visible' : 'hidden'}' fillcolor="#ffffe1" o:insetmode="auto">`
				+ `<x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>${from[0]}, 15, ${from[1]}, 2, ${to[0]}, 15, ${to[1]}, 4</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>1</x:Row><x:Column>1</x:Column>${visible ? '<x:Visible/>' : ''}</x:ClientData></v:shape>`;
		}

		/** A sheet printing A1:E3 with 75px columns and a note at B2 whose VML holds `shapes` (none: the VML exceljs wrote). */
		async function noteWorkbook(shapes: string | undefined): Promise<string> {
			const book = new ExcelJS.Workbook();
			const sheet = book.addWorksheet('Form');
			sheet.columns = Array.from({ length: 12 }, () => ({ width: 10 }));
			for (let row = 1; row <= 3; row++) {
				for (let column = 1; column <= 5; column++) {
					sheet.getCell(row, column).value = `r${row}c${column}`;
				}
			}
			sheet.getCell('B2').note = 'Sample: check this';
			sheet.pageSetup.printArea = 'A1:E3';
			const zip = await JSZip.loadAsync(await book.xlsx.writeBuffer());
			if (shapes !== undefined) {
				const name = Object.keys(zip.files).find(candidate => /^xl\/drawings\/vmlDrawing\d+\.vml$/.test(candidate))!;
				zip.file(name, '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">' + shapes + '</xml>');
			}
			return Buffer.from(await zip.generateAsync({ type: 'uint8array' })).toString('base64');
		}

		async function shown(workbook: string) {
			const sheet = (await new ParadisSpreadsheetService().parseWorkbook(workbook)).sheets[0];
			return { columns: sheet.columnCount, rows: sheet.rows.length, printArea: sheet.printArea, notes: sheet.comments?.map(comment => [comment.ref, comment.shown]) };
		}

		test('keeps the saved box of a shown note and extends the shown columns and rows to it, keeping the print area', async () => {
			// From D1 + 15px to H7 + 15px: the box ends inside column H (8) and row 7.
			deepStrictEqual(await shown(await noteWorkbook(noteShape(true, [3, 0], [7, 6]))), {
				columns: 8,
				rows: 7,
				printArea: { minR: 1, maxR: 3, minC: 1, maxC: 5 },
				notes: [['B2', { from: { c: 3, co: 15 * 9525, r: 0, ro: 2 * 9525 }, to: { c: 7, co: 15 * 9525, r: 6, ro: 4 * 9525 }, fill: '#ffffe1' }]],
			});
		});

		test('keeps hidden notes, notes from exceljs, and shown notes whose box it cannot read as markers only', async () => {
			const hidden = await shown(await noteWorkbook(noteShape(false, [3, 0], [7, 6])));
			const fromExcelJs = await shown(await noteWorkbook(undefined));
			// Shown, but the anchor ends before it starts and the style has no size. (A VML that is not XML at all stops
			// exceljs from opening the workbook, so the reader's own fallback for it is covered by the comment tests.)
			const broken = await shown(await noteWorkbook(noteShape(true, [7, 6], [3, 0]).replace(/width:[^;]+;height:[^;]+;/, '')));
			const expected = { columns: 5, rows: 3, printArea: { minR: 1, maxR: 3, minC: 1, maxC: 5 }, notes: [['B2', undefined]] };
			deepStrictEqual([hidden, fromExcelJs, broken], [expected, expected, expected]);
		});
	});

	test('rejects encrypted (CFB) workbooks with a descriptive message', async () => {
		const service = new ParadisSpreadsheetService(async () => ({ ExcelJS, JSZip }));
		// OLE2/CFB 標準シグネチャ(D0 CF 11 E0) + 適当な続き。zip ではないため exceljs も読めない。
		const encrypted = Buffer.concat([Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]), Buffer.alloc(16)]).toString('base64');

		await rejects(service.parseWorkbook(encrypted), /パスワードで保護/);
	});


	test('applies the stored number format instead of printing the raw value', async () => {
		const service = new ParadisSpreadsheetService();
		const cases: readonly (readonly [unknown, string, string])[] = [
			[0.5, '0%', '50%'],
			[1234567, '#,##0', '1,234,567'],
			[-1234.5, '#,##0.00;[Red](#,##0.00)', '(1,234.50)'],
			[0.000012345, '0.00E+00', '1.23E-05'],
			[0.75, '# ?/?', '0 3/4'],
			[1234, '0"円"', '1234円'],
		];
		const workbook = await encodeWorkbook(book => {
			const sheet = book.addWorksheet('Sheet1');
			cases.forEach(([value, numFmt], index) => {
				const cell = sheet.getCell(index + 1, 1);
				cell.value = value as number;
				cell.numFmt = numFmt;
			});
		});

		const result = await service.parseWorkbook(workbook);

		deepStrictEqual(result.sheets[0].rows.map(row => row.cells[0].value), cases.map(([, , expected]) => expected));
	});

	test('keeps accounting formats even though the fill-alignment token is only approximated', async () => {
		// 会計書式は必ず `*`(残り幅を埋める指定)を含む。数値の整形自体は正しくできているので、
		// 近似止まりを理由に一律で捨てると会計書式が丸ごと効かなくなる。
		const accounting = '_("¥"* #,##0.00_);_("¥"* (#,##0.00);_("¥"* "-"??_);_(@_)';
		const service = new ParadisSpreadsheetService();
		const workbook = await encodeWorkbook(book => {
			const sheet = book.addWorksheet('Sheet1');
			const cell = sheet.getCell(1, 1);
			cell.value = 1234.5;
			cell.numFmt = accounting;
		});

		const result = await service.parseWorkbook(workbook);

		ok(result.sheets[0].rows[0].cells[0].value.includes('1,234.50'), result.sheets[0].rows[0].cells[0].value);
	});

	test('renders date and elapsed-time formats without leaking a host date string', async () => {
		const service = new ParadisSpreadsheetService();
		const workbook = await encodeWorkbook(book => {
			const sheet = book.addWorksheet('Sheet1');
			const date = sheet.getCell(1, 1);
			date.value = new Date(Date.UTC(2023, 2, 15));
			date.numFmt = 'yyyy/mm/dd';
			const elapsed = sheet.getCell(2, 1);
			elapsed.value = 0.5;
			elapsed.numFmt = '[h]:mm:ss';
		});

		const result = await service.parseWorkbook(workbook);

		deepStrictEqual(result.sheets[0].rows.map(row => row.cells[0].value), ['2023/03/15', '12:00:00']);
	});

	test('keeps the previous rendering for General cells and unusable format codes', async () => {
		const service = new ParadisSpreadsheetService();
		const workbook = await encodeWorkbook(book => {
			const sheet = book.addWorksheet('Sheet1');
			sheet.getCell(1, 1).value = 1234.5;
			const general = sheet.getCell(2, 1);
			general.value = 1234.5;
			general.numFmt = 'General';
			const text = sheet.getCell(3, 1);
			text.value = 'そのまま';
			text.numFmt = '@';
		});

		const result = await service.parseWorkbook(workbook);

		deepStrictEqual(result.sheets[0].rows.map(row => row.cells[0].value), ['1234.5', '1234.5', 'そのまま']);
	});

	suite('applyTint (OOXML HLS formula)', () => {
		test('keeps the color unchanged for tint 0 (exact round-trip)', () => {
			strictEqual(applyTint('#2E75B6', 0), '#2E75B6');
			strictEqual(applyTint('#FFFFFF', 0), '#FFFFFF');
		});

		test('darkens with negative tint while preserving hue/saturation', () => {
			// 黒へ向かう RGB 線形補間と異なり、HLS 輝度式では彩度が保たれる(純赤の50%減光 → Excel の暗赤)。
			strictEqual(applyTint('#FF0000', -0.5), '#800000');
		});

		test('lightens with positive tint like Excel theme tints', () => {
			// Excel「アクセント1 淡色60%」相当(2E75B6 + tint 0.6)。彩度を保ったまま淡色化する。
			strictEqual(applyTint('#2E75B6', 0.6), '#A5C8E8');
		});
	});

	suite('resolveIndexedColor', () => {
		test('resolves legacy palette entries', () => {
			strictEqual(resolveIndexedColor(0), '#000000');
			strictEqual(resolveIndexedColor(1), '#FFFFFF');
			strictEqual(resolveIndexedColor(10), '#FF0000');
			strictEqual(resolveIndexedColor(43), '#FFFF99');
			strictEqual(resolveIndexedColor(51), '#FFCC00');
			strictEqual(resolveIndexedColor(55), '#969696');
		});

		test('maps system colors and rejects out-of-range indices', () => {
			strictEqual(resolveIndexedColor(64), '#000000');
			strictEqual(resolveIndexedColor(65), '#FFFFFF');
			strictEqual(resolveIndexedColor(66), null);
			strictEqual(resolveIndexedColor(-1), null);
		});
	});

	suite('formatDateFallback', () => {
		test('renders a locale-independent date and omits zero time', () => {
			strictEqual(formatDateFallback(new Date(2026, 1, 3)), '2026-02-03');
			strictEqual(formatDateFallback(new Date(2026, 11, 31)), '2026-12-31');
		});

		test('appends time only when present', () => {
			strictEqual(formatDateFallback(new Date(2026, 1, 3, 4, 5, 6)), '2026-02-03 04:05:06');
			strictEqual(formatDateFallback(new Date(2026, 1, 3, 0, 0, 0)), '2026-02-03');
		});
	});

	test('centers boolean cells under general alignment like Excel does', async () => {
		const service = new ParadisSpreadsheetService();
		const workbook = await encodeWorkbook(book => {
			const sheet = book.addWorksheet('Booleans');
			sheet.getCell('A1').value = true;
			sheet.getCell('A2').value = false;
			sheet.getCell('A3').value = 'text';
			sheet.getCell('A4').value = 42;
		});

		const result = await service.parseWorkbook(workbook);
		const rows = result.sheets[0].rows;

		strictEqual(rows[0].cells[0].style.textAlign, 'center');
		strictEqual(rows[1].cells[0].style.textAlign, 'center');
		strictEqual(rows[2].cells[0].style.textAlign, undefined);
		strictEqual(rows[3].cells[0].style.textAlign, 'right');
	});

	test('retains raw diagonal style and color provenance in the ExcelJS projection', async () => {
		const service = new ParadisSpreadsheetService();
		const workbook = await encodeWorkbook(book => {
			const sheet = book.addWorksheet('Diagonal');
			sheet.getCell('A1').value = 'argb';
			sheet.getCell('A1').border = { diagonal: { up: true, down: false, style: 'dashDot', color: { argb: '80112233' } } } as unknown as ExcelJS.Borders;
			sheet.getCell('A2').value = 'theme';
			sheet.getCell('A2').border = { diagonal: { up: false, down: true, style: 'medium', color: { theme: 4, tint: 0.25 } } } as unknown as ExcelJS.Borders;
			sheet.getCell('A3').value = 'indexed';
			sheet.getCell('A3').border = { diagonal: { up: true, down: true, style: 'thin', color: { indexed: 7 } } } as unknown as ExcelJS.Borders;
		});

		const rows = (await service.parseWorkbook(workbook)).sheets[0].rows;

		deepStrictEqual(rows.map(row => row.cells[0].diagonal), [
			{ up: true, down: false, style: '1px dashed', color: '#112233', rawStyle: 'dashDot', rawColor: { kind: 'rgb', rgb: '80112233' } },
			{ up: false, down: true, style: '2px solid', color: '#7BA1CD', rawStyle: 'medium', rawColor: { kind: 'theme', theme: 4, tint: '0.25' } },
			{ up: true, down: true, style: '1px solid', color: '#00FFFF', rawStyle: 'thin', rawColor: { kind: 'indexed', indexed: 7 } },
		]);
	});

	test('maps auto diagonal color provenance when ExcelJS exposes it', () => {
		const cell = {
			border: { diagonal: { up: true, down: false, style: 'hair', color: { auto: true, tint: 0.3 } } },
		} as unknown as ExcelJS.Cell;

		deepStrictEqual(getCellDiagonalForTest(cell), {
			up: true, down: false, style: '1px solid', color: '#000', rawStyle: 'hair', rawColor: { kind: 'auto', auto: true, tint: '0.3' },
		});
	});
});
