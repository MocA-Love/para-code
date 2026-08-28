/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { isOfficeRenderableAsset, type ParadisOfficeRenderableAsset } from '../../common/paradisOfficeProtocol.js';
import type {
	ParadisSemanticSheetWithObjects,
	ParadisSpreadsheetChart,
	ParadisSpreadsheetDrawing,
	ParadisSpreadsheetDrawingAnchor,
	ParadisSpreadsheetExternalImageContent,
	ParadisSpreadsheetImage,
} from '../../common/spreadsheet/paradisSpreadsheetObjects.js';
import {
	resolveSpreadsheetDrawingBounds,
	resolveSpreadsheetDrawingTransformMatrix,
	resolveSpreadsheetLineEndpoints,
	type ParadisSpreadsheetDrawingBounds,
	type ParadisSpreadsheetDrawingCoordinateSpace,
} from '../paradisSpreadsheetDrawings.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const RAW_MARKUP_PROPERTIES = new Set(['html', 'innerHTML', 'markup', 'outerHTML', 'rawHtml', 'rawSvg', 'rawXml', 'svg', 'xml']);
const STRICT_CHART_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

export interface ParadisSpreadsheetObjectRenderAsset {
	readonly asset: ParadisOfficeRenderableAsset;
	/** Object URL created from bytes returned by the Platform renderable-asset channel. */
	readonly href: string;
}

export interface ParadisSpreadsheetObjectRenderOptions {
	readonly document: Document;
	readonly coordinateSpace: ParadisSpreadsheetDrawingCoordinateSpace;
	readonly assets: ReadonlyMap<string, ParadisSpreadsheetObjectRenderAsset>;
}

type PlaceholderCoverage = 'blockedByPolicy' | 'noAnchor' | 'placeholder';

function svgElement<K extends keyof SVGElementTagNameMap>(document: Document, name: K): SVGElementTagNameMap[K] {
	return document.createElementNS(SVG_NAMESPACE, name);
}

function ownDataValue(value: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor && descriptor.get === undefined && descriptor.set === undefined ? descriptor.value : undefined;
}

function hasRawMarkupProperty(value: object): boolean {
	return Reflect.ownKeys(value).some(key => typeof key === 'string' && RAW_MARKUP_PROPERTIES.has(key));
}

function isSafeInteger(value: unknown, allowNegative = false): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && (allowNegative || value >= 0);
}

function isDrawingMarker(value: unknown): boolean {
	if (!value || typeof value !== 'object') {
		return false;
	}
	return isSafeInteger(ownDataValue(value, 'column'))
		&& isSafeInteger(ownDataValue(value, 'row'))
		&& isSafeInteger(ownDataValue(value, 'columnOffset'), true)
		&& isSafeInteger(ownDataValue(value, 'rowOffset'), true);
}

function isDrawingPosition(value: unknown): boolean {
	return value !== null && typeof value === 'object'
		&& isSafeInteger(ownDataValue(value, 'x'), true)
		&& isSafeInteger(ownDataValue(value, 'y'), true);
}

function isDrawingExtent(value: unknown): boolean {
	return value !== null && typeof value === 'object'
		&& isSafeInteger(ownDataValue(value, 'cx'))
		&& isSafeInteger(ownDataValue(value, 'cy'));
}

function isDrawingAnchor(value: unknown): value is ParadisSpreadsheetDrawingAnchor {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const kind = ownDataValue(value, 'kind');
	if (kind === 'twoCell') {
		return isDrawingMarker(ownDataValue(value, 'from')) && isDrawingMarker(ownDataValue(value, 'to'));
	}
	if (kind === 'oneCell') {
		return isDrawingMarker(ownDataValue(value, 'from')) && isDrawingExtent(ownDataValue(value, 'extent'));
	}
	return kind === 'absolute' && isDrawingPosition(ownDataValue(value, 'position')) && isDrawingExtent(ownDataValue(value, 'extent'));
}

function objectAnchor(value: object): ParadisSpreadsheetDrawingAnchor | undefined {
	const anchor = ownDataValue(value, 'anchor');
	return isDrawingAnchor(anchor) ? anchor : undefined;
}

function placeholderBounds(value: object, options: ParadisSpreadsheetObjectRenderOptions): ParadisSpreadsheetDrawingBounds | undefined {
	const anchor = objectAnchor(value);
	return anchor ? resolveSpreadsheetDrawingBounds(anchor, options.coordinateSpace) : undefined;
}

