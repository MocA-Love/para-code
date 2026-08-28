/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { isOfficeRenderableAsset, type ParadisOfficeFingerprint, type ParadisOfficeRenderableAsset, type ParadisOfficeRenderCoverage, type ParadisOfficeTextRun } from '../../common/paradisOfficeProtocol.js';
import type { ParadisWordDrawingGeometry } from '../../common/word/paradisWordSemantic.js';
import { appendWordObjectPlaceholder, formatWordSvgNumber, type ParadisWordObjectBounds, type ParadisWordPlaceholderCoverage } from './paradisWordPlaceholder.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const EMU_PER_PIXEL = 9_525;
const STRICT_INTEGER = /^[+-]?\d+$/;
const STRICT_CHART_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const RAW_PAYLOAD_PROPERTIES = new Set([
	'arrayBuffer', 'binary', 'blob', 'buffer', 'bytes', 'html', 'innerHTML', 'markup', 'outerHTML',
	'rawHtml', 'rawSvg', 'rawXml', 'svg', 'xml',
]);
const SUPPORTED_PRESET_GEOMETRIES = new Set(['rect', 'roundRect', 'ellipse', 'triangle', 'rtTriangle', 'diamond', 'line', 'straightConnector1']);

interface ParadisWordRenderableObjectBase {
	readonly id: string;
	readonly geometry: ParadisWordDrawingGeometry;
}

export interface ParadisWordShapeObject extends ParadisWordRenderableObjectBase {
	readonly kind: 'shape';
}

export interface ParadisWordTextboxObject extends ParadisWordRenderableObjectBase {
	readonly kind: 'textbox';
	readonly runs: readonly ParadisOfficeTextRun[];
}

export interface ParadisWordWordArtObject extends ParadisWordRenderableObjectBase {
	readonly kind: 'wordArt';
	readonly text: string;
}

export interface ParadisWordChartSeries {
	readonly name?: string;
	readonly values: readonly { readonly index: number; readonly value: string }[];
}

export interface ParadisWordChartObject extends ParadisWordRenderableObjectBase {
	readonly kind: 'chart';
	readonly chartType: 'bar' | 'column' | string;
	readonly title?: string;
	readonly series: readonly ParadisWordChartSeries[];
}

export interface ParadisWordSmartArtNode {
	readonly id: string;
	readonly label: string;
	readonly parentId?: string;
}

export interface ParadisWordSmartArtObject extends ParadisWordRenderableObjectBase {
	readonly kind: 'smartArt';
	readonly layout: 'flow' | 'hierarchy';
	readonly nodes: readonly ParadisWordSmartArtNode[];
}

export type ParadisWordRenderableImageContent =
	| { readonly assetId: string; readonly contentType: string; readonly fingerprint: ParadisOfficeFingerprint }
	| { readonly behavior: 'notFetched' };

export interface ParadisWordImageObject extends ParadisWordRenderableObjectBase {
	readonly kind: 'image';
	readonly content: ParadisWordRenderableImageContent;
	readonly altText?: string;
}

export interface ParadisWordObjectPreviewReference {
	readonly id: string;
	readonly contentType: string;
	readonly fingerprint: ParadisOfficeFingerprint;
}

export interface ParadisWordOleObject extends ParadisWordRenderableObjectBase {
	readonly kind: 'ole';
	readonly preview?: ParadisWordObjectPreviewReference;
}

export type ParadisWordRenderableObject =
	| ParadisWordShapeObject
	| ParadisWordTextboxObject
	| ParadisWordWordArtObject
	| ParadisWordChartObject
	| ParadisWordSmartArtObject
	| ParadisWordImageObject
	| ParadisWordOleObject;

export interface ParadisWordObjectRenderAsset {
	readonly asset: ParadisOfficeRenderableAsset;
	/** Object URL created from bytes returned by the Platform renderable-asset channel. */
	readonly href: string;
}

export interface ParadisWordObjectRenderOptions {
	readonly document: Document;
	readonly assets: ReadonlyMap<string, ParadisWordObjectRenderAsset>;
}

