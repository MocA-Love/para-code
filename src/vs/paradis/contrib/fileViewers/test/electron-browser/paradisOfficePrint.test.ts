/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok, strictEqual, throws } from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PARADIS_OFFICE_PRINT_LIMITS,
	ParadisOfficePrintError,
	createParadisOfficeLineLabelBlock,
	createParadisOfficeSpreadsheetPrintModel,
	createParadisOfficeWordPrintModel,
	renderParadisOfficePrintHtml,
	selectParadisOfficePrintPages,
	type ParadisOfficeSpreadsheetPrintInput,
	type ParadisOfficeWordPrintInput,
} from '../../common/paradisOfficePrint.js';
import type { ParadisOfficePlaceholder, ParadisOfficePrintModel } from '../../common/paradisOfficeProtocol.js';
import type { IParadisWorkbookData } from '../../common/paradisSpreadsheet.js';
import { ParadisOfficePrintService, withParadisOfficePrintResult } from '../../electron-browser/paradisOfficePrintService.js';
import { createLegacySpreadsheetPrintModel } from '../../electron-browser/paradisSpreadsheetEditor.js';

const unsafePlaceholder: ParadisOfficePlaceholder = {
	nodeId: 'ole-1',
	feature: 'ole',
	reason: 'unsafe',
	title: '<img src=x onerror=alert(1)>',
	detail: 'Blocked & retained as alternative content.',
};

function spreadsheetInput(): ParadisOfficeSpreadsheetPrintInput {
	return {
		title: 'Quarterly <Plan>',
		sheets: [{
			nodeId: 'sheet-data',
			name: 'Data & Forecast',
			cells: [
				{ nodeId: 'a1', row: 1, column: 1, runs: [{ text: 'Title A' }] },
				{ nodeId: 'b1', row: 1, column: 2, runs: [{ text: 'Title B' }] },
				{ nodeId: 'a2', row: 2, column: 1, runs: [{ text: 'North' }] },
				{
					nodeId: 'b2', row: 2, column: 2, runs: [{ text: '<script>unsafe()</script>' }],
					lines: [
						{ kind: 'cellDiagonal', nodeId: 'b2-diagonal', direction: 'topLeftToBottomRight' },
						{ kind: 'drawingLine', nodeId: 'approval-line', label: 'Approval Slash' },
					],
				},
				{ nodeId: 'a3', row: 3, column: 1, runs: [{ text: 'Outside Print Area' }] },
			],
			printAreas: [{ minRow: 1, minColumn: 1, maxRow: 2, maxColumn: 2 }],
			pageRanges: [
				{ minRow: 2, minColumn: 1, maxRow: 2, maxColumn: 1 },
				{ minRow: 2, minColumn: 2, maxRow: 2, maxColumn: 2 },
			],
			pageSetup: { widthPoints: 720, heightPoints: 540 },
			printTitles: { rows: { from: 1, to: 1 } },
			headerFooter: {
				first: { header: { center: 'First Header' }, footer: { right: 'First Footer' } },
				even: { header: { center: 'Even Header' }, footer: { right: 'Even Footer' } },
				odd: { header: { center: 'Odd Header' }, footer: { right: 'Odd Footer' } },
			},
			placeholders: [unsafePlaceholder],
		}],
	};
}

function wordInput(): ParadisOfficeWordPrintInput {
	return {
		title: 'Contract.docx',
		sections: [
			{
				nodeId: 'section-1',
				widthPoints: 612,
				heightPoints: 792,
				items: [
					{ kind: 'block', block: { kind: 'text', nodeId: 'p1', runs: [{ text: 'First page' }] } },
					{ kind: 'pageBreak', nodeId: 'saved-break-1', source: 'saved' },
					{ kind: 'block', block: createParadisOfficeLineLabelBlock({ kind: 'tableDiagonal', nodeId: 'table-diagonal', direction: 'topRightToBottomLeft' }) },
					{ kind: 'block', block: { kind: 'text', nodeId: 'p2', runs: [{ text: 'Second page' }] } },
				],
				placeholders: [unsafePlaceholder],
			},
			{
				nodeId: 'section-2',
				breakBefore: 'nextPage',
				widthPoints: 595,
				heightPoints: 842,
				items: [{ kind: 'block', block: { kind: 'text', nodeId: 'p3', runs: [{ text: 'Third page' }] } }],
				placeholders: [],
			},
		],
	};
}

