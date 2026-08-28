/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok, strictEqual } from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ParadisOfficeFingerprint, ParadisOfficeRenderableAsset } from '../../common/paradisOfficeProtocol.js';
import type { ParadisSemanticSheet, ParadisSpreadsheetAnnotations } from '../../common/spreadsheet/paradisSpreadsheetSemantic.js';
import type {
	ParadisSemanticSheetWithObjects,
	ParadisSpreadsheetChart,
	ParadisSpreadsheetDrawing,
	ParadisSpreadsheetImage,
	ParadisSpreadsheetObjects,
} from '../../common/spreadsheet/paradisSpreadsheetObjects.js';
import { resolveSpreadsheetLineEndpoints } from '../../electron-browser/paradisSpreadsheetDrawings.js';
import {
	renderSpreadsheetObjectOverlay,
	type ParadisSpreadsheetObjectRenderAsset,
} from '../../electron-browser/spreadsheet/paradisSpreadsheetObjectRenderer.js';

const EMU_PER_PIXEL = 9_525;

function fingerprint(seed: string, byteLength = 4): ParadisOfficeFingerprint {
	return { algorithm: 'sha256', value: seed.repeat(64).slice(0, 64), byteLength };
}

const source = Object.freeze({ partId: '/xl/drawings/drawing1.xml', fingerprint: fingerprint('a') });
const coordinateSpace = Object.freeze({
	columnLeft: (column: number) => column * 100,
	rowTop: (row: number) => row * 50,
});

function absoluteAnchor(x = 0, y = 0, cx = 100 * EMU_PER_PIXEL, cy = 80 * EMU_PER_PIXEL) {
	return { kind: 'absolute' as const, position: { x, y }, extent: { cx, cy } };
}

function emptyObjects(overrides: Partial<ParadisSpreadsheetObjects> = {}): ParadisSpreadsheetObjects {
	return Object.freeze({
		images: Object.freeze([]),
		drawings: Object.freeze([]),
		charts: Object.freeze([]),
		opaqueDrawings: Object.freeze([]),
		pivots: Object.freeze([]),
		security: Object.freeze({ sheetProtections: Object.freeze([]), unsafeParts: Object.freeze([]), externalReferences: Object.freeze([]) }),
		opaqueParts: Object.freeze([]),
		...overrides,
	});
}

function sheet(objects: ParadisSpreadsheetObjects, conditionalFormatting?: ParadisSemanticSheet['conditionalFormatting']): ParadisSemanticSheetWithObjects {
	return Object.freeze({
		name: 'Data',
		sheetId: '1',
		order: 0,
		state: 'visible',
		relationshipId: 'rSheet',
		partId: '/xl/worksheets/sheet1.xml',
		source,
		views: Object.freeze([]),
		rows: new Map(),
		columns: Object.freeze([]),
		merges: Object.freeze([]),
		cells: new Map(),
		conditionalFormatting,
		objects,
	});
}

function drawing(overrides: Partial<ParadisSpreadsheetDrawing> = {}): ParadisSpreadsheetDrawing {
	const base: ParadisSpreadsheetDrawing = {
		id: 'line:1',
		kind: 'line',
		source,
		anchor: absoluteAnchor(),
		presetGeometry: 'line',
		line: { width: 12_700, color: '123456' },
		lineGeometry: { kind: 'absolute', start: { x: 0, y: 0 }, extent: { cx: 100 * EMU_PER_PIXEL, cy: 80 * EMU_PER_PIXEL }, diagonal: 'down' },
	};
	return Object.freeze({ ...base, ...overrides });
}

function barChart(overrides: Partial<ParadisSpreadsheetChart> = {}): ParadisSpreadsheetChart {
	const base: ParadisSpreadsheetChart = {
		id: 'chart:1',
		kind: 'chart',
		name: 'Quarterly chart',
		title: '<img src=x onerror=alert(1)> Sales',
		source,
		chartSource: Object.freeze({ partId: '/xl/charts/chart1.xml', fingerprint: fingerprint('b') }),
		anchor: absoluteAnchor(2 * EMU_PER_PIXEL, 3 * EMU_PER_PIXEL, 120 * EMU_PER_PIXEL, 90 * EMU_PER_PIXEL),
		chartType: 'bar',
		series: Object.freeze([{ index: 0, order: 0, values: { cache: Object.freeze([{ index: 0, value: '2' }, { index: 1, value: '4' }]) } }]),
		evaluation: 'savedCacheOnly',
	};
	return Object.freeze({ ...base, ...overrides });
}