function appendPlaceholder(
	root: SVGSVGElement,
	feature: string,
	coverage: PlaceholderCoverage,
	bounds: ParadisSpreadsheetDrawingBounds | undefined,
	ordinal = 0,
): void {
	const group = svgElement(root.ownerDocument, 'g');
	group.setAttribute('class', 'paradis-spreadsheet-object-placeholder');
	group.setAttribute('data-feature', feature);
	group.setAttribute('data-coverage', coverage);
	const rectangle = svgElement(root.ownerDocument, 'rect');
	const fallback = { x: 0, y: ordinal * 18, width: 120, height: 16 };
	const resolved = bounds ?? fallback;
	rectangle.setAttribute('x', numberAttribute(resolved.x));
	rectangle.setAttribute('y', numberAttribute(resolved.y));
	rectangle.setAttribute('width', numberAttribute(Math.max(1, resolved.width)));
	rectangle.setAttribute('height', numberAttribute(Math.max(1, resolved.height)));
	rectangle.setAttribute('fill', 'none');
	rectangle.setAttribute('stroke', 'currentColor');
	rectangle.setAttribute('stroke-dasharray', '4,3');
	group.appendChild(rectangle);
	root.appendChild(group);
}

function numberAttribute(value: number): string {
	const rounded = Math.round(value * 1_000_000_000) / 1_000_000_000;
	return String(Object.is(rounded, -0) ? 0 : rounded);
}

function applyPrimitiveTransform(element: SVGGraphicsElement, bounds: ParadisSpreadsheetDrawingBounds, transform: ParadisSpreadsheetImage['transform']): void {
	const matrix = resolveSpreadsheetDrawingTransformMatrix(bounds, transform);
	if (matrix) {
		element.setAttribute('transform', `matrix(${numberAttribute(matrix.a)} ${numberAttribute(matrix.b)} ${numberAttribute(matrix.c)} ${numberAttribute(matrix.d)} ${numberAttribute(matrix.e)} ${numberAttribute(matrix.f)})`);
	}
}

function safeLineColor(value: string | undefined): string {
	return value && /^[a-f\d]{6}$/i.test(value) ? `#${value}` : '#000000';
}

function safeLineWidth(value: number | undefined): number {
	return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? Math.min(32, Math.max(0.5, value / 9_525)) : 1;
}

function isExternalImageContent(content: ParadisSpreadsheetImage['content']): content is ParadisSpreadsheetExternalImageContent {
	return ownDataValue(content, 'behavior') === 'notFetched';
}

function safeAssetHref(image: ParadisSpreadsheetImage, assets: ReadonlyMap<string, ParadisSpreadsheetObjectRenderAsset>): string | undefined {
	if (isExternalImageContent(image.content)) {
		return undefined;
	}
	const candidate = assets.get(image.content.fingerprint.value);
	if (!candidate || !isOfficeRenderableAsset(candidate.asset) || !/^blob:[^\s]+$/.test(candidate.href)) {
		return undefined;
	}
	if (candidate.asset.fingerprint.value !== image.content.fingerprint.value
		|| candidate.asset.fingerprint.byteLength !== image.content.fingerprint.byteLength) {
		return undefined;
	}
	const contentType = image.content.contentType.toLocaleLowerCase('en-US');
	if (candidate.asset.kind === 'rasterImage') {
		return candidate.asset.mime === contentType ? candidate.href : undefined;
	}
	if (candidate.asset.kind === 'sanitizedSvg') {
		return contentType === 'image/svg+xml' ? candidate.href : undefined;
	}
	return candidate.asset.kind === 'placeholderPreview' ? candidate.href : undefined;
}

function appendImage(root: SVGSVGElement, image: ParadisSpreadsheetImage, options: ParadisSpreadsheetObjectRenderOptions): void {
	const bounds = resolveSpreadsheetDrawingBounds(image.anchor, options.coordinateSpace, image.transform);
	if (isExternalImageContent(image.content)) {
		appendPlaceholder(root, 'externalImage', 'blockedByPolicy', bounds);
		return;
	}
	const href = safeAssetHref(image, options.assets);
	if (!href || !bounds) {
		appendPlaceholder(root, 'unsafeAsset', 'blockedByPolicy', bounds);
		return;
	}
	const element = svgElement(root.ownerDocument, 'image');
	element.setAttribute('class', 'paradis-spreadsheet-object-image');
	element.setAttribute('x', numberAttribute(bounds.x));
	element.setAttribute('y', numberAttribute(bounds.y));
	element.setAttribute('width', numberAttribute(bounds.width));
	element.setAttribute('height', numberAttribute(bounds.height));
	element.setAttribute('preserveAspectRatio', 'none');
	element.setAttribute('href', href);
	applyPrimitiveTransform(element, bounds, image.transform);
	root.appendChild(element);
}