export interface ParadisWordObjectRenderOutcome {
	readonly nodeId: string;
	readonly coverage: ParadisOfficeRenderCoverage;
	readonly feature: string;
}

export interface ParadisWordObjectRenderResult {
	readonly element: SVGSVGElement;
	readonly outcomes: readonly ParadisWordObjectRenderOutcome[];
}

interface TransformMatrix {
	readonly a: number;
	readonly b: number;
	readonly c: number;
	readonly d: number;
	readonly e: number;
	readonly f: number;
}

interface ResolvedGeometry {
	readonly bounds: ParadisWordObjectBounds;
	readonly matrix?: TransformMatrix;
}

function svgElement<K extends keyof SVGElementTagNameMap>(document: Document, name: K): SVGElementTagNameMap[K] {
	return document.createElementNS(SVG_NAMESPACE, name);
}

function ownDataValue(value: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor && descriptor.get === undefined && descriptor.set === undefined ? descriptor.value : undefined;
}

function safeNodeId(value: object, ordinal: number): string {
	const id = ownDataValue(value, 'id');
	return typeof id === 'string' && id.length > 0 && id.length <= 4_096 ? id : `word-object-${ordinal}`;
}

function hasUnsafePayload(root: object): boolean {
	const seen = new WeakSet<object>();
	const pending: { readonly value: object; readonly depth: number }[] = [{ value: root, depth: 0 }];
	let visited = 0;
	while (pending.length > 0) {
		const current = pending.pop()!;
		if (seen.has(current.value)) {
			continue;
		}
		seen.add(current.value);
		if (++visited > 4_096 || current.depth > 32 || current.value instanceof ArrayBuffer || ArrayBuffer.isView(current.value)) {
			return true;
		}
		let keys: readonly PropertyKey[];
		try {
			keys = Reflect.ownKeys(current.value);
		} catch {
			return true;
		}
		for (const key of keys) {
			if (typeof key !== 'string' || RAW_PAYLOAD_PROPERTIES.has(key)) {
				return true;
			}
			let descriptor: PropertyDescriptor | undefined;
			try {
				descriptor = Object.getOwnPropertyDescriptor(current.value, key);
			} catch {
				return true;
			}
			if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined) {
				return true;
			}
			if (descriptor.value !== null && typeof descriptor.value === 'object') {
				pending.push({ value: descriptor.value as object, depth: current.depth + 1 });
			}
		}
	}
	return false;
}

function lexicalInteger(value: string | undefined, allowNegative: boolean): number | undefined {
	if (value === undefined || !STRICT_INTEGER.test(value)) {
		return undefined;
	}
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && (allowNegative || parsed >= 0) ? parsed : undefined;
}

function emuCoordinate(value: string | undefined): number | undefined {
	const parsed = lexicalInteger(value, true);
	return parsed === undefined ? undefined : parsed / EMU_PER_PIXEL;
}

function emuExtent(value: string | undefined): number | undefined {
	const parsed = lexicalInteger(value, false);
	return parsed !== undefined && parsed > 0 ? parsed / EMU_PER_PIXEL : undefined;
}

function drawingToggle(value: string | undefined): boolean | undefined {
	if (value === undefined || value === '0' || value === 'false' || value === 'off') {
		return false;
	}
	return value === '1' || value === 'true' || value === 'on' ? true : undefined;
}

function roundedCoordinate(value: number): number {
	const rounded = Math.round(value * 1_000_000_000) / 1_000_000_000;
	return Object.is(rounded, -0) ? 0 : rounded;
}

