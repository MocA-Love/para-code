/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok, strictEqual } from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type {
	ParadisOfficeChange,
	ParadisOfficeChangeCategory,
	ParadisOfficeCompletenessManifest,
	ParadisOfficePlaceholder,
	ParadisOfficePrintModel,
	ParadisOfficeSearchResult,
	ParadisOfficeSourceDescriptor,
} from '../../common/paradisOfficeProtocol.js';
import type { ParadisOfficeRuntimeConfiguration } from '../../common/paradisOfficeCapabilities.js';
import type { IParadisWorkbookData } from '../../common/paradisSpreadsheet.js';
import type { IParadisDiffSheet } from '../../electron-browser/paradisSpreadsheetDiff.js';
import { PARADIS_SPREADSHEET_LEGACY_CHANGE_LIMIT, adaptLegacySpreadsheetInspectorChangeSet, adaptLegacySpreadsheetInspectorChanges } from '../../electron-browser/paradisSpreadsheetDiffEditor.js';
import {
	createLegacySpreadsheetPrintModel,
	isParadisSpreadsheetV1Enabled,
	searchLegacySpreadsheetWorkbook,
} from '../../electron-browser/paradisSpreadsheetEditor.js';
import {
	PARADIS_SPREADSHEET_HIGH_CONTRAST_TOKENS,
	canShowSpreadsheetNoChanges,
	renderSpreadsheetDiagnosticsRibbon,
	spreadsheetPrintWarning,
} from '../../electron-browser/spreadsheet/paradisSpreadsheetDiagnostics.js';
import {
	PARADIS_SPREADSHEET_CHANGE_CATEGORIES,
	ParadisSpreadsheetChangeInspector,
	ParadisSpreadsheetInputRestoration,
	ParadisSpreadsheetOpenGeneration,
	resolveParadisSpreadsheetNavigation,
	restoreParadisSpreadsheetViewState,
	spreadsheetChangeLabel,
} from '../../electron-browser/spreadsheet/paradisSpreadsheetChangeInspector.js';

const completeManifest: ParadisOfficeCompletenessManifest = {
	expectedParts: 4,
	visitedParts: 4,
	parsedParts: 3,
	opaqueParts: 1,
	failedParts: 0,
	omittedParts: 0,
	expectedSemanticUnits: 12,
	visitedSemanticUnits: 12,
	terminal: true,
};

function change(id: string, category: ParadisOfficeChangeCategory, kind: string, locator: string): ParadisOfficeChange {
	return {
		id,
		category,
		subject: { kind, locator },
		before: { kind: 'none' },
		after: { kind: 'scalar', valueType: 'text', value: 'changed' },
		certainty: 'exact',
		sourceParts: ['/xl/workbook.xml'],
		navigableAnchor: `anchor:${id}`,
	};
}