function appendDrawing(root: SVGSVGElement, drawing: ParadisSpreadsheetDrawing, options: ParadisSpreadsheetObjectRenderOptions): void {
	if (drawing.kind === 'line') {
		const endpoints = resolveSpreadsheetLineEndpoints(drawing, options.coordinateSpace);
		if (!endpoints) {
			appendPlaceholder(root, 'unsupportedLine', 'placeholder', placeholderBounds(drawing, options));
			return;
		}
		const line = svgElement(root.ownerDocument, 'line');
		line.setAttribute('class', 'paradis-spreadsheet-drawing-line');
		line.setAttribute('x1', numberAttribute(endpoints.start.x));
		line.setAttribute('y1', numberAttribute(endpoints.start.y));
		line.setAttribute('x2', numberAttribute(endpoints.end.x));
		line.setAttribute('y2', numberAttribute(endpoints.end.y));
		line.setAttribute('stroke', safeLineColor(drawing.line?.color));
		line.setAttribute('stroke-width', numberAttribute(safeLineWidth(drawing.line?.width)));
		line.setAttribute('vector-effect', 'non-scaling-stroke');
		root.appendChild(line);
		return;
	}
	const bounds = resolveSpreadsheetDrawingBounds(drawing.anchor, options.coordinateSpace, drawing.transform);
	if (drawing.presetGeometry !== 'rect' || !bounds) {
		appendPlaceholder(root, 'unsupportedShape', 'placeholder', bounds);
		return;
	}
	const rectangle = svgElement(root.ownerDocument, 'rect');
	rectangle.setAttribute('class', 'paradis-spreadsheet-drawing-rect');
	rectangle.setAttribute('x', numberAttribute(bounds.x));
	rectangle.setAttribute('y', numberAttribute(bounds.y));
	rectangle.setAttribute('width', numberAttribute(bounds.width));
	rectangle.setAttribute('height', numberAttribute(bounds.height));
	rectangle.setAttribute('fill', 'none');
	rectangle.setAttribute('stroke', safeLineColor(drawing.line?.color));
	rectangle.setAttribute('stroke-width', numberAttribute(safeLineWidth(drawing.line?.width)));
	applyPrimitiveTransform(rectangle, bounds, drawing.transform);
	root.appendChild(rectangle);
}

function chartValues(chart: ParadisSpreadsheetChart): readonly number[] | undefined {
	if (chart.evaluation !== 'savedCacheOnly' || chart.series.length !== 1) {
		return undefined;
	}
	const cache = chart.series[0].values?.cache;
	if (!cache || cache.length === 0 || cache.length > 256) {
		return undefined;
	}
	const ordered = [...cache].sort((left, right) => left.index - right.index);
	if (!ordered.every((point, index) => point.index === index)) {
		return undefined;
	}
	const values = ordered.map(point => {
		const value = point.value.trim();
		return STRICT_CHART_NUMBER.test(value) ? Number(value) : Number.NaN;
	});
	if (!values.every(Number.isFinite)) {
		return undefined;
	}
	const range = Math.max(0, ...values) - Math.min(0, ...values);
	return Number.isFinite(range) ? values : undefined;
}

function appendBarChart(root: SVGSVGElement, chart: ParadisSpreadsheetChart, bounds: ParadisSpreadsheetDrawingBounds, values: readonly number[]): void {
	const group = svgElement(root.ownerDocument, 'g');
	group.setAttribute('class', 'paradis-spreadsheet-chart');
	group.setAttribute('data-chart-type', chart.chartType);
	const frame = svgElement(root.ownerDocument, 'rect');
	frame.setAttribute('x', numberAttribute(bounds.x));
	frame.setAttribute('y', numberAttribute(bounds.y));
	frame.setAttribute('width', numberAttribute(bounds.width));
	frame.setAttribute('height', numberAttribute(bounds.height));
	frame.setAttribute('fill', 'none');
	frame.setAttribute('stroke', 'currentColor');
	group.appendChild(frame);
	const titleHeight = chart.title ? Math.min(18, bounds.height / 4) : 0;
	if (chart.title) {
		const title = svgElement(root.ownerDocument, 'text');
		title.setAttribute('x', numberAttribute(bounds.x + 4));
		title.setAttribute('y', numberAttribute(bounds.y + Math.max(10, titleHeight - 3)));
		title.textContent = chart.title;
		group.appendChild(title);
	}
	const plot = { x: bounds.x + 4, y: bounds.y + titleHeight + 4, width: Math.max(0, bounds.width - 8), height: Math.max(0, bounds.height - titleHeight - 8) };
	const minimum = Math.min(0, ...values);
	const maximum = Math.max(0, ...values);
	const range = maximum - minimum || 1;
	const baseline = plot.y + maximum / range * plot.height;
	const slotWidth = plot.width / values.length;
	for (let index = 0; index < values.length; index++) {
		const valueY = plot.y + (maximum - values[index]) / range * plot.height;
		const bar = svgElement(root.ownerDocument, 'rect');
		bar.setAttribute('class', 'paradis-spreadsheet-chart-bar');
		bar.setAttribute('x', numberAttribute(plot.x + index * slotWidth + slotWidth * 0.15));
		bar.setAttribute('y', numberAttribute(Math.min(valueY, baseline)));
		bar.setAttribute('width', numberAttribute(Math.max(0, slotWidth * 0.7)));
		bar.setAttribute('height', numberAttribute(Math.abs(baseline - valueY)));
		bar.setAttribute('fill', 'currentColor');
		group.appendChild(bar);
	}
	root.appendChild(group);
}