function resolveWordObjectGeometry(geometry: ParadisWordDrawingGeometry): ResolvedGeometry | undefined {
	const transformExtent = geometry.transform?.extent;
	const width = emuExtent(transformExtent ? transformExtent.cx : geometry.extent?.cx);
	const height = emuExtent(transformExtent ? transformExtent.cy : geometry.extent?.cy);
	if (width === undefined || height === undefined) {
		return undefined;
	}

	const useSimplePosition = drawingToggle(geometry.anchorProperties?.simplePosition);
	if (useSimplePosition === undefined) {
		return undefined;
	}
	const position = geometry.placement === 'inline'
		? { x: '0', y: '0' }
		: useSimplePosition
			? geometry.simplePosition
			: { x: geometry.horizontalPosition?.offset, y: geometry.verticalPosition?.offset };
	const x = emuCoordinate(position?.x);
	const y = emuCoordinate(position?.y);
	if (x === undefined || y === undefined) {
		return undefined;
	}
	const bounds = { x, y, width, height };
	const rotation = geometry.transform?.rotation === undefined ? 0 : lexicalInteger(geometry.transform.rotation, true);
	const flipHorizontal = drawingToggle(geometry.transform?.flipHorizontal);
	const flipVertical = drawingToggle(geometry.transform?.flipVertical);
	if (rotation === undefined || flipHorizontal === undefined || flipVertical === undefined) {
		return undefined;
	}
	if (rotation === 0 && !flipHorizontal && !flipVertical) {
		return { bounds };
	}
	const radians = rotation / 60_000 * Math.PI / 180;
	const cosine = Math.cos(radians);
	const sine = Math.sin(radians);
	const horizontalScale = flipHorizontal ? -1 : 1;
	const verticalScale = flipVertical ? -1 : 1;
	const centerX = x + width / 2;
	const centerY = y + height / 2;
	const a = cosine * horizontalScale;
	const b = sine * horizontalScale;
	const c = -sine * verticalScale;
	const d = cosine * verticalScale;
	const matrix = {
		a: roundedCoordinate(a),
		b: roundedCoordinate(b),
		c: roundedCoordinate(c),
		d: roundedCoordinate(d),
		e: roundedCoordinate(centerX - a * centerX - c * centerY),
		f: roundedCoordinate(centerY - b * centerX - d * centerY),
	};
	return Object.values(matrix).every(Number.isFinite) ? { bounds, matrix } : undefined;
}

function applyTransform(element: SVGGraphicsElement, geometry: ResolvedGeometry): void {
	const matrix = geometry.matrix;
	if (matrix) {
		element.setAttribute('transform', `matrix(${formatWordSvgNumber(matrix.a)} ${formatWordSvgNumber(matrix.b)} ${formatWordSvgNumber(matrix.c)} ${formatWordSvgNumber(matrix.d)} ${formatWordSvgNumber(matrix.e)} ${formatWordSvgNumber(matrix.f)})`);
	}
}

function strokeWidth(geometry: ParadisWordDrawingGeometry): number {
	const width = lexicalInteger(geometry.line?.width, false);
	return width === undefined ? 1 : Math.min(32, Math.max(0.5, width / EMU_PER_PIXEL));
}

function strokeDashArray(value: string | undefined): string | undefined {
	switch (value) {
		case 'dot': return '1,2';
		case 'sysDot': return '1,1';
		case 'dash': return '4,3';
		case 'lgDash': return '8,3';
		case 'dashDot': return '4,2,1,2';
		case 'lgDashDot': return '8,2,1,2';
		default: return undefined;
	}
}

function styleShape(element: SVGGraphicsElement, geometry: ParadisWordDrawingGeometry): void {
	element.setAttribute('fill', 'none');
	element.setAttribute('stroke', 'currentColor');
	element.setAttribute('stroke-width', formatWordSvgNumber(strokeWidth(geometry)));
	element.setAttribute('vector-effect', 'non-scaling-stroke');
	const dash = strokeDashArray(geometry.line?.presetDash);
	if (dash) {
		element.setAttribute('stroke-dasharray', dash);
	}
}