suite('ParadisOfficePrint', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('builds Excel pages from print area, saved page rectangles, setup, titles, and header/footer', () => {
		const model = createParadisOfficeSpreadsheetPrintModel(spreadsheetInput());
		const pages = model.pages.map(page => JSON.stringify(page));

		deepStrictEqual(model.pages.map(page => [page.pageNumber, page.widthPoints, page.heightPoints]), [
			[1, 720, 540],
			[2, 720, 540],
		]);
		ok(pages[0].includes('First Header'));
		ok(pages[0].includes('First Footer'));
		ok(pages[1].includes('Even Header'));
		ok(pages[1].includes('Even Footer'));
		ok(pages[0].includes('Title A'));
		ok(pages[1].includes('Title B'));
		ok(pages[1].includes('Diagonal border: top-left to bottom-right'));
		ok(pages[1].includes('Drawing line: Approval Slash'));
		strictEqual(pages.some(page => page.includes('Outside Print Area')), false);
		strictEqual(model.pages[1].placeholders[0], unsafePlaceholder);
	});

	test('does not create saved spreadsheet pages outside the print area', () => {
		const input = spreadsheetInput();
		const model = createParadisOfficeSpreadsheetPrintModel({
			...input,
			sheets: input.sheets.map(sheet => ({
				...sheet,
				pageRanges: [
					{ minRow: 20, minColumn: 20, maxRow: 30, maxColumn: 30 },
					...(sheet.pageRanges ?? []),
				],
			})),
		});

		strictEqual(model.pages.length, 2);
		ok(JSON.stringify(model.pages[0]).includes('North'));
	});

	test('orders legacy saved spreadsheet rectangles by their page number', () => {
		const workbook: IParadisWorkbookData = {
			sheets: [{
				name: 'Ordered', minCol: 1, columnCount: 2, columnWidths: [10, 10], truncated: false,
				rows: [
					{ excelRow: 1, height: 10, cells: [{ value: 'A1', style: {} }, { value: 'B1', style: {} }] },
					{ excelRow: 2, height: 10, cells: [{ value: 'A2', style: {} }, { value: 'B2', style: {} }] },
				],
				pageLayout: {
					rowBands: [{ from: 1, to: 1, manual: false, size: 10 }, { from: 2, to: 2, manual: false, size: 10 }],
					colBands: [{ from: 1, to: 1, manual: false, size: 10 }, { from: 2, to: 2, manual: false, size: 10 }],
					autoRowBreaks: [1], autoColBreaks: [1], pageNumbers: [[1, 3], [2, 4]], pageCount: 4,
					effectiveScale: 1, usableWidth: 10, usableHeight: 10,
				},
			}]
		};

		const pages = createLegacySpreadsheetPrintModel(workbook, 'Ordered.xlsx').pages.map(page => JSON.stringify(page));
		deepStrictEqual(pages.map(page => ['A1', 'A2', 'B1', 'B2'].find(value => page.includes(value))), ['A1', 'A2', 'B1', 'B2']);
	});

	test('uses Word sections and saved breaks without claiming Word-equivalent automatic pagination', () => {
		const model = createParadisOfficeWordPrintModel(wordInput());

		deepStrictEqual(model.pages.map(page => [page.pageNumber, page.widthPoints, page.heightPoints]), [
			[1, 612, 792],
			[2, 612, 792],
			[3, 595, 842],
		]);
		ok(JSON.stringify(model.pages[1]).includes('Table diagonal border: top-right to bottom-left'));
		strictEqual(model.pages[1].placeholders[0], unsafePlaceholder);
		ok(model.approximationWarnings.some(warning => warning.code === 'word.pagination.approximate'));
	});

	test('inserts only the blank page required by odd and even section breaks', () => {
		const model = createParadisOfficeWordPrintModel({
			title: 'Sections.docx',
			sections: [
				{ nodeId: 's1', widthPoints: 612, heightPoints: 792, items: [{ kind: 'block', block: { kind: 'text', nodeId: 'p1', runs: [{ text: 'Page one' }] } }], placeholders: [] },
				{ nodeId: 's2', breakBefore: 'oddPage', widthPoints: 612, heightPoints: 792, items: [{ kind: 'block', block: { kind: 'text', nodeId: 'p3', runs: [{ text: 'Page three' }] } }], placeholders: [] },
				{ nodeId: 's3', breakBefore: 'evenPage', widthPoints: 612, heightPoints: 792, items: [{ kind: 'block', block: { kind: 'text', nodeId: 'p4', runs: [{ text: 'Page four' }] } }], placeholders: [] },
			],
		});

		strictEqual(model.pages.length, 4);
		strictEqual(JSON.stringify(model.pages[1]).includes('Page'), false);
		ok(JSON.stringify(model.pages[2]).includes('Page three'));
		ok(JSON.stringify(model.pages[3]).includes('Page four'));
	});

	test('renders escaped, script-free HTML with visible unsafe and unsupported placeholders', () => {
		const model = createParadisOfficeSpreadsheetPrintModel(spreadsheetInput());
		const forgedRole = 'section" onload="unsafe' as 'section';
		const artifact = renderParadisOfficePrintHtml({
			...model,
			pages: model.pages.map((page, index) => index === 0 ? {
				...page,
				blocks: [{ kind: 'container', nodeId: 'forged-role', role: forgedRole, children: page.blocks }, ...page.blocks],
			} : page),
		});

		strictEqual(/<script\b/i.test(artifact.html), false);
		strictEqual(/<[^>]+\sonerror\s*=/i.test(artifact.html), false);
		strictEqual(artifact.html.includes(' onload="unsafe"'), false);
		ok(artifact.html.includes('data-print-role="section&quot; onload=&quot;unsafe"'));
		ok(artifact.html.includes('&lt;script&gt;unsafe()&lt;/script&gt;'));
		ok(artifact.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
		ok(artifact.html.includes('Blocked &amp; retained as alternative content.'));
		ok(artifact.html.includes('data-placeholder-reason="unsafe"'));
		ok(artifact.byteLength > 0 && artifact.byteLength <= PARADIS_OFFICE_PRINT_LIMITS.maximumHtmlBytes);
	});

	test('applies an inclusive page range after model generation and rejects invalid ranges', () => {
		const model = createParadisOfficeWordPrintModel(wordInput());
		const selected = selectParadisOfficePrintPages(model, [2, 3]);

		deepStrictEqual(selected.pages.map(page => page.pageNumber), [2, 3]);
		throws(() => selectParadisOfficePrintPages(model, [0, 1]), (error: unknown) => error instanceof ParadisOfficePrintError && error.code === 'invalidPageRange');
		throws(() => selectParadisOfficePrintPages(model, [3, 2]), (error: unknown) => error instanceof ParadisOfficePrintError && error.code === 'invalidPageRange');
		throws(() => selectParadisOfficePrintPages(model, [1, 4]), (error: unknown) => error instanceof ParadisOfficePrintError && error.code === 'invalidPageRange');
	});

	test('routes Web printing through the browser-print callback with selected script-free HTML', async () => {
		const html: string[] = [];
		const service = new ParadisOfficePrintService({
			platform: 'web',
			printHtml: async value => { html.push(value); },
		});

		const result = await service.print(createParadisOfficeWordPrintModel(wordInput()), { pageRange: [2, 2] }, CancellationToken.None);

		deepStrictEqual(result, { ok: true, kind: 'printed', pageCount: 1 });
		strictEqual(html.length, 1);
		strictEqual(/<script\b/i.test(html[0]), false);
		ok(html[0].includes('Second page'));
		strictEqual(html[0].includes('First page'), false);
	});

	test('routes connected Mobile printing through host PDF export and share with owned bytes', async () => {
		const backendBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
		let exportedRange: readonly [number, number] | undefined;
		let sharedBytes: Uint8Array | undefined;
		const service = new ParadisOfficePrintService({
			platform: 'mobileConnected',
			exportPdf: async (_model, range) => {
				exportedRange = range;
				return backendBytes;
			},
			sharePdf: async bytes => { sharedBytes = bytes; },
		});

		const result = await service.print(createParadisOfficeWordPrintModel(wordInput()), { pageRange: [1, 2] }, CancellationToken.None);

		deepStrictEqual(result, { ok: true, kind: 'shared', pageCount: 2, byteLength: backendBytes.byteLength });
		deepStrictEqual(exportedRange, [1, 2]);
		ok(sharedBytes instanceof Uint8Array);
		strictEqual(sharedBytes === backendBytes, false, 'the service owns a copy before crossing the share boundary');
		deepStrictEqual([...sharedBytes!], [...backendBytes]);
	});

	test('returns stable safe errors for unsupported, failed, cancelled, and malformed PDF operations', async () => {
		const model = createParadisOfficeWordPrintModel(wordInput());
		const unsupported = await new ParadisOfficePrintService({ platform: 'mobileStandalone' }).print(model, {}, CancellationToken.None);
		const failed = await new ParadisOfficePrintService({
			platform: 'web',
			printHtml: async () => { throw new Error('/Users/person/secret.docx'); },
		}).print(model, {}, CancellationToken.None);
		const cancelled = await new ParadisOfficePrintService({ platform: 'web', printHtml: async () => undefined }).print(model, {}, CancellationToken.Cancelled);
		const malformed = await new ParadisOfficePrintService({
			platform: 'desktop',
			exportPdf: async () => new Uint8Array([1, 2, 3]),
		}).exportPdf(model, {}, CancellationToken.None);

		deepStrictEqual([unsupported.ok, failed.ok, cancelled.ok, malformed.ok], [false, false, false, false]);
		if (unsupported.ok || failed.ok || cancelled.ok || malformed.ok) {
			throw new Error('Expected all print operations to fail');
		}
		deepStrictEqual([
			[unsupported.error.stage, unsupported.error.code],
			[failed.error.stage, failed.error.code],
			[cancelled.error.stage, cancelled.error.code],
			[malformed.error.stage, malformed.error.code],
		], [
			['export', 'unsupported'],
			['export', 'printFailed'],
			['transport', 'cancelled'],
			['export', 'printFailed'],
		]);
		strictEqual(JSON.stringify(failed).includes('/Users/person/secret.docx'), false);
		const failedModel = withParadisOfficePrintResult(model, failed);
		ok(failedModel.approximationWarnings.some(warning => warning.code === 'print.export.printFailed' && warning.message === failed.error.safeMessage));
	});

	test('enforces page and cancellation budgets before HTML or backend work', async () => {
		const page = createParadisOfficeWordPrintModel(wordInput()).pages[0];
		const oversized: ParadisOfficePrintModel = {
			title: 'Oversized',
			pages: Array.from({ length: PARADIS_OFFICE_PRINT_LIMITS.maximumPages + 1 }, (_, index) => ({ ...page, pageNumber: index + 1 })),
			approximationWarnings: [],
		};
		let called = false;
		const service = new ParadisOfficePrintService({ platform: 'web', printHtml: async () => { called = true; } });

		throws(() => renderParadisOfficePrintHtml(oversized), (error: unknown) => error instanceof ParadisOfficePrintError && error.code === 'limitExceeded');
		const cancelled = await service.print(createParadisOfficeWordPrintModel(wordInput()), {}, CancellationToken.Cancelled);
		strictEqual(cancelled.ok, false);
		strictEqual(called, false);
	});
});
