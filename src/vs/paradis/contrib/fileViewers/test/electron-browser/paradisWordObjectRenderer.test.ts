/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, strictEqual } from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ParadisOfficeFingerprint, ParadisOfficeRenderableAsset } from '../../common/paradisOfficeProtocol.js';
import type { ParadisWordDrawingGeometry } from '../../common/word/paradisWordSemantic.js';
import {
	renderWordObjectOverlay,
	type ParadisWordObjectRenderAsset,
	type ParadisWordRenderableObject,
} from '../../electron-browser/word/paradisWordObjectRenderer.js';

const EMU_PER_PIXEL = 9_525;

function fingerprint(seed: string, byteLength = 4): ParadisOfficeFingerprint {
	return { algorithm: 'sha256', value: seed.repeat(64).slice(0, 64), byteLength };
}

function geometry(overrides: Partial<ParadisWordDrawingGeometry> = {}): ParadisWordDrawingGeometry {
	return Object.freeze({
		placement: 'anchor',
		distances: Object.freeze({}),
		horizontalPosition: Object.freeze({ offset: String(10 * EMU_PER_PIXEL) }),
		verticalPosition: Object.freeze({ offset: String(20 * EMU_PER_PIXEL) }),
		extent: Object.freeze({ cx: String(120 * EMU_PER_PIXEL), cy: String(80 * EMU_PER_PIXEL) }),
		sourcePartFingerprint: fingerprint('a'),
		...overrides,
	});
}

function render(objects: readonly ParadisWordRenderableObject[], assets: ReadonlyMap<string, ParadisWordObjectRenderAsset> = new Map()) {
	const document = mainWindow.document.implementation.createHTMLDocument('word object renderer');
	return renderWordObjectOverlay(objects, { document, assets });
}