function appendShapePrimitive(root: SVGElement, preset: string, geometry: ResolvedGeometry, source: ParadisWordDrawingGeometry): SVGGraphicsElement {
	const document = root.ownerDocument;
	const bounds = geometry.bounds;
	let shape: SVGGraphicsElement;
	if (preset === 'ellipse') {
		const ellipse = svgElement(document, 'ellipse');
		ellipse.setAttribute('cx', formatWordSvgNumber(bounds.x + bounds.width / 2));
		ellipse.setAttribute('cy', formatWordSvgNumber(bounds.y + bounds.height / 2));
		ellipse.setAttribute('rx', formatWordSvgNumber(bounds.width / 2));
		ellipse.setAttribute('ry', formatWordSvgNumber(bounds.height / 2));
		shape = ellipse;
	} else if (preset === 'triangle' || preset === 'rtTriangle' || preset === 'diamond') {
		const polygon = svgElement(document, 'polygon');
		const points = preset === 'triangle'
			? [[bounds.x + bounds.width / 2, bounds.y], [bounds.x + bounds.width, bounds.y + bounds.height], [bounds.x, bounds.y + bounds.height]]
			: preset === 'rtTriangle'
				? [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y + bounds.height], [bounds.x, bounds.y + bounds.height]]
				: [[bounds.x + bounds.width / 2, bounds.y], [bounds.x + bounds.width, bounds.y + bounds.height / 2], [bounds.x + bounds.width / 2, bounds.y + bounds.height], [bounds.x, bounds.y + bounds.height / 2]];
		polygon.setAttribute('points', points.map(point => `${formatWordSvgNumber(point[0])},${formatWordSvgNumber(point[1])}`).join(' '));
		shape = polygon;
	} else if (preset === 'line' || preset === 'straightConnector1') {
		const line = svgElement(document, 'line');
		line.setAttribute('x1', formatWordSvgNumber(bounds.x));
		line.setAttribute('y1', formatWordSvgNumber(bounds.y));
		line.setAttribute('x2', formatWordSvgNumber(bounds.x + bounds.width));
		line.setAttribute('y2', formatWordSvgNumber(bounds.y + bounds.height));
		shape = line;
	} else {
		const rectangle = svgElement(document, 'rect');
		rectangle.setAttribute('x', formatWordSvgNumber(bounds.x));
		rectangle.setAttribute('y', formatWordSvgNumber(bounds.y));
		rectangle.setAttribute('width', formatWordSvgNumber(bounds.width));
		rectangle.setAttribute('height', formatWordSvgNumber(bounds.height));
		if (preset === 'roundRect') {
			rectangle.setAttribute('rx', formatWordSvgNumber(Math.min(bounds.width, bounds.height) / 10));
		}
		shape = rectangle;
	}
	shape.setAttribute('class', 'paradis-word-object-shape');
	styleShape(shape, source);
	applyTransform(shape, geometry);
	root.appendChild(shape);
	return shape;
}

function safeText(value: string): string {
	return value.slice(0, 4_096);
}

function appendCenteredText(root: SVGElement, bounds: ParadisWordObjectBounds, value: string, className?: string): SVGTextElement {
	const text = svgElement(root.ownerDocument, 'text');
	if (className) {
		text.setAttribute('class', className);
	}
	text.setAttribute('x', formatWordSvgNumber(bounds.x + bounds.width / 2));
	text.setAttribute('y', formatWordSvgNumber(bounds.y + bounds.height / 2));
	text.setAttribute('text-anchor', 'middle');
	text.setAttribute('dominant-baseline', 'middle');
	text.textContent = safeText(value);
	root.appendChild(text);
	return text;
}

function outcome(nodeId: string, coverage: ParadisOfficeRenderCoverage, feature: string): ParadisWordObjectRenderOutcome {
	return Object.freeze({ nodeId, coverage, feature });
}

function placeholder(root: SVGSVGElement, nodeId: string, feature: string, coverage: ParadisWordPlaceholderCoverage, bounds: ParadisWordObjectBounds | undefined, ordinal: number): ParadisWordObjectRenderOutcome {
	appendWordObjectPlaceholder(root, { nodeId, feature, coverage, ...(bounds ? { bounds } : {}), ordinal });
	return outcome(nodeId, coverage, feature);
}