function appendChart(root: SVGSVGElement, chart: ParadisSpreadsheetChart, options: ParadisSpreadsheetObjectRenderOptions): void {
	const bounds = resolveSpreadsheetDrawingBounds(chart.anchor, options.coordinateSpace);
	const values = chart.chartType === 'bar' ? chartValues(chart) : undefined;
	if (!bounds || !values) {
		appendPlaceholder(root, 'unsupportedChart', 'placeholder', bounds);
		return;
	}
	appendBarChart(root, chart, bounds, values);
}

function appendObject(root: SVGSVGElement, value: object, options: ParadisSpreadsheetObjectRenderOptions): void {
	if (hasRawMarkupProperty(value)) {
		appendPlaceholder(root, 'rawMarkup', 'blockedByPolicy', placeholderBounds(value, options));
		return;
	}
	const kind = ownDataValue(value, 'kind');
	if (kind === 'image') {
		appendImage(root, value as ParadisSpreadsheetImage, options);
	} else if (kind === 'shape' || kind === 'line') {
		appendDrawing(root, value as ParadisSpreadsheetDrawing, options);
	} else if (kind === 'chart') {
		appendChart(root, value as ParadisSpreadsheetChart, options);
	} else if (kind === 'opaqueDrawing') {
		appendPlaceholder(root, 'opaqueDrawing', 'placeholder', placeholderBounds(value, options));
	} else {
		appendPlaceholder(root, 'unsafeObject', 'blockedByPolicy', placeholderBounds(value, options));
	}
}

/** Renders typed spreadsheet objects using safe DOM constructors; source XML/SVG is never accepted. */
export function renderSpreadsheetObjectOverlay(sheet: ParadisSemanticSheetWithObjects, options: ParadisSpreadsheetObjectRenderOptions): SVGSVGElement {
	const root = svgElement(options.document, 'svg');
	root.setAttribute('class', 'paradis-spreadsheet-object-overlay');
	for (const object of sheet.objects.images) {
		appendObject(root, object, options);
	}
	for (const object of sheet.objects.drawings) {
		appendObject(root, object, options);
	}
	for (const object of sheet.objects.charts) {
		appendObject(root, object, options);
	}
	for (const object of sheet.objects.opaqueDrawings) {
		appendObject(root, object, options);
	}
	let unanchoredOrdinal = 0;
	for (const part of sheet.objects.security.unsafeParts) {
		appendPlaceholder(root, part.kind, 'noAnchor', undefined, unanchoredOrdinal++);
	}
	const renderedExternalImages = new Set(sheet.objects.images.flatMap(image => isExternalImageContent(image.content) ? [image.content.targetFingerprint.value] : []));
	if (sheet.objects.security.externalReferences.some(reference => !renderedExternalImages.has(reference.targetFingerprint.value))) {
		appendPlaceholder(root, 'externalReference', 'noAnchor', undefined, unanchoredOrdinal++);
	}
	if (sheet.objects.opaqueParts.length > 0) {
		appendPlaceholder(root, 'opaquePart', 'noAnchor', undefined, unanchoredOrdinal++);
	}
	const vmlPartId = sheet.annotations?.vmlDrawingSource?.partId;
	if (vmlPartId && sheet.annotations?.opaqueFragments.some(fragment => fragment.source.partId === vmlPartId)) {
		appendPlaceholder(root, 'vmlOpaque', 'noAnchor', undefined, unanchoredOrdinal++);
	}
	return root;
}