suite('paradisWordObjectRenderer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('renders textbox, shape, WordArt, and supported preset geometry with text-only DOM', () => {
		const objects: readonly ParadisWordRenderableObject[] = Object.freeze([
			Object.freeze({ id: 'textbox', kind: 'textbox', geometry: geometry({ presetGeometry: 'rect' }), runs: Object.freeze([{ text: '<script>text</script>' }]) }),
			Object.freeze({ id: 'ellipse', kind: 'shape', geometry: geometry({ presetGeometry: 'ellipse' }) }),
			Object.freeze({ id: 'triangle', kind: 'shape', geometry: geometry({ presetGeometry: 'triangle' }) }),
			Object.freeze({ id: 'wordart', kind: 'wordArt', geometry: geometry({ presetGeometry: 'rect' }), text: '<img src=x onerror=alert(1)>' }),
		]);

		const result = render(objects);

		strictEqual(result.element.querySelectorAll('.paradis-word-object-textbox').length, 1);
		strictEqual(result.element.querySelectorAll('ellipse.paradis-word-object-shape').length, 1);
		strictEqual(result.element.querySelectorAll('polygon.paradis-word-object-shape').length, 1);
		strictEqual(result.element.querySelector('.paradis-word-object-textbox text')?.textContent, '<script>text</script>');
		strictEqual(result.element.querySelector('.paradis-word-object-wordart')?.textContent, '<img src=x onerror=alert(1)>');
		strictEqual(result.element.querySelector('script,img,foreignObject,use'), null);
		deepStrictEqual(result.outcomes.map(outcome => [outcome.nodeId, outcome.coverage]), [
			['textbox', 'rendered'], ['ellipse', 'rendered'], ['triangle', 'rendered'], ['wordart', 'approximated'],
		]);
	});

	test('applies anchor, xfrm extent, line flip, rotation, and polygon coordinates exactly once', () => {
		const lineGeometry = geometry({
			presetGeometry: 'line',
			transform: Object.freeze({
				rotation: '5400000',
				flipHorizontal: '1',
				offset: Object.freeze({ x: String(30 * EMU_PER_PIXEL), y: String(40 * EMU_PER_PIXEL) }),
				extent: Object.freeze({ cx: String(40 * EMU_PER_PIXEL), cy: String(20 * EMU_PER_PIXEL) }),
			}),
		});
		const triangleGeometry = geometry({
			presetGeometry: 'triangle',
			transform: Object.freeze({ flipVertical: 'true' }),
		});

		const result = render(Object.freeze([
			Object.freeze({ id: 'line', kind: 'shape', geometry: lineGeometry }),
			Object.freeze({ id: 'polygon', kind: 'shape', geometry: triangleGeometry }),
		]));
		const line = result.element.querySelector('line.paradis-word-object-shape');
		const polygon = result.element.querySelector('polygon.paradis-word-object-shape');

		deepStrictEqual([line?.getAttribute('x1'), line?.getAttribute('y1'), line?.getAttribute('x2'), line?.getAttribute('y2')], ['10', '20', '50', '40']);
		strictEqual(line?.getAttribute('transform'), 'matrix(0 -1 -1 0 60 60)');
		strictEqual(polygon?.getAttribute('points'), '70,20 130,100 10,100');
		strictEqual(polygon?.getAttribute('transform'), 'matrix(1 0 0 -1 0 120)');
		deepStrictEqual(lineGeometry.extent, { cx: String(120 * EMU_PER_PIXEL), cy: String(80 * EMU_PER_PIXEL) });
		deepStrictEqual(lineGeometry.transform?.offset, { x: String(30 * EMU_PER_PIXEL), y: String(40 * EMU_PER_PIXEL) });
		deepStrictEqual(lineGeometry.transform?.extent, { cx: String(40 * EMU_PER_PIXEL), cy: String(20 * EMU_PER_PIXEL) });
	});

	test('renders finite chart cache values and approximates flow and hierarchy SmartArt', () => {
		const objects: readonly ParadisWordRenderableObject[] = Object.freeze([
			Object.freeze({
				id: 'chart', kind: 'chart', geometry: geometry(), chartType: 'bar', title: '<b>Revenue</b>',
				series: Object.freeze([{ name: 'FY', values: Object.freeze([{ index: 0, value: '-2' }, { index: 1, value: '4' }]) }]),
			}),
			Object.freeze({
				id: 'flow', kind: 'smartArt', geometry: geometry(), layout: 'flow',
				nodes: Object.freeze([{ id: 'a', label: 'Start' }, { id: 'b', label: '<script>Finish</script>' }]),
			}),
			Object.freeze({
				id: 'hierarchy', kind: 'smartArt', geometry: geometry(), layout: 'hierarchy',
				nodes: Object.freeze([{ id: 'root', label: 'Root' }, { id: 'child', label: 'Child', parentId: 'root' }]),
			}),
		]);

		const result = render(objects);

		strictEqual(result.element.querySelectorAll('.paradis-word-chart-bar').length, 2);
		strictEqual(result.element.querySelector('.paradis-word-chart text')?.textContent, '<b>Revenue</b>');
		strictEqual(result.element.querySelectorAll('[data-smartart-layout="flow"] rect').length, 2);
		strictEqual(result.element.querySelectorAll('[data-smartart-layout="hierarchy"] rect').length, 2);
		strictEqual(result.element.querySelector('[data-smartart-layout="flow"] text:last-of-type')?.textContent, '<script>Finish</script>');
		strictEqual(result.element.querySelector('script,foreignObject'), null);
		deepStrictEqual(result.outcomes.map(outcome => outcome.coverage), ['rendered', 'approximated', 'approximated']);
	});

	test('uses explicit placeholders for unsupported geometry and types without rendering table diagonals', () => {
		const objects = Object.freeze([
			Object.freeze({ id: 'cloud', kind: 'shape', geometry: geometry({ presetGeometry: 'cloud' }) }),
			Object.freeze({ id: 'future', kind: 'futureObject', geometry: geometry() }) as unknown as ParadisWordRenderableObject,
			Object.freeze({ id: 'table-diagonal', kind: 'tableDiagonal', geometry: geometry({ presetGeometry: 'line' }) }) as unknown as ParadisWordRenderableObject,
		]);

		const result = render(objects);

		strictEqual(result.element.querySelector('.paradis-word-object-shape'), null);
		deepStrictEqual(Array.from(result.element.querySelectorAll('.paradis-word-object-placeholder'), node => [node.getAttribute('data-feature'), node.getAttribute('data-coverage')]), [
			['unsupportedGeometry', 'placeholder'], ['unsupportedObject', 'placeholder'], ['unsupportedObject', 'placeholder'],
		]);
		deepStrictEqual(result.outcomes.map(outcome => outcome.coverage), ['placeholder', 'placeholder', 'placeholder']);
	});

	test('renders only a matching Platform OLE preview and blocks the executable object otherwise', () => {
		const previewFingerprint = fingerprint('b', 8);
		const previewAsset: ParadisOfficeRenderableAsset = Object.freeze({
			id: 'ole-preview', kind: 'placeholderPreview', mime: 'image/png', byteLength: 8, fingerprint: previewFingerprint,
		});
		const objects: readonly ParadisWordRenderableObject[] = Object.freeze([
			Object.freeze({ id: 'ole-with-preview', kind: 'ole', geometry: geometry(), preview: Object.freeze({ id: 'ole-preview', contentType: 'image/png', fingerprint: previewFingerprint }) }),
			Object.freeze({ id: 'ole-without-preview', kind: 'ole', geometry: geometry() }),
		]);

		const result = render(objects, new Map([['ole-preview', Object.freeze({ asset: previewAsset, href: 'blob:paradis-ole-preview' })]]));

		strictEqual(result.element.querySelector('image.paradis-word-object-preview')?.getAttribute('href'), 'blob:paradis-ole-preview');
		deepStrictEqual(result.outcomes.map(outcome => outcome.coverage), ['approximated', 'blockedByPolicy']);
		strictEqual(result.element.querySelector('[data-feature="ole"]')?.getAttribute('data-coverage'), 'blockedByPolicy');
	});

	test('blocks external images, unsafe SVG URLs, raw markup, and binary-bearing objects', () => {
		const svgFingerprint = fingerprint('c', 16);
		const sanitizedSvg: ParadisOfficeRenderableAsset = Object.freeze({
			id: 'sanitized-svg', kind: 'sanitizedSvg', mime: 'image/svg+xml', byteLength: 16, fingerprint: svgFingerprint,
		});
		const objects = Object.freeze([
			Object.freeze({ id: 'external', kind: 'image', geometry: geometry(), content: Object.freeze({ behavior: 'notFetched' }) }),
			Object.freeze({ id: 'unsafe-svg-url', kind: 'image', geometry: geometry(), content: Object.freeze({ assetId: 'sanitized-svg', contentType: 'image/svg+xml', fingerprint: svgFingerprint }) }),
			Object.freeze({ id: 'raw-svg', kind: 'shape', geometry: geometry({ presetGeometry: 'rect' }), rawSvg: '<svg><script/></svg>' }) as unknown as ParadisWordRenderableObject,
			Object.freeze({ id: 'binary', kind: 'shape', geometry: geometry({ presetGeometry: 'rect' }), bytes: new Uint8Array([1]) }) as unknown as ParadisWordRenderableObject,
		]) as readonly ParadisWordRenderableObject[];

		const result = render(objects, new Map([['sanitized-svg', Object.freeze({ asset: sanitizedSvg, href: 'data:image/svg+xml,<svg><script/></svg>' })]]));

		strictEqual(result.element.querySelector('image,script,foreignObject,use'), null);
		deepStrictEqual(Array.from(result.element.querySelectorAll('.paradis-word-object-placeholder'), node => [node.getAttribute('data-feature'), node.getAttribute('data-coverage')]), [
			['externalImage', 'blockedByPolicy'], ['unsafeAsset', 'blockedByPolicy'], ['unsafePayload', 'blockedByPolicy'], ['unsafePayload', 'blockedByPolicy'],
		]);
		deepStrictEqual(result.outcomes.map(outcome => outcome.coverage), ['blockedByPolicy', 'blockedByPolicy', 'blockedByPolicy', 'blockedByPolicy']);
	});

	test('reports noAnchor when a supported object has no valid placement extent', () => {
		const result = render(Object.freeze([
			Object.freeze({ id: 'unanchored', kind: 'shape', geometry: geometry({ extent: undefined, transform: undefined, presetGeometry: 'rect' }) }),
		]));

		strictEqual(result.element.querySelector('.paradis-word-object-shape'), null);
		strictEqual(result.element.querySelector('.paradis-word-object-placeholder')?.getAttribute('data-coverage'), 'noAnchor');
		deepStrictEqual(result.outcomes, [{ nodeId: 'unanchored', coverage: 'noAnchor', feature: 'shape' }]);
	});

	test('uses simple position only when the anchor selects it and does not guess aligned positions', () => {
		const simplePosition = Object.freeze({ x: String(30 * EMU_PER_PIXEL), y: String(40 * EMU_PER_PIXEL) });
		const result = render(Object.freeze([
			Object.freeze({
				id: 'aligned', kind: 'shape', geometry: geometry({
					presetGeometry: 'rect', simplePosition,
					horizontalPosition: Object.freeze({ relativeFrom: 'page', align: 'center' }),
					verticalPosition: Object.freeze({ relativeFrom: 'page', offset: String(20 * EMU_PER_PIXEL) }),
					anchorProperties: Object.freeze({ simplePosition: '0' }),
				}),
			}),
			Object.freeze({
				id: 'simple', kind: 'shape', geometry: geometry({
					presetGeometry: 'rect', simplePosition,
					horizontalPosition: undefined, verticalPosition: undefined,
					anchorProperties: Object.freeze({ simplePosition: '1' }),
				}),
			}),
		]));

		deepStrictEqual(result.outcomes.map(value => [value.nodeId, value.coverage]), [['aligned', 'noAnchor'], ['simple', 'rendered']]);
		const shape = result.element.querySelector('.paradis-word-object-shape');
		deepStrictEqual([shape?.getAttribute('x'), shape?.getAttribute('y')], ['30', '40']);
	});
});