function appendShape(root: SVGSVGElement, object: ParadisWordShapeObject | ParadisWordTextboxObject | ParadisWordWordArtObject, ordinal: number): ParadisWordObjectRenderOutcome {
	const preset = object.geometry.presetGeometry ?? (object.kind === 'shape' ? undefined : 'rect');
	if (!preset || !SUPPORTED_PRESET_GEOMETRIES.has(preset)) {
		return placeholder(root, object.id, 'unsupportedGeometry', 'placeholder', resolveWordObjectGeometry(object.geometry)?.bounds, ordinal);
	}
	const geometry = resolveWordObjectGeometry(object.geometry);
	if (!geometry) {
		return placeholder(root, object.id, object.kind, 'noAnchor', undefined, ordinal);
	}
	if (object.kind === 'shape') {
		appendShapePrimitive(root, preset, geometry, object.geometry);
		return outcome(object.id, 'rendered', 'shape');
	}
	const group = svgElement(root.ownerDocument, 'g');
	group.setAttribute('class', object.kind === 'textbox' ? 'paradis-word-object-textbox' : 'paradis-word-object-wordart');
	appendShapePrimitive(group, preset, { bounds: geometry.bounds }, object.geometry);
	const value = object.kind === 'textbox' ? object.runs.map(run => run.text).join('') : object.text;
	appendCenteredText(group, geometry.bounds, value);
	applyTransform(group, geometry);
	root.appendChild(group);
	return outcome(object.id, object.kind === 'wordArt' ? 'approximated' : 'rendered', object.kind);
}

function chartValues(chart: ParadisWordChartObject): readonly number[] | undefined {
	if ((chart.chartType !== 'bar' && chart.chartType !== 'column') || chart.series.length === 0 || chart.series.length > 16) {
		return undefined;
	}
	const values: number[] = [];
	for (const series of chart.series) {
		if (series.values.length === 0 || series.values.length > 256) {
			return undefined;
		}
		const ordered = [...series.values].sort((left, right) => left.index - right.index);
		if (!ordered.every((point, index) => point.index === index)) {
			return undefined;
		}
		for (const point of ordered) {
			const lexical = point.value.trim();
			const value = STRICT_CHART_NUMBER.test(lexical) ? Number(lexical) : Number.NaN;
			if (!Number.isFinite(value)) {
				return undefined;
			}
			values.push(value);
		}
	}
	return values.length <= 256 ? values : undefined;
}

function appendChart(root: SVGSVGElement, chart: ParadisWordChartObject, ordinal: number): ParadisWordObjectRenderOutcome {
	const geometry = resolveWordObjectGeometry(chart.geometry);
	if (!geometry) {
		return placeholder(root, chart.id, 'chart', 'noAnchor', undefined, ordinal);
	}
	const values = chartValues(chart);
	if (!values) {
		return placeholder(root, chart.id, 'unsupportedChart', 'placeholder', geometry.bounds, ordinal);
	}
	const bounds = geometry.bounds;
	const group = svgElement(root.ownerDocument, 'g');
	group.setAttribute('class', 'paradis-word-chart');
	group.setAttribute('data-chart-type', chart.chartType);
	const frame = svgElement(root.ownerDocument, 'rect');
	frame.setAttribute('x', formatWordSvgNumber(bounds.x));
	frame.setAttribute('y', formatWordSvgNumber(bounds.y));
	frame.setAttribute('width', formatWordSvgNumber(bounds.width));
	frame.setAttribute('height', formatWordSvgNumber(bounds.height));
	frame.setAttribute('fill', 'none');
	frame.setAttribute('stroke', 'currentColor');
	group.appendChild(frame);
	const titleHeight = chart.title ? Math.min(18, bounds.height / 4) : 0;
	if (chart.title) {
		const title = svgElement(root.ownerDocument, 'text');
		title.setAttribute('x', formatWordSvgNumber(bounds.x + 4));
		title.setAttribute('y', formatWordSvgNumber(bounds.y + Math.max(10, titleHeight - 3)));
		title.textContent = safeText(chart.title);
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
		bar.setAttribute('class', 'paradis-word-chart-bar');
		bar.setAttribute('x', formatWordSvgNumber(plot.x + index * slotWidth + slotWidth * 0.15));
		bar.setAttribute('y', formatWordSvgNumber(Math.min(valueY, baseline)));
		bar.setAttribute('width', formatWordSvgNumber(Math.max(0, slotWidth * 0.7)));
		bar.setAttribute('height', formatWordSvgNumber(Math.abs(baseline - valueY)));
		bar.setAttribute('fill', 'currentColor');
		group.appendChild(bar);
	}
	applyTransform(group, geometry);
	root.appendChild(group);
	return outcome(chart.id, 'rendered', 'chart');
}