suite('ParadisSpreadsheetInspector', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('renders the diagnostic ribbon with faithful, approximate, alternative, and incomplete counts', () => {
		const document = mainWindow.document.implementation.createHTMLDocument('spreadsheet diagnostics');
		const host = document.createElement('div');
		const ribbon = renderSpreadsheetDiagnosticsRibbon(host, {
			outcome: 'degraded',
			coverages: ['rendered', 'approximated', 'placeholder', 'blockedByPolicy', 'noAnchor'],
			warnings: [{ code: 'projectionMismatch', message: '<img src=x onerror=alert(1)>' }],
		});

		strictEqual(ribbon.getAttribute('role'), 'status');
		strictEqual(ribbon.getAttribute('aria-live'), 'polite');
		ok(ribbon.textContent?.includes('Faithful 1'));
		ok(ribbon.textContent?.includes('Approximate 1'));
		ok(ribbon.textContent?.includes('Alternatives 3'));
		ok(ribbon.textContent?.includes('Analysis Incomplete'));
		strictEqual(ribbon.querySelector('img,script'), null);
		ok(ribbon.textContent?.includes('<img src=x onerror=alert(1)>'));
	});

	test('counts semantic categories and gates No Changes on complete terminal analysis', () => {
		const changes = [
			change('content-1', 'content', 'cell.rawValue', 'Data!A1'),
			change('format-1', 'formatting', 'cell.numberFormat', 'Data!A1'),
			change('format-2', 'formatting', 'cell.diagonalBorder', 'Data!B2'),
			change('object-1', 'object', 'object.lineGeometry', 'Data!object:Line 1'),
		];
		const document = mainWindow.document.implementation.createHTMLDocument('spreadsheet categories');
		const host = document.createElement('div');
		const inspector = disposables.add(new ParadisSpreadsheetChangeInspector(host));
		inspector.setComparison(changes, completeManifest, 'complete');

		deepStrictEqual(PARADIS_SPREADSHEET_CHANGE_CATEGORIES, ['content', 'formatting', 'structure', 'annotation', 'revision', 'object', 'security']);
		strictEqual(host.querySelector('[data-category="formatting"]')?.getAttribute('data-count'), '2');
		strictEqual(host.querySelector('[data-category="object"]')?.getAttribute('data-count'), '1');
		strictEqual(canShowSpreadsheetNoChanges(completeManifest, 'complete', 0), true);
		strictEqual(canShowSpreadsheetNoChanges({ ...completeManifest, terminal: false }, 'complete', 0), false);
		strictEqual(canShowSpreadsheetNoChanges(completeManifest, 'degraded', 0), false);
		inspector.setComparison([], completeManifest, 'complete');
		ok(host.textContent?.includes('No Changes'));
		inspector.setComparison([], { ...completeManifest, visitedSemanticUnits: 11 }, 'complete');
		ok(host.textContent?.includes('Analysis Incomplete'));
	});

	test('navigates placeholders by logical node identity without interpreting document markup', () => {
		const document = mainWindow.document.implementation.createHTMLDocument('spreadsheet placeholders');
		const host = document.createElement('div');
		const navigated: unknown[] = [];
		const inspector = disposables.add(new ParadisSpreadsheetChangeInspector(host, { onNavigate: target => navigated.push(target) }));
		const placeholder: ParadisOfficePlaceholder = {
			nodeId: 'object:chart-1',
			feature: 'unsupportedChart',
			reason: 'unsupported',
			title: '<svg onload=alert(1)>',
			detail: 'Chart remains anchored at Data!F4',
		};
		inspector.setPlaceholders([placeholder]);

		const button = host.querySelector<HTMLButtonElement>('[data-placeholder-id="object:chart-1"]');
		button?.click();
		strictEqual(host.querySelector('svg,script'), null);
		deepStrictEqual(navigated, [{ kind: 'placeholder', locator: 'object:chart-1' }]);
	});

	test('searches hidden sheets and navigates using the semantic locator and anchor', async () => {
		const document = mainWindow.document.implementation.createHTMLDocument('spreadsheet search');
		const host = document.createElement('div');
		const navigated: unknown[] = [];
		const result: ParadisOfficeSearchResult = {
			id: 'result-1',
			locator: 'Archive!C9',
			preview: { before: 'before ', match: '<needle>', after: ' after' },
			locationBadge: { kind: 'sheet', label: 'Archive (Hidden Sheet)' },
			navigableAnchor: 'cell:Archive:C9',
		};
		const inspector = disposables.add(new ParadisSpreadsheetChangeInspector(host, {
			search: async query => query === 'needle' ? [result] : [],
			onNavigate: target => navigated.push(target),
		}));

		await inspector.search('needle');
		const button = host.querySelector<HTMLButtonElement>('[data-search-result-id="result-1"]');
		button?.click();
		ok(button?.textContent?.includes('Archive (Hidden Sheet)'));
		ok(button?.textContent?.includes('<needle>'));
		strictEqual(button?.querySelector('script,img'), null);
		deepStrictEqual(navigated, [{ kind: 'search', locator: 'Archive!C9', anchor: 'cell:Archive:C9' }]);
	});

	test('submits search when the Search button is clicked', async () => {
		const document = mainWindow.document.implementation.createHTMLDocument('spreadsheet search submit');
		const host = document.createElement('div');
		document.body.appendChild(host);
		const queries: string[] = [];
		disposables.add(new ParadisSpreadsheetChangeInspector(host, {
			search: async query => {
				queries.push(query);
				return [];
			},
		}));

		const input = host.querySelector<HTMLInputElement>('input[type="search"]');
		strictEqual(input === null, false);
		input!.value = 'needle';
		host.querySelector<HTMLButtonElement>('form button')?.click();
		await Promise.resolve();
		await Promise.resolve();

		deepStrictEqual(queries, ['needle']);
	});

	test('bounds change, placeholder, and search result windows in the DOM', async () => {
		const document = mainWindow.document.implementation.createHTMLDocument('spreadsheet inspector windows');
		const host = document.createElement('div');
		const results: ParadisOfficeSearchResult[] = Array.from({ length: 250 }, (_, index) => ({
			id: `result-${index}`,
			locator: `Data!A${index + 1}`,
			preview: { before: '', match: 'x', after: '' },
			locationBadge: { kind: 'sheet', label: 'Data' },
		}));
		const inspector = disposables.add(new ParadisSpreadsheetChangeInspector(host, { search: async () => results }));
		inspector.setComparison(Array.from({ length: 250 }, (_, index) => change(`change-${index}`, 'content', 'cell.rawValue', `Data!A${index + 1}`)), completeManifest, 'complete');
		inspector.setPlaceholders(Array.from({ length: 250 }, (_, index) => ({
			nodeId: `Data!object:placeholder-${index}`,
			feature: 'drawing',
			reason: 'unsupported' as const,
			title: `Placeholder ${index}`,
		})));
		await inspector.search('x');

		ok(host.querySelectorAll('[data-change-id]').length <= 100);
		ok(host.querySelectorAll('[data-placeholder-id]').length <= 100);
		ok(host.querySelectorAll('[data-search-result-id]').length <= 100);
		ok(host.textContent?.includes('250 changes'));
		ok(host.textContent?.includes('250 placeholders'));
	});

	test('announces print-model approximation warnings and keeps placeholders in the model contract', async () => {
		const document = mainWindow.document.implementation.createHTMLDocument('spreadsheet print');
		const host = document.createElement('div');
		const printModel: ParadisOfficePrintModel = {
			title: 'Quarterly Plan',
			pages: [{
				pageNumber: 1,
				widthPoints: 612,
				heightPoints: 792,
				blocks: [{ kind: 'placeholder', nodeId: 'chart-1', placeholder: { nodeId: 'chart-1', feature: 'chart3d', reason: 'unsupported', title: '3D Chart' } }],
				placeholders: [{ nodeId: 'chart-1', feature: 'chart3d', reason: 'unsupported', title: '3D Chart' }],
			}],
			approximationWarnings: [{ code: 'excel.pagination.approximate', message: 'Page breaks are approximate.' }],
		};
		const inspector = disposables.add(new ParadisSpreadsheetChangeInspector(host, { getPrintModel: async () => printModel }));

		await inspector.requestPrintModel();
		strictEqual(spreadsheetPrintWarning(printModel), 'Page breaks are approximate.');
		const alert = host.querySelector('[role="alert"]');
		ok(alert?.textContent?.includes('Page breaks are approximate.'));
		ok(alert?.textContent?.includes('1 placeholder'));
	});

	test('restores bounded zoom, category filters, and active sheet view state', () => {
		const restored = restoreParadisSpreadsheetViewState({
			zoom: 1.75,
			activeSheet: 'Archive',
			categories: ['formatting', 'object', 'formatting'],
			selectedChangeId: 'change-7',
		}, { zoom: 1, activeSheet: 'Data', categories: PARADIS_SPREADSHEET_CHANGE_CATEGORIES });

		deepStrictEqual(restored, {
			zoom: 1.75,
			activeSheet: 'Archive',
			categories: ['formatting', 'object'],
			selectedChangeId: 'change-7',
		});
		deepStrictEqual(restoreParadisSpreadsheetViewState({ zoom: 99, activeSheet: '', categories: ['bad'] }, restored), restored);
	});

	test('persists direct category filtering and selected-change navigation in view state', () => {
		const document = mainWindow.document.implementation.createHTMLDocument('spreadsheet inspector state');
		const host = document.createElement('div');
		const inspector = disposables.add(new ParadisSpreadsheetChangeInspector(host));
		inspector.setViewState({ zoom: 1.5, activeSheet: 'Data', categories: PARADIS_SPREADSHEET_CHANGE_CATEGORIES });
		inspector.setComparison([
			change('content-1', 'content', 'cell.rawValue', 'Data!A1'),
			change('format-1', 'formatting', 'cell.numberFormat', 'Data!B2'),
		], completeManifest, 'complete');

		host.querySelector<HTMLButtonElement>('[data-category="formatting"]')?.click();
		host.querySelector<HTMLButtonElement>('[data-change-id="content-1"]')?.click();

		deepStrictEqual(inspector.getViewState(), {
			zoom: 1.5,
			activeSheet: 'Data',
			categories: ['content', 'structure', 'annotation', 'revision', 'object', 'security'],
			selectedChangeId: 'content-1',
		});
	});

	test('cancellation restores the committed SourceDescriptor and view state without serializing handle IDs', () => {
		const original: ParadisOfficeSourceDescriptor = { kind: 'gitCommit', uri: 'git:/repo/book.xlsx?ref=HEAD', revisionHint: 'abc123', displayName: 'book.xlsx', side: 'original' };
		const modified: ParadisOfficeSourceDescriptor = { kind: 'workingTree', uri: 'file:///repo/book.xlsx', revisionHint: 'etag:2', displayName: 'book.xlsx', side: 'modified' };
		const restoration = new ParadisSpreadsheetInputRestoration({ source: original, viewState: { zoom: 1.25, activeSheet: 'Data', categories: ['content'] } });
		restoration.begin({ source: modified, viewState: { zoom: 2, activeSheet: 'Changed', categories: ['formatting'] } });
		const restored = restoration.cancel();

		deepStrictEqual(restored, { source: original, viewState: { zoom: 1.25, activeSheet: 'Data', categories: ['content'] } });
		strictEqual(restoration.serialize().includes('handle'), false);
		strictEqual(restoration.serialize().includes('abc123'), true);
	});

	test('fences overlapping opens and invalidates restoration after clearInput', () => {
		const opens = new ParadisSpreadsheetOpenGeneration();
		const older = opens.begin();
		const newer = opens.begin();

		strictEqual(opens.isCurrent(older), false, 'an older canceled open cannot restore over the newer input');
		strictEqual(opens.isCurrent(newer), true);
		opens.invalidate();
		strictEqual(opens.isCurrent(newer), false, 'clearInput invalidates in-flight opens');
	});

	test('resolves cell, object, and sheet anchor fallback without pixel geometry', () => {
		deepStrictEqual(resolveParadisSpreadsheetNavigation('Archive!C9'), {
			sheetName: 'Archive',
			cell: { address: 'C9', row: 9, column: 3 },
		});
		deepStrictEqual(resolveParadisSpreadsheetNavigation('object:Chart 1', 'sheet:Data'), { sheetName: 'Data', objectName: 'Chart 1' });
		deepStrictEqual(resolveParadisSpreadsheetNavigation('missing', 'cell:Archive:C9'), {
			sheetName: 'Archive',
			cell: { address: 'C9', row: 9, column: 3 },
		});
		strictEqual(JSON.stringify(resolveParadisSpreadsheetNavigation('Archive!C9')).includes('pixel'), false);
	});

	test('uses ARIA live semantics, high-contrast tokens, and distinct diagonal provenance labels', () => {
		const document = mainWindow.document.implementation.createHTMLDocument('spreadsheet accessibility');
		const host = document.createElement('div');
		const navigated: unknown[] = [];
		const inspector = disposables.add(new ParadisSpreadsheetChangeInspector(host, { onNavigate: target => navigated.push(target) }));
		const changes = [
			change('base', 'formatting', 'cell.diagonalBorder', 'Data!B2'),
			change('conditional', 'formatting', 'conditionalFormatting.diagonalBorder', 'Data'),
			change('drawing', 'object', 'object.lineGeometry', 'Data!object:Line 1'),
		];
		inspector.setComparison(changes, completeManifest, 'complete');

		strictEqual(host.querySelector('[role="region"]')?.getAttribute('aria-label'), 'Spreadsheet Change Inspector');
		strictEqual(host.querySelector('[aria-live="polite"]')?.getAttribute('aria-atomic'), 'true');
		ok(PARADIS_SPREADSHEET_HIGH_CONTRAST_TOKENS.border.includes('--vscode-contrastBorder'));
		ok(PARADIS_SPREADSHEET_HIGH_CONTRAST_TOKENS.focus.includes('--vscode-contrastActiveBorder'));
		deepStrictEqual(changes.map(spreadsheetChangeLabel), ['Base Diagonal Border', 'Conditional Formatting Diagonal', 'Drawing Line']);
		const drawingButton = host.querySelector<HTMLButtonElement>('[data-change-id="drawing"]');
		drawingButton?.click();
		deepStrictEqual(navigated, [{ kind: 'change', locator: 'Data!object:Line 1', anchor: 'anchor:drawing' }]);
		strictEqual(JSON.stringify(navigated).includes('diagonal'), false, 'navigation consumes only logical locator/anchor, never diagonal geometry');
	});

	test('keeps v1 UI and virtualization behind the per-open runtime snapshot', () => {
		const legacy: ParadisOfficeRuntimeConfiguration = {
			engine: 'legacy', kernelShadow: true, semanticSpreadsheet: false, virtualizedSpreadsheet: false,
			semanticWord: false, platformBackend: false, searchPrint: false,
		};
		const v1: ParadisOfficeRuntimeConfiguration = {
			engine: 'v1', kernelShadow: false, semanticSpreadsheet: true, virtualizedSpreadsheet: true,
			semanticWord: true, platformBackend: true, searchPrint: true,
		};

		strictEqual(isParadisSpreadsheetV1Enabled(legacy), false);
		strictEqual(isParadisSpreadsheetV1Enabled(v1), true);
		strictEqual(isParadisSpreadsheetV1Enabled({ ...v1, semanticSpreadsheet: false }), false);
	});

	test('adapts the existing workbook to bounded semantic-search and script-free print callbacks', () => {
		const workbook: IParadisWorkbookData = {
			sheets: [
				{
					name: 'Visible', rows: [{ excelRow: 1, height: 20, cells: [{ value: 'Other', style: {} }] }],
					columnCount: 1, columnWidths: [80], truncated: false, minCol: 1,
				},
				{
					name: 'Archive', rows: [{ excelRow: 9, height: 20, cells: [{ value: 'Cafe\u0301 <script>alert(1)</script>', style: {} }] }],
					columnCount: 1, columnWidths: [80], truncated: false, minCol: 3,
					shapes: [{
						type: 'line', flipV: false, flipH: false,
						from: { c: 2, co: 0, r: 8, ro: 0 }, to: { c: 3, co: 0, r: 9, ro: 0 },
						outlineWidth: 1, outlineColor: '#000000', dash: 'solid', name: 'Cross-out',
					}],
				},
			],
		};

		const results = searchLegacySpreadsheetWorkbook(workbook, 'CAFÉ');
		const printModel = createLegacySpreadsheetPrintModel(workbook, 'Book.xlsx');

		deepStrictEqual(results.map(result => [result.locator, result.locationBadge.label, result.preview.match]), [
			['Archive!C9', 'Archive', 'Café'],
		]);
		strictEqual(results[0].navigableAnchor, 'cell:Archive:C9');
		strictEqual(printModel.title, 'Book.xlsx');
		strictEqual(printModel.pages.length, 2);
		strictEqual(printModel.pages[1].placeholders[0].feature, 'drawing.line');
		ok(printModel.approximationWarnings.some(warning => warning.code === 'spreadsheet.legacyPrintProjection'));
		strictEqual(JSON.stringify(printModel).includes('<script>alert(1)</script>'), true, 'text remains data in the typed model rather than HTML');
	});

	test('adapts legacy cell and drawing-line changes without conflating diagonal provenance', () => {
		const sheet: IParadisDiffSheet = {
			name: 'Data',
			originalRows: [{ excelRow: 2, height: 20, cells: [{ value: '', style: {}, diffStatus: 'modified', diffDetails: [{ kind: 'diagonalBorder', original: 'none', modified: 'up' }] }] }],
			modifiedRows: [{ excelRow: 2, height: 20, cells: [{ value: '', style: {}, diffStatus: 'modified', diffDetails: [{ kind: 'diagonalBorder', original: 'none', modified: 'up' }] }] }],
			columnCount: 1,
			columnWidths: [80],
			originalMinCol: 2,
			modifiedMinCol: 2,
			originalShapes: [],
			modifiedShapes: [{
				type: 'line', flipV: false, flipH: false,
				from: { c: 1, co: 0, r: 1, ro: 0 }, to: { c: 2, co: 0, r: 2, ro: 0 },
				outlineWidth: 1, outlineColor: '#000000', dash: 'solid', name: 'Line 1',
			}],
		};

		const changes = adaptLegacySpreadsheetInspectorChanges([sheet]);

		deepStrictEqual(changes.map(item => [item.category, item.subject.kind, spreadsheetChangeLabel(item)]), [
			['formatting', 'cell.diagonalBorder', 'Base Diagonal Border'],
			['object', 'object.lineGeometry', 'Drawing Line'],
		]);
		deepStrictEqual(changes.map(item => item.subject.locator), ['Data!B2', 'Data!object:Line 1']);
	});

	test('adapts and deduplicates original and modified legacy cells, including deleted cells', () => {
		const sheet: IParadisDiffSheet = {
			name: 'Data',
			originalRows: [{
				excelRow: 2,
				height: 20,
				cells: [
					{ value: 'deleted', style: {}, diffStatus: 'removed', diffDetails: [{ kind: 'value', original: 'deleted', modified: undefined }] },
					{ value: 'before', style: {}, diffStatus: 'modified', diffDetails: [{ kind: 'value', original: 'before', modified: 'after' }] },
				],
			}],
			modifiedRows: [{
				excelRow: 2,
				height: 20,
				cells: [
					{ value: '', style: {} },
					{ value: 'after', style: {}, diffStatus: 'modified', diffDetails: [{ kind: 'value', original: 'before', modified: 'after' }] },
				],
			}],
			columnCount: 2,
			columnWidths: [80, 80],
			originalMinCol: 2,
			modifiedMinCol: 2,
			originalShapes: [],
			modifiedShapes: [],
		};

		const changes = adaptLegacySpreadsheetInspectorChanges([sheet]);

		deepStrictEqual(changes.map(item => [item.subject.locator, item.before, item.after]), [
			['Data!B2', { kind: 'scalar', valueType: 'text', value: 'deleted' }, { kind: 'none' }],
			['Data!C2', { kind: 'scalar', valueType: 'text', value: 'before' }, { kind: 'scalar', valueType: 'text', value: 'after' }],
		]);
	});

	test('caps degraded legacy change projection and reports an incomplete minimum count', () => {
		const semanticChanges = Array.from({ length: PARADIS_SPREADSHEET_LEGACY_CHANGE_LIMIT + 1 }, (_, index) => change(`semantic-${index}`, 'content', 'cell.rawValue', `Data!A${index + 1}`));
		const sheet: IParadisDiffSheet = {
			name: 'Data', originalRows: [], modifiedRows: [], columnCount: 0, columnWidths: [], originalShapes: [], modifiedShapes: [], semanticChanges,
		};

		const result = adaptLegacySpreadsheetInspectorChangeSet([sheet]);

		strictEqual(result.changes.length, PARADIS_SPREADSHEET_LEGACY_CHANGE_LIMIT);
		strictEqual(result.truncated, true);
		strictEqual(result.minimumChangeCount, PARADIS_SPREADSHEET_LEGACY_CHANGE_LIMIT + 1);
	});
});