function render(value: ParadisSemanticSheetWithObjects, assets: ReadonlyMap<string, ParadisSpreadsheetObjectRenderAsset> = new Map()) {
	const document = mainWindow.document.implementation.createHTMLDocument('spreadsheet object renderer');
	return renderSpreadsheetObjectOverlay(value, { document, coordinateSpace, assets });
}

suite('paradisSpreadsheetObjectRenderer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('renders a saved-cache bar chart as bounded SVG primitives', () => {
		const chart = barChart();

		const overlay = render(sheet(emptyObjects({ charts: Object.freeze([chart]) })));
		const group = overlay.querySelector('.paradis-spreadsheet-chart');

		ok(group);
		strictEqual(group.getAttribute('transform'), null);
		strictEqual(group.querySelectorAll('.paradis-spreadsheet-chart-bar').length, 2);
		strictEqual(group.querySelector('text')?.textContent, '<img src=x onerror=alert(1)> Sales');
		strictEqual(group.querySelector('img,script,foreignObject'), null);
	});

	test('renders embedded images, rectangles, and drawing lines from typed nodes', () => {
		const imageFingerprint = fingerprint('c', 8);
		const image: ParadisSpreadsheetImage = Object.freeze({
			id: 'image:1',
			kind: 'image',
			name: 'Preview',
			source,
			anchor: absoluteAnchor(10 * EMU_PER_PIXEL, 20 * EMU_PER_PIXEL, 30 * EMU_PER_PIXEL, 40 * EMU_PER_PIXEL),
			transform: { rotation: 5_400_000, flipHorizontal: true },
			content: { contentType: 'image/png', fingerprint: imageFingerprint },
		});
		const rectangle = drawing({ id: 'shape:1', kind: 'shape', presetGeometry: 'rect', anchor: absoluteAnchor(50 * EMU_PER_PIXEL, 60 * EMU_PER_PIXEL, 70 * EMU_PER_PIXEL, 80 * EMU_PER_PIXEL), transform: { flipVertical: true }, lineGeometry: undefined });
		const line = drawing({ id: 'line:2' });
		const asset: ParadisOfficeRenderableAsset = Object.freeze({
			id: 'asset_image_1',
			kind: 'rasterImage',
			mime: 'image/png',
			byteLength: 8,
			fingerprint: imageFingerprint,
			altText: 'Sanitized preview',
		});

		const overlay = render(
			sheet(emptyObjects({ images: Object.freeze([image]), drawings: Object.freeze([rectangle, line]) })),
			new Map([[imageFingerprint.value, Object.freeze({ asset, href: 'blob:paradis-safe-image' })]]),
		);
		const imageNode = overlay.querySelector('image.paradis-spreadsheet-object-image');
		const rectangleNode = overlay.querySelector('rect.paradis-spreadsheet-drawing-rect');
		const lineNode = overlay.querySelector('line.paradis-spreadsheet-drawing-line');

		strictEqual(imageNode?.getAttribute('href'), 'blob:paradis-safe-image');
		deepStrictEqual([imageNode?.getAttribute('x'), imageNode?.getAttribute('y'), imageNode?.getAttribute('width'), imageNode?.getAttribute('height')], ['10', '20', '30', '40']);
		strictEqual(imageNode?.getAttribute('transform'), 'matrix(0 -1 -1 0 65 65)');
		deepStrictEqual([rectangleNode?.getAttribute('x'), rectangleNode?.getAttribute('y'), rectangleNode?.getAttribute('width'), rectangleNode?.getAttribute('height')], ['50', '60', '70', '80']);
		strictEqual(rectangleNode?.getAttribute('transform'), 'matrix(1 0 0 -1 0 200)');
		deepStrictEqual([lineNode?.getAttribute('x1'), lineNode?.getAttribute('y1'), lineNode?.getAttribute('x2'), lineNode?.getAttribute('y2')], ['0', '0', '100', '80']);
		strictEqual(lineNode?.getAttribute('transform'), null);
	});

	test('uses no-anchor placeholders for unrepresented external, opaque, and VML metadata', () => {
		const linkedFingerprint = fingerprint('d');
		const externalImage: ParadisSpreadsheetImage = Object.freeze({
			id: 'image:linked', kind: 'image', source, anchor: absoluteAnchor(),
			content: { targetScheme: 'https', targetFingerprint: linkedFingerprint, behavior: 'notFetched' as const },
		});
		const objects = emptyObjects({
			images: Object.freeze([externalImage]),
			opaqueParts: Object.freeze([{ contentType: 'application/vnd.example.future', fingerprint: fingerprint('e'), evaluation: 'notEvaluated' }]),
			security: Object.freeze({
				sheetProtections: Object.freeze([]),
				unsafeParts: Object.freeze([]),
				externalReferences: Object.freeze([
					{ relationshipType: 'https://schemas.example/image', targetScheme: 'https', targetFingerprint: linkedFingerprint, behavior: 'notFetched' as const },
					{ relationshipType: 'https://schemas.example/externalLink', targetScheme: 'https', targetFingerprint: fingerprint('f'), behavior: 'notFetched' as const },
				]),
			}),
		});
		const vmlSource = Object.freeze({ partId: '/xl/drawings/vmlDrawing1.vml', fingerprint: fingerprint('1') });
		const annotations: ParadisSpreadsheetAnnotations = Object.freeze({
			worksheetSource: source,
			contentTypesSource: source,
			rootRelationshipsSource: source,
			workbookSource: source,
			worksheetRelationshipsSource: source,
			workbookRelationshipsSource: source,
			vmlDrawingSource: vmlSource,
			validations: Object.freeze([]),
			legacyNotes: Object.freeze([]),
			threadedComments: Object.freeze([]),
			persons: Object.freeze([]),
			hyperlinks: Object.freeze([]),
			opaqueFragments: Object.freeze([{ name: { namespace: 'urn:schemas-microsoft-com:vml', local: 'futureShape' }, path: '/xml[1]/futureShape[1]', ordinal: 0, fingerprint: fingerprint('2'), source: vmlSource }]),
			cellOverlays: Object.freeze([]),
			rangeOverlays: Object.freeze([]),
		});
		const value = Object.freeze({ ...sheet(objects), annotations });

		const overlay = render(value);

		deepStrictEqual(Array.from(overlay.querySelectorAll('.paradis-spreadsheet-object-placeholder'), node => [node.getAttribute('data-feature'), node.getAttribute('data-coverage')]), [
			['externalImage', 'blockedByPolicy'],
			['externalReference', 'noAnchor'],
			['opaquePart', 'noAnchor'],
			['vmlOpaque', 'noAnchor'],
		]);
	});

	test('places ambiguous or non-finite chart caches behind a placeholder', () => {
		const invalidCharts = Object.freeze([
			barChart({
				id: 'chart:multiple', series: Object.freeze([
					{ index: 0, order: 0, values: { cache: Object.freeze([{ index: 0, value: '2' }]) } },
					{ index: 1, order: 1, values: { cache: Object.freeze([{ index: 0, value: '3' }]) } },
				])
			}),
			barChart({ id: 'chart:blank', series: Object.freeze([{ index: 0, order: 0, values: { cache: Object.freeze([{ index: 0, value: '' }]) } }]) }),
			barChart({ id: 'chart:sparse', series: Object.freeze([{ index: 0, order: 0, values: { cache: Object.freeze([{ index: 1, value: '2' }]) } }]) }),
			barChart({ id: 'chart:overflow', series: Object.freeze([{ index: 0, order: 0, values: { cache: Object.freeze([{ index: 0, value: String(Number.MAX_VALUE) }, { index: 1, value: String(-Number.MAX_VALUE) }]) } }]) }),
		]);

		const overlay = render(sheet(emptyObjects({ charts: invalidCharts })));

		strictEqual(overlay.querySelector('.paradis-spreadsheet-chart'), null);
		strictEqual(overlay.querySelectorAll('[data-feature="unsupportedChart"]').length, 4);
		strictEqual(overlay.outerHTML.includes('NaN'), false);
		strictEqual(overlay.outerHTML.includes('Infinity'), false);
	});

	test('uses anchored placeholders for opaque, unsupported, external, and unsafe objects', () => {
		const externalImage: ParadisSpreadsheetImage = Object.freeze({
			id: 'image:external', kind: 'image', source, anchor: absoluteAnchor(10 * EMU_PER_PIXEL, 11 * EMU_PER_PIXEL, 20 * EMU_PER_PIXEL, 21 * EMU_PER_PIXEL),
			content: { targetScheme: 'https', targetFingerprint: fingerprint('d'), behavior: 'notFetched' as const },
		});
		const unsupportedShape = drawing({ id: 'shape:unsupported', kind: 'shape', presetGeometry: 'cloud', lineGeometry: undefined, anchor: absoluteAnchor(30 * EMU_PER_PIXEL, 31 * EMU_PER_PIXEL) });
		const opaque = Object.freeze({ id: 'opaque:1', kind: 'opaqueDrawing' as const, source, anchor: absoluteAnchor(50 * EMU_PER_PIXEL, 51 * EMU_PER_PIXEL), fingerprint: fingerprint('e'), evaluation: 'notEvaluated' as const });
		const unsafeOle = Object.freeze({ id: 'ole:1', kind: 'ole', source, anchor: absoluteAnchor(70 * EMU_PER_PIXEL, 71 * EMU_PER_PIXEL) }) as unknown as ParadisSpreadsheetDrawing;
		const objects = emptyObjects({
			images: Object.freeze([externalImage]),
			drawings: Object.freeze([unsupportedShape, unsafeOle]),
			opaqueDrawings: Object.freeze([opaque]),
			security: Object.freeze({
				sheetProtections: Object.freeze([]),
				unsafeParts: Object.freeze([{ kind: 'ole' as const, contentType: 'application/vnd.ms-office.oleObject', fingerprint: fingerprint('f'), behavior: 'notExecuted' as const }]),
				externalReferences: Object.freeze([]),
			}),
		});

		const overlay = render(sheet(objects));
		const placeholders = Array.from(overlay.querySelectorAll('.paradis-spreadsheet-object-placeholder'));

		deepStrictEqual(placeholders.map(node => [node.getAttribute('data-feature'), node.getAttribute('data-coverage')]), [
			['externalImage', 'blockedByPolicy'],
			['unsupportedShape', 'placeholder'],
			['unsafeObject', 'blockedByPolicy'],
			['opaqueDrawing', 'placeholder'],
			['ole', 'noAnchor'],
		]);
		deepStrictEqual(placeholders.slice(0, 4).map(node => [node.querySelector('rect')?.getAttribute('x'), node.querySelector('rect')?.getAttribute('y')]), [
			['10', '11'], ['30', '31'], ['70', '71'], ['50', '51'],
		]);
		strictEqual(overlay.querySelector('image'), null);
	});

	test('denies raw XML, raw SVG, and non-platform image URLs at the renderer boundary', () => {
		const rawXml = Object.freeze({ ...drawing(), xml: '<xdr:wsDr><script/></xdr:wsDr>' }) as unknown as ParadisSpreadsheetDrawing;
		const rawSvg = Object.freeze({ ...drawing({ id: 'line:svg' }), rawSvg: '<svg><script>alert(1)</script></svg>' }) as unknown as ParadisSpreadsheetDrawing;
		const imageFingerprint = fingerprint('1', 16);
		const image: ParadisSpreadsheetImage = Object.freeze({ id: 'image:raw-svg', kind: 'image', source, anchor: absoluteAnchor(), content: { contentType: 'image/svg+xml', fingerprint: imageFingerprint } });
		const asset: ParadisOfficeRenderableAsset = Object.freeze({ id: 'asset_svg', kind: 'sanitizedSvg', mime: 'image/svg+xml', byteLength: 16, fingerprint: imageFingerprint });
		const objects = emptyObjects({ drawings: Object.freeze([rawXml, rawSvg]), images: Object.freeze([image]) });

		const overlay = render(sheet(objects), new Map([[
			imageFingerprint.value,
			Object.freeze({ asset, href: 'data:image/svg+xml,<svg><script>alert(1)</script></svg>' }),
		]]));

		strictEqual(overlay.querySelector('script,foreignObject,use,image'), null);
		deepStrictEqual(Array.from(overlay.querySelectorAll('.paradis-spreadsheet-object-placeholder'), node => node.getAttribute('data-feature')).sort(), ['rawMarkup', 'rawMarkup', 'unsafeAsset']);
	});

	test('resolves signed markers and applies extent, absolute position, flips, and rotation exactly once', () => {
		const signed = drawing({
			anchor: { kind: 'twoCell', from: { column: 0, columnOffset: -EMU_PER_PIXEL, row: 0, rowOffset: 2 * EMU_PER_PIXEL }, to: { column: 1, columnOffset: 2 * EMU_PER_PIXEL, row: 1, rowOffset: -3 * EMU_PER_PIXEL } },
			lineGeometry: { kind: 'cellAnchored', start: { column: 0, columnOffset: -EMU_PER_PIXEL, row: 0, rowOffset: 2 * EMU_PER_PIXEL }, end: { column: 1, columnOffset: 2 * EMU_PER_PIXEL, row: 1, rowOffset: -3 * EMU_PER_PIXEL }, diagonal: 'down' },
		});
		const transformed = drawing({
			anchor: { kind: 'oneCell', from: { column: 0, columnOffset: 0, row: 0, rowOffset: 0 }, extent: { cx: 20 * EMU_PER_PIXEL, cy: 10 * EMU_PER_PIXEL } },
			lineGeometry: { kind: 'cellAnchoredExtent', start: { column: 0, columnOffset: 0, row: 0, rowOffset: 0 }, extent: { cx: 20 * EMU_PER_PIXEL, cy: 10 * EMU_PER_PIXEL }, diagonal: 'up' },
			transform: { offset: { x: 10 * EMU_PER_PIXEL, y: 20 * EMU_PER_PIXEL }, extent: { cx: 40 * EMU_PER_PIXEL, cy: 20 * EMU_PER_PIXEL }, rotation: 5_400_000, flipHorizontal: true },
		});
		const absolute = drawing({
			anchor: absoluteAnchor(-10 * EMU_PER_PIXEL, 5 * EMU_PER_PIXEL, 30 * EMU_PER_PIXEL, 15 * EMU_PER_PIXEL),
			lineGeometry: { kind: 'absolute', start: { x: -10 * EMU_PER_PIXEL, y: 5 * EMU_PER_PIXEL }, extent: { cx: 30 * EMU_PER_PIXEL, cy: 15 * EMU_PER_PIXEL }, diagonal: 'down' },
			transform: { rotation: 10_800_000 },
		});

		deepStrictEqual(resolveSpreadsheetLineEndpoints(signed, coordinateSpace), { start: { x: -1, y: 2 }, end: { x: 102, y: 47 } });
		deepStrictEqual(resolveSpreadsheetLineEndpoints(transformed, coordinateSpace), { start: { x: 40, y: 50 }, end: { x: 20, y: 10 } });
		deepStrictEqual(resolveSpreadsheetLineEndpoints(absolute, coordinateSpace), { start: { x: 20, y: 20 }, end: { x: -10, y: 5 } });
	});

	test('keeps drawing lines separate from base cell diagonal style provenance', () => {
		const diagonal = Object.freeze({ diagonalUp: true, diagonalDown: false, diagonal: Object.freeze({ style: 'thin', color: Object.freeze({ kind: 'rgb' as const, rgb: 'FF112233' }) }) });
		const cell = Object.freeze({ storedType: 'blank' as const, styleRef: 7, effectiveStyleRef: 9, effectiveStyleOrigin: 'cell' as const });
		const cells = new Map([['A1', cell]]);
		const value = sheet(emptyObjects({ drawings: Object.freeze([drawing()]) }), Object.freeze({ baseDiagonal: diagonal }) as never);
		const withCell = Object.freeze({ ...value, cells });

		const overlay = render(withCell);

		strictEqual(overlay.querySelectorAll('.paradis-spreadsheet-drawing-line').length, 1);
		strictEqual(overlay.querySelector('.paradis-spreadsheet-diagonal'), null);
		strictEqual(withCell.cells, cells);
		strictEqual(withCell.cells.get('A1'), cell);
		strictEqual(withCell.conditionalFormatting, value.conditionalFormatting);
		strictEqual((withCell.conditionalFormatting as unknown as { baseDiagonal: unknown }).baseDiagonal, diagonal);
	});
});