interface SmartArtLayoutNode {
	readonly source: ParadisWordSmartArtNode;
	readonly bounds: ParadisWordObjectBounds;
}

function smartArtLayout(object: ParadisWordSmartArtObject, bounds: ParadisWordObjectBounds): readonly SmartArtLayoutNode[] | undefined {
	if (object.nodes.length === 0 || object.nodes.length > 64) {
		return undefined;
	}
	const byId = new Map<string, ParadisWordSmartArtNode>();
	for (const node of object.nodes) {
		if (!node.id || node.id.length > 512 || typeof node.label !== 'string' || byId.has(node.id)) {
			return undefined;
		}
		byId.set(node.id, node);
	}
	const padding = 6;
	if (object.layout === 'flow') {
		const width = Math.max(1, (bounds.width - padding * (object.nodes.length + 1)) / object.nodes.length);
		const height = Math.max(1, bounds.height - padding * 2);
		return object.nodes.map((source, index) => ({ source, bounds: { x: bounds.x + padding + index * (width + padding), y: bounds.y + padding, width, height } }));
	}
	if (object.layout !== 'hierarchy') {
		return undefined;
	}
	const depthById = new Map<string, number>();
	const depthFor = (node: ParadisWordSmartArtNode, path: ReadonlySet<string>): number | undefined => {
		const cached = depthById.get(node.id);
		if (cached !== undefined) {
			return cached;
		}
		if (path.has(node.id)) {
			return undefined;
		}
		if (!node.parentId) {
			depthById.set(node.id, 0);
			return 0;
		}
		const parent = byId.get(node.parentId);
		if (!parent) {
			return undefined;
		}
		const parentDepth = depthFor(parent, new Set([...path, node.id]));
		if (parentDepth === undefined) {
			return undefined;
		}
		depthById.set(node.id, parentDepth + 1);
		return parentDepth + 1;
	};
	for (const node of object.nodes) {
		if (depthFor(node, new Set()) === undefined) {
			return undefined;
		}
	}
	const maximumDepth = Math.max(...depthById.values());
	const rows = Array.from({ length: maximumDepth + 1 }, () => [] as ParadisWordSmartArtNode[]);
	for (const node of object.nodes) {
		rows[depthById.get(node.id)!].push(node);
	}
	const rowHeight = Math.max(1, (bounds.height - padding * (rows.length + 1)) / rows.length);
	const result: SmartArtLayoutNode[] = [];
	for (let depth = 0; depth < rows.length; depth++) {
		const row = rows[depth];
		const width = Math.max(1, (bounds.width - padding * (row.length + 1)) / row.length);
		for (let index = 0; index < row.length; index++) {
			result.push({ source: row[index], bounds: { x: bounds.x + padding + index * (width + padding), y: bounds.y + padding + depth * (rowHeight + padding), width, height: rowHeight } });
		}
	}
	return result;
}

function appendConnector(group: SVGGElement, from: ParadisWordObjectBounds, to: ParadisWordObjectBounds): void {
	const line = svgElement(group.ownerDocument, 'line');
	line.setAttribute('x1', formatWordSvgNumber(from.x + from.width / 2));
	line.setAttribute('y1', formatWordSvgNumber(from.y + from.height / 2));
	line.setAttribute('x2', formatWordSvgNumber(to.x + to.width / 2));
	line.setAttribute('y2', formatWordSvgNumber(to.y + to.height / 2));
	line.setAttribute('stroke', 'currentColor');
	line.setAttribute('vector-effect', 'non-scaling-stroke');
	group.appendChild(line);
}

function appendSmartArt(root: SVGSVGElement, object: ParadisWordSmartArtObject, ordinal: number): ParadisWordObjectRenderOutcome {
	const geometry = resolveWordObjectGeometry(object.geometry);
	if (!geometry) {
		return placeholder(root, object.id, 'smartArt', 'noAnchor', undefined, ordinal);
	}
	const layout = smartArtLayout(object, geometry.bounds);
	if (!layout) {
		return placeholder(root, object.id, 'unsupportedSmartArt', 'placeholder', geometry.bounds, ordinal);
	}
	const group = svgElement(root.ownerDocument, 'g');
	group.setAttribute('class', 'paradis-word-smartart');
	group.setAttribute('data-smartart-layout', object.layout);
	const byId = new Map(layout.map(node => [node.source.id, node]));
	if (object.layout === 'flow') {
		for (let index = 1; index < layout.length; index++) {
			appendConnector(group, layout[index - 1].bounds, layout[index].bounds);
		}
	} else {
		for (const node of layout) {
			const parent = node.source.parentId ? byId.get(node.source.parentId) : undefined;
			if (parent) {
				appendConnector(group, parent.bounds, node.bounds);
			}
		}
	}
	for (const node of layout) {
		const rectangle = svgElement(root.ownerDocument, 'rect');
		rectangle.setAttribute('x', formatWordSvgNumber(node.bounds.x));
		rectangle.setAttribute('y', formatWordSvgNumber(node.bounds.y));
		rectangle.setAttribute('width', formatWordSvgNumber(node.bounds.width));
		rectangle.setAttribute('height', formatWordSvgNumber(node.bounds.height));
		rectangle.setAttribute('fill', 'none');
		rectangle.setAttribute('stroke', 'currentColor');
		group.appendChild(rectangle);
		appendCenteredText(group, node.bounds, node.source.label);
	}
	applyTransform(group, geometry);
	root.appendChild(group);
	return outcome(object.id, 'approximated', 'smartArt');
}

function sameFingerprint(left: ParadisOfficeFingerprint, right: ParadisOfficeFingerprint): boolean {
	return left.algorithm === right.algorithm && left.value === right.value && left.byteLength === right.byteLength;
}

function safeAssetHref(assetId: string, contentType: string, fingerprint: ParadisOfficeFingerprint, assets: ReadonlyMap<string, ParadisWordObjectRenderAsset>, preview: boolean): string | undefined {
	const candidate = assets.get(assetId);
	if (!candidate || !isOfficeRenderableAsset(candidate.asset) || candidate.asset.id !== assetId || !/^blob:[^\s]+$/.test(candidate.href)
		|| !sameFingerprint(candidate.asset.fingerprint, fingerprint) || candidate.asset.mime !== contentType.toLocaleLowerCase('en-US')) {
		return undefined;
	}
	if (candidate.asset.kind === 'rasterImage' || candidate.asset.kind === 'sanitizedSvg') {
		return candidate.href;
	}
	return preview && candidate.asset.kind === 'placeholderPreview' ? candidate.href : undefined;
}

function isExternalImageContent(content: ParadisWordRenderableImageContent): content is Extract<ParadisWordRenderableImageContent, { readonly behavior: 'notFetched' }> {
	return ownDataValue(content, 'behavior') === 'notFetched';
}

function appendImageElement(root: SVGSVGElement, className: string, href: string, geometry: ResolvedGeometry, altText: string | undefined): void {
	const image = svgElement(root.ownerDocument, 'image');
	image.setAttribute('class', className);
	image.setAttribute('x', formatWordSvgNumber(geometry.bounds.x));
	image.setAttribute('y', formatWordSvgNumber(geometry.bounds.y));
	image.setAttribute('width', formatWordSvgNumber(geometry.bounds.width));
	image.setAttribute('height', formatWordSvgNumber(geometry.bounds.height));
	image.setAttribute('preserveAspectRatio', 'xMidYMid meet');
	image.setAttribute('href', href);
	if (altText) {
		const title = svgElement(root.ownerDocument, 'title');
		title.textContent = safeText(altText);
		image.appendChild(title);
	}
	applyTransform(image, geometry);
	root.appendChild(image);
}

function appendImage(root: SVGSVGElement, object: ParadisWordImageObject, options: ParadisWordObjectRenderOptions, ordinal: number): ParadisWordObjectRenderOutcome {
	const geometry = resolveWordObjectGeometry(object.geometry);
	if (isExternalImageContent(object.content)) {
		return placeholder(root, object.id, 'externalImage', 'blockedByPolicy', geometry?.bounds, ordinal);
	}
	const href = safeAssetHref(object.content.assetId, object.content.contentType, object.content.fingerprint, options.assets, false);
	if (!href) {
		return placeholder(root, object.id, 'unsafeAsset', 'blockedByPolicy', geometry?.bounds, ordinal);
	}
	if (!geometry) {
		return placeholder(root, object.id, 'image', 'noAnchor', undefined, ordinal);
	}
	appendImageElement(root, 'paradis-word-object-image', href, geometry, object.altText);
	return outcome(object.id, 'rendered', 'image');
}

function appendOle(root: SVGSVGElement, object: ParadisWordOleObject, options: ParadisWordObjectRenderOptions, ordinal: number): ParadisWordObjectRenderOutcome {
	const geometry = resolveWordObjectGeometry(object.geometry);
	const href = object.preview ? safeAssetHref(object.preview.id, object.preview.contentType, object.preview.fingerprint, options.assets, true) : undefined;
	if (!href) {
		return placeholder(root, object.id, 'ole', 'blockedByPolicy', geometry?.bounds, ordinal);
	}
	if (!geometry) {
		return placeholder(root, object.id, 'olePreview', 'noAnchor', undefined, ordinal);
	}
	appendImageElement(root, 'paradis-word-object-preview', href, geometry, undefined);
	return outcome(object.id, 'approximated', 'olePreview');
}

function appendObject(root: SVGSVGElement, value: ParadisWordRenderableObject, options: ParadisWordObjectRenderOptions, ordinal: number): ParadisWordObjectRenderOutcome {
	const nodeId = safeNodeId(value, ordinal);
	if (hasUnsafePayload(value)) {
		return placeholder(root, nodeId, 'unsafePayload', 'blockedByPolicy', undefined, ordinal);
	}
	const kind = ownDataValue(value, 'kind');
	try {
		if (kind === 'shape' || kind === 'textbox' || kind === 'wordArt') {
			return appendShape(root, value as ParadisWordShapeObject | ParadisWordTextboxObject | ParadisWordWordArtObject, ordinal);
		}
		if (kind === 'chart') {
			return appendChart(root, value as ParadisWordChartObject, ordinal);
		}
		if (kind === 'smartArt') {
			return appendSmartArt(root, value as ParadisWordSmartArtObject, ordinal);
		}
		if (kind === 'image') {
			return appendImage(root, value as ParadisWordImageObject, options, ordinal);
		}
		if (kind === 'ole') {
			return appendOle(root, value as ParadisWordOleObject, options, ordinal);
		}
		return placeholder(root, nodeId, 'unsupportedObject', 'placeholder', undefined, ordinal);
	} catch {
		return placeholder(root, nodeId, 'unsafePayload', 'blockedByPolicy', undefined, ordinal);
	}
}

/** Renders typed Word object nodes with safe DOM constructors; source XML and binary are never accepted. */
export function renderWordObjectOverlay(objects: readonly ParadisWordRenderableObject[], options: ParadisWordObjectRenderOptions): ParadisWordObjectRenderResult {
	const root = svgElement(options.document, 'svg');
	root.setAttribute('class', 'paradis-word-object-overlay');
	const outcomes: ParadisWordObjectRenderOutcome[] = [];
	for (let index = 0; index < objects.length; index++) {
		outcomes.push(appendObject(root, objects[index], options, index));
	}
	return Object.freeze({ element: root, outcomes: Object.freeze(outcomes) });
}
