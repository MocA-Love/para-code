/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// xlsx の drawing XML(shared process から文字列で渡ってくる)を DOMParser で解析し、図形へ変換する。
// 直線コネクタ・形（矩形・楕円・括弧など）・自由形状・文字・画像・グループ・グラフを読む。描けないもの
// （EMF などの画像、SmartArt、対応していない形やグラフ）は「描けなかった図形」として別に返し、代替表示に数える。
// セル上の斜線もこの直線コネクタで表現される。

import { createTrustedTypesPolicy } from '../../../../base/browser/trustedTypes.js';
import { localize } from '../../../../nls.js';
import type { ParadisOfficePlaceholder } from '../common/paradisOfficeProtocol.js';
import type { IParadisChartData, IParadisDrawingData, IParadisRenderAnchor, IParadisRenderShape, IParadisShapeGroupTransform, IParadisSheetData, IParadisShapePath, IParadisShapeText, IParadisShapeTextParagraph, IParadisShapeTextRun, IParadisUndrawnObject, ParadisSpreadsheetShapeGeometry } from '../common/paradisSpreadsheet.js';
import type {
	ParadisSpreadsheetDrawing,
	ParadisSpreadsheetDrawingAnchor,
	ParadisSpreadsheetDrawingMarker,
	ParadisSpreadsheetDrawingTransform,
} from '../common/spreadsheet/paradisSpreadsheetObjects.js';
import { paradisChartLabelCount, parseParadisChartDocument, withoutParadisChartLabels } from './paradisSpreadsheetChartParser.js';
import { intAttr, xmlAttr, xmlChild, xmlChildren, xmlText } from './paradisSpreadsheetXml.js';

const EMU_PER_PIXEL = 9_525;

export interface ParadisSpreadsheetDrawingPoint {
	readonly x: number;
	readonly y: number;
}

export interface ParadisSpreadsheetDrawingBounds extends ParadisSpreadsheetDrawingPoint {
	readonly width: number;
	readonly height: number;
}

/** Resolves zero-based sheet markers to viewport coordinates before applying signed EMU offsets. */
export interface ParadisSpreadsheetDrawingCoordinateSpace {
	readonly columnLeft: (column: number) => number | undefined;
	readonly rowTop: (row: number) => number | undefined;
}

export interface ParadisSpreadsheetLineEndpoints {
	readonly start: ParadisSpreadsheetDrawingPoint;
	readonly end: ParadisSpreadsheetDrawingPoint;
}

export interface ParadisSpreadsheetDrawingTransformMatrix {
	readonly a: number;
	readonly b: number;
	readonly c: number;
	readonly d: number;
	readonly e: number;
	readonly f: number;
}

function typedEmuToPx(value: number): number | undefined {
	return Number.isSafeInteger(value) ? value / EMU_PER_PIXEL : undefined;
}

function finitePoint(x: number | undefined, y: number | undefined): ParadisSpreadsheetDrawingPoint | undefined {
	return x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

function resolveTypedMarker(marker: ParadisSpreadsheetDrawingMarker, coordinates: ParadisSpreadsheetDrawingCoordinateSpace): ParadisSpreadsheetDrawingPoint | undefined {
	const left = coordinates.columnLeft(marker.column);
	const top = coordinates.rowTop(marker.row);
	const xOffset = typedEmuToPx(marker.columnOffset);
	const yOffset = typedEmuToPx(marker.rowOffset);
	return finitePoint(left === undefined || xOffset === undefined ? undefined : left + xOffset, top === undefined || yOffset === undefined ? undefined : top + yOffset);
}

function boundsFromPoints(first: ParadisSpreadsheetDrawingPoint, second: ParadisSpreadsheetDrawingPoint): ParadisSpreadsheetDrawingBounds {
	return {
		x: Math.min(first.x, second.x),
		y: Math.min(first.y, second.y),
		width: Math.abs(second.x - first.x),
		height: Math.abs(second.y - first.y),
	};
}

function anchorEndpoints(anchor: ParadisSpreadsheetDrawingAnchor, coordinates: ParadisSpreadsheetDrawingCoordinateSpace): ParadisSpreadsheetLineEndpoints | undefined {
	if (anchor.kind === 'twoCell') {
		const start = resolveTypedMarker(anchor.from, coordinates);
		const end = resolveTypedMarker(anchor.to, coordinates);
		return start && end ? { start, end } : undefined;
	}
	const start = anchor.kind === 'oneCell'
		? resolveTypedMarker(anchor.from, coordinates)
		: finitePoint(typedEmuToPx(anchor.position.x), typedEmuToPx(anchor.position.y));
	const width = typedEmuToPx(anchor.extent.cx);
	const height = typedEmuToPx(anchor.extent.cy);
	return start && width !== undefined && height !== undefined
		? { start, end: { x: start.x + width, y: start.y + height } }
		: undefined;
}

function transformedBounds(base: ParadisSpreadsheetDrawingBounds, transform: ParadisSpreadsheetDrawingTransform | undefined): ParadisSpreadsheetDrawingBounds | undefined {
	const offsetX = transform?.offset ? typedEmuToPx(transform.offset.x) : base.x;
	const offsetY = transform?.offset ? typedEmuToPx(transform.offset.y) : base.y;
	const width = transform?.extent ? typedEmuToPx(transform.extent.cx) : base.width;
	const height = transform?.extent ? typedEmuToPx(transform.extent.cy) : base.height;
	return offsetX === undefined || offsetY === undefined || width === undefined || height === undefined
		? undefined
		: { x: offsetX, y: offsetY, width, height };
}

/** Resolves a typed DrawingML anchor without parsing or accepting source XML. */
export function resolveSpreadsheetDrawingBounds(
	anchor: ParadisSpreadsheetDrawingAnchor,
	coordinates: ParadisSpreadsheetDrawingCoordinateSpace,
	transform?: ParadisSpreadsheetDrawingTransform,
): ParadisSpreadsheetDrawingBounds | undefined {
	const endpoints = anchorEndpoints(anchor, coordinates);
	return endpoints ? transformedBounds(boundsFromPoints(endpoints.start, endpoints.end), transform) : undefined;
}

/** Resolves one SVG matrix for non-line primitives; line geometry is transformed directly instead. */
export function resolveSpreadsheetDrawingTransformMatrix(
	bounds: ParadisSpreadsheetDrawingBounds,
	transform: ParadisSpreadsheetDrawingTransform | undefined,
): ParadisSpreadsheetDrawingTransformMatrix | undefined {
	if (!transform?.flipHorizontal && !transform?.flipVertical && !transform?.rotation) {
		return undefined;
	}
	if (transform.rotation !== undefined && !Number.isSafeInteger(transform.rotation)) {
		return undefined;
	}
	const radians = ((transform.rotation ?? 0) / 60_000) * Math.PI / 180;
	const cosine = Math.cos(radians);
	const sine = Math.sin(radians);
	const horizontalScale = transform.flipHorizontal ? -1 : 1;
	const verticalScale = transform.flipVertical ? -1 : 1;
	const centerX = bounds.x + bounds.width / 2;
	const centerY = bounds.y + bounds.height / 2;
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
	return Object.values(matrix).every(Number.isFinite) ? matrix : undefined;
}

function mapAxis(value: number, sourceStart: number, sourceExtent: number, targetStart: number, targetExtent: number): number {
	return sourceExtent === 0 ? targetStart + targetExtent / 2 : targetStart + (value - sourceStart) / sourceExtent * targetExtent;
}

function transformPoint(
	point: ParadisSpreadsheetDrawingPoint,
	base: ParadisSpreadsheetDrawingBounds,
	target: ParadisSpreadsheetDrawingBounds,
	transform: ParadisSpreadsheetDrawingTransform | undefined,
): ParadisSpreadsheetDrawingPoint {
	const centerX = target.x + target.width / 2;
	const centerY = target.y + target.height / 2;
	let x = mapAxis(point.x, base.x, base.width, target.x, target.width);
	let y = mapAxis(point.y, base.y, base.height, target.y, target.height);
	if (transform?.flipHorizontal) {
		x = 2 * centerX - x;
	}
	if (transform?.flipVertical) {
		y = 2 * centerY - y;
	}
	const radians = ((transform?.rotation ?? 0) / 60_000) * Math.PI / 180;
	if (radians !== 0) {
		const deltaX = x - centerX;
		const deltaY = y - centerY;
		x = centerX + deltaX * Math.cos(radians) - deltaY * Math.sin(radians);
		y = centerY + deltaX * Math.sin(radians) + deltaY * Math.cos(radians);
	}
	return { x: roundedCoordinate(x), y: roundedCoordinate(y) };
}

function roundedCoordinate(value: number): number {
	const rounded = Math.round(value * 1_000_000_000) / 1_000_000_000;
	return Object.is(rounded, -0) ? 0 : rounded;
}

/** Computes final line endpoints, applying DrawingML offset/extent/flip/rotation once in numeric geometry. */
export function resolveSpreadsheetLineEndpoints(
	drawing: ParadisSpreadsheetDrawing,
	coordinates: ParadisSpreadsheetDrawingCoordinateSpace,
): ParadisSpreadsheetLineEndpoints | undefined {
	const geometry = drawing.lineGeometry;
	if (drawing.kind !== 'line' || !geometry) {
		return undefined;
	}
	let endpoints: ParadisSpreadsheetLineEndpoints | undefined;
	if (geometry.kind === 'cellAnchored') {
		const start = resolveTypedMarker(geometry.start, coordinates);
		const end = resolveTypedMarker(geometry.end, coordinates);
		endpoints = start && end ? { start, end } : undefined;
	} else {
		const start = geometry.kind === 'cellAnchoredExtent'
			? resolveTypedMarker(geometry.start, coordinates)
			: finitePoint(typedEmuToPx(geometry.start.x), typedEmuToPx(geometry.start.y));
		const width = typedEmuToPx(geometry.extent.cx);
		const height = typedEmuToPx(geometry.extent.cy);
		endpoints = start && width !== undefined && height !== undefined
			? { start, end: { x: start.x + width, y: start.y + height } }
			: undefined;
	}
	if (!endpoints) {
		return undefined;
	}
	const base = boundsFromPoints(endpoints.start, endpoints.end);
	const target = transformedBounds(base, drawing.transform);
	return target ? {
		start: transformPoint(endpoints.start, base, target, drawing.transform),
		end: transformPoint(endpoints.end, base, target, drawing.transform),
	} : undefined;
}

// VS Code workbench は Trusted Types を強制しており、DOMParser.parseFromString に生文字列を渡すとブロックされる。
// upstream の htmlToMarkdown.ts と同じく、専用ポリシーで文字列を Trusted 化してから渡す。
const ttPolicy = createTrustedTypesPolicy('paradisSpreadsheetDrawings', { createHTML: value => value });

// 図形の schemeClr 用の標準Officeテーマ色(Office 2013+ の既定)。ブック固有の theme1.xml 由来パレット
// (IParadisWorkbookData.themeColors)が渡されればそちらを優先し、これはフォールバックとして使う。
const SHAPE_THEME_COLORS: Record<string, string> = {
	lt1: '#FFFFFF', dk1: '#000000', lt2: '#E7E6E6', dk2: '#44546A',
	accent1: '#4472C4', accent2: '#ED7D31', accent3: '#A5A5A5',
	accent4: '#FFC000', accent5: '#5B9BD5', accent6: '#70AD47',
};

/** 図形の schemeClr 解決に使うテーマ色(scheme名→hex)。 */
export type ParadisShapeThemeColors = { readonly [schemeName: string]: string };

function parseAnchorPosition(el: Element): IParadisRenderAnchor {
	return {
		c: Number.parseInt(xmlText(el, 'col'), 10),
		co: Number.parseInt(xmlText(el, 'colOff'), 10),
		r: Number.parseInt(xmlText(el, 'row'), 10),
		ro: Number.parseInt(xmlText(el, 'rowOff'), 10),
	};
}

/** `tx1`・`bg1` などの別名を、テーマの色の名前へ（ECMA-376 Part 1 §20.1.10.54、既定の色の対応）。 */
const SCHEME_COLOR_ALIASES: Record<string, string> = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' };

interface ResolvedColor {
	readonly color: string;
	readonly alpha: number;
}

function hexToRgb(hex: string): [number, number, number] | undefined {
	const match = /^#?(?<value>[0-9a-fA-F]{6})$/.exec(hex);
	if (!match?.groups) {
		return undefined;
	}
	const value = Number.parseInt(match.groups.value, 16);
	return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function rgbToHex([red, green, blue]: readonly number[]): string {
	return `#${[red, green, blue].map(channel => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function rgbToHsl([red, green, blue]: readonly number[]): [number, number, number] {
	const r = red / 255, g = green / 255, b = blue / 255;
	const max = Math.max(r, g, b), min = Math.min(r, g, b);
	const lightness = (max + min) / 2;
	if (max === min) {
		return [0, 0, lightness];
	}
	const delta = max - min;
	const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
	const hue = max === r ? (g - b) / delta + (g < b ? 6 : 0) : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
	return [hue / 6, saturation, lightness];
}

function hslToRgb([hue, saturation, lightness]: readonly number[]): [number, number, number] {
	if (saturation === 0) {
		return [lightness * 255, lightness * 255, lightness * 255];
	}
	const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
	const p = 2 * lightness - q;
	const channel = (t: number) => {
		const k = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
		return 255 * (k < 1 / 6 ? p + (q - p) * 6 * k : k < 1 / 2 ? q : k < 2 / 3 ? p + (q - p) * (2 / 3 - k) * 6 : p);
	};
	return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)];
}

function toLinear(channel: number): number {
	const value = Math.max(0, Math.min(255, channel)) / 255;
	return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function fromLinear(linear: number): number {
	const value = Math.max(0, Math.min(1, linear));
	return 255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055);
}

/** 色の要素（srgbClr・schemeClr・sysClr・prstClr）と、その明るさの変換（lumMod・lumOff・shade・tint・alpha）。 */
function resolveColorElement(colorEl: Element, themeColors: ParadisShapeThemeColors | undefined, placeholder?: ResolvedColor): ResolvedColor | undefined {
	let base: string | undefined;
	switch (colorEl.localName) {
		case 'srgbClr': base = `#${xmlAttr(colorEl, 'val')}`; break;
		case 'sysClr': base = `#${xmlAttr(colorEl, 'lastClr') || (xmlAttr(colorEl, 'val') === 'window' ? 'FFFFFF' : '000000')}`; break;
		case 'prstClr': base = PRESET_COLORS[xmlAttr(colorEl, 'val')]; break;
		case 'schemeClr': {
			const name = xmlAttr(colorEl, 'val');
			if (name === 'phClr') {
				base = placeholder?.color;
				break;
			}
			const key = SCHEME_COLOR_ALIASES[name] ?? name;
			base = themeColors?.[key] || SHAPE_THEME_COLORS[key];
			break;
		}
		default: return undefined;
	}
	const rgb = base ? hexToRgb(base) : undefined;
	if (!rgb) {
		return undefined;
	}
	let [red, green, blue] = rgb;
	let alpha = 1;
	for (const modifier of xmlChildren(colorEl)) {
		const value = intAttr(modifier, 'val', 100000) / 100000;
		switch (modifier.localName) {
			case 'lumMod': case 'lumOff': {
				const [hue, saturation, lightness] = rgbToHsl([red, green, blue]);
				const next = modifier.localName === 'lumMod' ? lightness * value : lightness + value;
				[red, green, blue] = hslToRgb([hue, saturation, Math.max(0, Math.min(1, next))]);
				break;
			}
			// shade・tint は線形の RGB で掛ける（Part 1 §20.1.2.3.31・§20.1.2.3.34）。
			case 'shade': [red, green, blue] = [red, green, blue].map(channel => fromLinear(toLinear(channel) * value)); break;
			case 'tint': [red, green, blue] = [red, green, blue].map(channel => { const linear = toLinear(channel); return fromLinear(linear + (1 - linear) * (1 - value)); }); break;
			case 'alpha': alpha = Math.max(0, Math.min(1, value)); break;
		}
	}
	return { color: rgbToHex([red, green, blue]), alpha };
}

const PRESET_COLORS: Record<string, string> = { black: '#000000', white: '#FFFFFF', red: '#FF0000', green: '#008000', blue: '#0000FF', yellow: '#FFFF00', gray: '#808080' };

/** 塗りの要素（solidFill など）を持つ親から、最初の色を読む。 */
function resolveFill(parent: Element | null, themeColors: ParadisShapeThemeColors | undefined, placeholder?: ResolvedColor): ResolvedColor | 'none' | undefined {
	for (const child of xmlChildren(parent)) {
		switch (child.localName) {
			case 'noFill': return 'none';
			case 'solidFill': {
				const colorEl = xmlChildren(child)[0];
				return colorEl ? resolveColorElement(colorEl, themeColors, placeholder) : undefined;
			}
			case 'gradFill': {
				// グラデーションは最初の色で近似する。
				const stop = xmlChild(xmlChild(child, 'gsLst'), 'gs');
				const colorEl = stop ? xmlChildren(stop)[0] : undefined;
				return colorEl ? resolveColorElement(colorEl, themeColors, placeholder) : undefined;
			}
			case 'pattFill': {
				const colorEl = xmlChildren(xmlChild(child, 'fgClr'))[0];
				return colorEl ? resolveColorElement(colorEl, themeColors, placeholder) : undefined;
			}
		}
	}
	return undefined;
}

/** 図形の style の参照（lnRef・fillRef・fontRef）の色。idx が 0 なら「なし」。 */
function styleRef(shapeEl: Element, name: 'lnRef' | 'fillRef' | 'fontRef', themeColors: ParadisShapeThemeColors | undefined): ResolvedColor | 'none' | undefined {
	const ref = xmlChild(xmlChild(shapeEl, 'style'), name);
	if (!ref) {
		return undefined;
	}
	if (name !== 'fontRef' && intAttr(ref, 'idx', 0) === 0) {
		return 'none';
	}
	const colorEl = xmlChildren(ref)[0];
	return colorEl ? resolveColorElement(colorEl, themeColors) : undefined;
}

function cNvPrOf(container: Element | null): { name?: string; shapeId?: string; hidden: boolean } {
	const cNvPr = container ? xmlChild(container, 'cNvPr') : null;
	if (!cNvPr) {
		return { hidden: false };
	}
	const hidden = xmlAttr(cNvPr, 'hidden');
	return { name: xmlAttr(cNvPr, 'name') || undefined, shapeId: xmlAttr(cNvPr, 'id') || undefined, hidden: hidden === '1' || hidden === 'true' };
}

/** 位置の割合（アンカーの枠の中の、左上と幅・高さ）。 */
interface Frame {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

const FULL_FRAME: Frame = { x: 0, y: 0, width: 1, height: 1 };

/** グループの中の座標を、アンカーの枠の割合へ写す。 */
interface GroupSpace {
	readonly frame: Frame;
	readonly depth: number;
	readonly transforms: readonly IParadisShapeGroupTransform[];
	readonly offX: number;
	readonly offY: number;
	readonly extX: number;
	readonly extY: number;
}

function childFrame(xfrm: Element | null, space: GroupSpace | undefined): Frame | undefined {
	if (!space) {
		return undefined;
	}
	const off = xmlChild(xfrm, 'off');
	const ext = xmlChild(xfrm, 'ext');
	if (!off || !ext || space.extX <= 0 || space.extY <= 0) {
		return space.frame;
	}
	const x = (intAttr(off, 'x', 0) - space.offX) / space.extX;
	const y = (intAttr(off, 'y', 0) - space.offY) / space.extY;
	const width = intAttr(ext, 'cx', 0) / space.extX;
	const height = intAttr(ext, 'cy', 0) / space.extY;
	return {
		x: space.frame.x + x * space.frame.width,
		y: space.frame.y + y * space.frame.height,
		width: width * space.frame.width,
		height: height * space.frame.height,
	};
}

const KNOWN_GEOMETRIES = new Set<ParadisSpreadsheetShapeGeometry>(['rect', 'roundRect', 'ellipse', 'triangle', 'rtTriangle', 'diamond', 'leftBracket', 'rightBracket', 'leftBrace', 'rightBrace']);
const LINE_GEOMETRIES = new Set(['line', 'straightConnector1', 'bentConnector2', 'bentConnector3', 'curvedConnector3']);
/** 線の形のうち、直線で描くと形が違ってしまうもの（近似として数える）。 */
const APPROXIMATED_LINE_GEOMETRIES = new Set(['bentConnector2', 'bentConnector3', 'curvedConnector3']);

/** custGeom の pathLst を、枠の中の割合の道筋にする。arcTo を含む道筋は描けないので undefined。 */
function parseCustomPaths(custGeom: Element, commandLimit: number): IParadisShapePath[] | 'overLimit' | undefined {
	const paths: IParadisShapePath[] = [];
	let commands = 0;
	for (const path of xmlChildren(xmlChild(custGeom, 'pathLst'), 'path')) {
		const width = intAttr(path, 'w', 0);
		const height = intAttr(path, 'h', 0);
		if (width <= 0 || height <= 0) {
			return undefined;
		}
		const point = (el: Element): number[] => [intAttr(el, 'x', 0) / width, intAttr(el, 'y', 0) / height];
		const d: (readonly ['M' | 'L' | 'C' | 'Q' | 'Z', ...number[]])[] = [];
		for (const command of xmlChildren(path)) {
			if (++commands > commandLimit) {
				return 'overLimit';
			}
			const points = xmlChildren(command, 'pt');
			switch (command.localName) {
				case 'moveTo': if (points[0]) { d.push(['M', ...point(points[0])]); } break;
				case 'lnTo': if (points[0]) { d.push(['L', ...point(points[0])]); } break;
				case 'cubicBezTo': if (points.length === 3) { d.push(['C', ...points.flatMap(point)]); } break;
				case 'quadBezTo': if (points.length === 2) { d.push(['Q', ...points.flatMap(point)]); } break;
				case 'close': d.push(['Z']); break;
				default: return undefined;
			}
		}
		const fill = xmlAttr(path, 'fill');
		const stroke = xmlAttr(path, 'stroke');
		paths.push({ d, fill: fill !== 'none', stroke: stroke !== '0' && stroke !== 'false' });
	}
	return paths.length > 0 ? paths : undefined;
}

const TEXT_INSET_DEFAULT_EMU = { left: 91440, top: 45720, right: 91440, bottom: 45720 };

function parseText(shapeEl: Element, themeColors: ParadisShapeThemeColors | undefined): IParadisShapeText | undefined {
	const txBody = xmlChild(shapeEl, 'txBody');
	if (!txBody) {
		return undefined;
	}
	const fontColor = styleRef(shapeEl, 'fontRef', themeColors);
	const paragraphs: IParadisShapeTextParagraph[] = [];
	let hasText = false;
	for (const paragraph of xmlChildren(txBody, 'p')) {
		const pPr = xmlChild(paragraph, 'pPr');
		const defaults = xmlChild(pPr, 'defRPr');
		const runs: IParadisShapeTextRun[] = [];
		for (const run of xmlChildren(paragraph)) {
			if (run.localName === 'br') {
				runs.push({ text: '\n' });
				continue;
			}
			if (run.localName !== 'r' && run.localName !== 'fld') {
				continue;
			}
			const text = xmlChild(run, 't')?.textContent ?? '';
			if (!text) {
				continue;
			}
			hasText = true;
			const rPr = xmlChild(run, 'rPr') ?? defaults;
			const size = rPr ? intAttr(rPr, 'sz', 0) / 100 : 0;
			const fill = rPr ? resolveFill(rPr, themeColors) : undefined;
			const color = fill && fill !== 'none' ? fill.color : fontColor && fontColor !== 'none' ? fontColor.color : undefined;
			const latin = xmlChild(rPr, 'ea') ?? xmlChild(rPr, 'latin');
			const font = latin ? xmlAttr(latin, 'typeface') : '';
			runs.push({
				text,
				...(size > 0 ? { size } : {}),
				...(rPr && (xmlAttr(rPr, 'b') === '1' || xmlAttr(rPr, 'b') === 'true') ? { bold: true } : {}),
				...(rPr && (xmlAttr(rPr, 'i') === '1' || xmlAttr(rPr, 'i') === 'true') ? { italic: true } : {}),
				...(rPr && xmlAttr(rPr, 'u') && xmlAttr(rPr, 'u') !== 'none' ? { underline: true } : {}),
				...(color ? { color } : {}),
				...(font && !font.startsWith('+') ? { font } : {}),
			});
		}
		const algn = pPr ? xmlAttr(pPr, 'algn') : '';
		paragraphs.push({ runs, ...(algn === 'ctr' ? { align: 'center' as const } : algn === 'r' ? { align: 'right' as const } : algn === 'just' || algn === 'dist' ? { align: 'justify' as const } : {}) });
	}
	if (!hasText) {
		return undefined;
	}
	const bodyPr = xmlChild(txBody, 'bodyPr');
	const anchor = bodyPr ? xmlAttr(bodyPr, 'anchor') : '';
	const vert = bodyPr ? xmlAttr(bodyPr, 'vert') : '';
	const inset = (name: 'lIns' | 'tIns' | 'rIns' | 'bIns', fallback: number) => intAttr(bodyPr, name, fallback) / EMU_PER_PIXEL;
	return {
		paragraphs,
		...(anchor === 'ctr' ? { anchor: 'middle' as const } : anchor === 'b' ? { anchor: 'bottom' as const } : {}),
		...(vert === 'vert' || vert === 'eaVert' || vert === 'wordArtVertRtl' || vert === 'mongolianVert' ? { vertical: true } : {}),
		insets: {
			left: inset('lIns', TEXT_INSET_DEFAULT_EMU.left),
			top: inset('tIns', TEXT_INSET_DEFAULT_EMU.top),
			right: inset('rIns', TEXT_INSET_DEFAULT_EMU.right),
			bottom: inset('bIns', TEXT_INSET_DEFAULT_EMU.bottom),
		},
		wrap: !bodyPr || xmlAttr(bodyPr, 'wrap') !== 'none',
	};
}

interface AnchorBox {
	readonly from: IParadisRenderAnchor;
	readonly to: IParadisRenderAnchor;
	readonly ext?: { readonly cx: number; readonly cy: number };
}

/** 描く量の上限。workbench の renderer の DOM で直接描くので、壊れた・大きすぎるブックで止まらないようにする。 */
export interface ParadisSpreadsheetDrawingLimits {
	/** グループの入れ子の深さ。 */
	readonly groupDepth: number;
	/** 1 シートで描く図形の数。 */
	readonly shapesPerSheet: number;
	/** 1 つの図形の道筋の命令の数。 */
	readonly pathCommands: number;
	/** 1 つのグラフの系列の数。 */
	readonly chartSeries: number;
	/** 1 つのグラフの点の合計。 */
	readonly chartPoints: number;
	/** 1 シートのグラフの点の合計。同じグラフを何度も参照させて描く量を増やすのを止める。 */
	readonly chartPointsPerSheet?: number;
	/** 1 シートのグラフのデータラベルの合計。越えたグラフはラベルを省いて描く。 */
	readonly chartLabelsPerSheet?: number;
}

export const PARADIS_SPREADSHEET_DRAWING_LIMITS: ParadisSpreadsheetDrawingLimits = Object.freeze({
	groupDepth: 32,
	shapesPerSheet: 5_000,
	pathCommands: 10_000,
	chartSeries: 255,
	chartPoints: 100_000,
	chartPointsPerSheet: 200_000,
	chartLabelsPerSheet: 10_000,
});

interface ParseContext {
	readonly limits: ParadisSpreadsheetDrawingLimits;
	readonly media: { readonly [rid: string]: string };
	readonly charts: { readonly [rid: string]: string };
	readonly themeColors: ParadisShapeThemeColors | undefined;
	readonly parser: DOMParser;
	readonly shapes: IParadisRenderShape[];
	readonly undrawn: IParadisUndrawnObject[];
	/** シート全体のグラフの点の合計と、読んだグラフ（同じ chartN.xml を何度も読まない）。 */
	readonly chartBudget: { points: number; labels: number; readonly parsed: Map<string, IParadisChartData | 'overLimit' | undefined> };
}

function relationshipId(el: Element | null, name: string): string {
	if (!el) {
		return '';
	}
	return el.getAttribute(`r:${name}`) || el.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', name) || el.getAttribute(name) || '';
}

function transformOf(xfrm: Element | null): { flipH: boolean; flipV: boolean; rotation?: number } {
	const flipH = xfrm ? xmlAttr(xfrm, 'flipH') === '1' || xmlAttr(xfrm, 'flipH') === 'true' : false;
	const flipV = xfrm ? xmlAttr(xfrm, 'flipV') === '1' || xmlAttr(xfrm, 'flipV') === 'true' : false;
	const rot = intAttr(xfrm, 'rot', 0) / 60000;
	return { flipH, flipV, ...(rot ? { rotation: rot } : {}) };
}

function frameField(frame: Frame | undefined): { frame?: Frame } {
	return frame && (frame.x !== 0 || frame.y !== 0 || frame.width !== 1 || frame.height !== 1) ? { frame } : {};
}

function groupField(space: GroupSpace | undefined): { groupTransforms?: readonly IParadisShapeGroupTransform[] } {
	return space && space.transforms.length > 0 ? { groupTransforms: space.transforms } : {};
}

/** 図形を 1 つ描く枠を取る。シートの上限を越えたら取らずに、描けなかった図形として数える。 */
function reserveShape(context: ParseContext, name: string | undefined, box: AnchorBox): boolean {
	if (context.shapes.length >= context.limits.shapesPerSheet) {
		context.undrawn.push({ kind: 'overLimit', ...(name ? { name } : {}), from: box.from });
		return false;
	}
	return true;
}

function parseShapeElement(el: Element, box: AnchorBox, space: GroupSpace | undefined, context: ParseContext): void {
	switch (el.localName) {
		case 'sp':
		case 'cxnSp':
			parseGeometryShape(el, box, space, context);
			return;
		case 'pic':
			parsePicture(el, box, space, context);
			return;
		case 'grpSp':
			parseGroup(el, box, space, context);
			return;
		case 'graphicFrame':
			parseGraphicFrame(el, box, space, context);
			return;
		case 'contentPart': {
			context.undrawn.push({ kind: 'contentPart', from: box.from });
			return;
		}
		case 'AlternateContent': {
			// 理解できる枝（a14 など図形の拡張だけを求めるもの）を選び、無ければ Fallback（Part 3 §10.2）。
			const choice = xmlChildren(el, 'Choice').find(branch => xmlAttr(branch, 'Requires').split(/\s+/).every(prefix => SUPPORTED_MC_PREFIXES.has(prefix)));
			const branch = choice ?? xmlChild(el, 'Fallback');
			for (const child of xmlChildren(branch)) {
				parseShapeElement(child, box, space, context);
			}
			return;
		}
	}
}

/** 図形の中身を読むのに要らない拡張（Office 2010 の図形の拡張）だけを求める枝は、読んでよい。 */
const SUPPORTED_MC_PREFIXES = new Set(['a14']);

function parseGeometryShape(el: Element, box: AnchorBox, space: GroupSpace | undefined, context: ParseContext): void {
	const { name, shapeId, hidden } = cNvPrOf(xmlChild(el, 'nvSpPr') || xmlChild(el, 'nvCxnSpPr'));
	if (hidden) {
		return;
	}
	const spPr = xmlChild(el, 'spPr');
	if (!spPr) {
		return;
	}
	const xfrm = xmlChild(spPr, 'xfrm');
	const frame = childFrame(xfrm, space);
	const prstGeom = xmlChild(spPr, 'prstGeom');
	const custGeom = xmlChild(spPr, 'custGeom');
	const prst = prstGeom ? xmlAttr(prstGeom, 'prst') : '';
	const isLine = LINE_GEOMETRIES.has(prst) || (el.localName === 'cxnSp' && !custGeom);
	let geometry: ParadisSpreadsheetShapeGeometry | undefined;
	let paths: IParadisShapePath[] | undefined;
	let approximated = false;
	if (custGeom) {
		const parsed = parseCustomPaths(custGeom, context.limits.pathCommands);
		if (parsed === 'overLimit') {
			context.undrawn.push({ kind: 'overLimit', ...(name ? { name } : {}), from: box.from });
			return;
		}
		paths = parsed;
		geometry = paths ? 'path' : 'rect';
		approximated = !paths;
	} else if (!isLine) {
		geometry = KNOWN_GEOMETRIES.has(prst as ParadisSpreadsheetShapeGeometry) ? prst as ParadisSpreadsheetShapeGeometry : 'rect';
		approximated = !!prst && !KNOWN_GEOMETRIES.has(prst as ParadisSpreadsheetShapeGeometry);
	} else {
		approximated = APPROXIMATED_LINE_GEOMETRIES.has(prst);
	}
	const adjust = prstGeom ? xmlChildren(xmlChild(prstGeom, 'avLst'), 'gd').map(gd => /^val (?<value>-?\d+)$/.exec(xmlAttr(gd, 'fmla'))?.groups?.value).map(value => value === undefined ? Number.NaN : Number(value)) : [];

	// 線: spPr の ln が先、無ければ style の lnRef（Part 1 §20.1.2.2.24・§20.1.4.2.19）。
	const ln = xmlChild(spPr, 'ln');
	const lnRef = styleRef(el, 'lnRef', context.themeColors);
	const lnFill = ln ? resolveFill(ln, context.themeColors, lnRef && lnRef !== 'none' ? lnRef : undefined) : undefined;
	const outline = lnFill ?? lnRef;
	let outlineWidth = outline && outline !== 'none' ? 1 : 0;
	const lineWidthEmu = ln ? intAttr(ln, 'w', 0) : 0;
	if (outlineWidth > 0 && lineWidthEmu > 0) {
		// EMU(1/12700 pt) → pt → px(96/72)
		outlineWidth = (lineWidthEmu / 12700) * (96 / 72);
	}
	const dash = ln ? xmlAttr(xmlChild(ln, 'prstDash') ?? ln, 'val') || 'solid' : 'solid';
	const fillRef = styleRef(el, 'fillRef', context.themeColors);
	const fill = isLine ? undefined : resolveFill(spPr, context.themeColors, fillRef && fillRef !== 'none' ? fillRef : undefined) ?? fillRef;
	const headEnd = ln ? xmlAttr(xmlChild(ln, 'headEnd') ?? ln, 'type') : '';
	const tailEnd = ln ? xmlAttr(xmlChild(ln, 'tailEnd') ?? ln, 'type') : '';
	const text = isLine ? undefined : parseText(el, context.themeColors);
	if (!reserveShape(context, name, box)) {
		return;
	}
	const shape: IParadisRenderShape = {
		type: isLine ? 'line' : 'rect',
		...transformOf(xfrm),
		from: box.from,
		to: box.to,
		...(box.ext ? { ext: box.ext } : {}),
		outlineWidth,
		outlineColor: outline && outline !== 'none' ? outline.color : '#000000',
		dash,
		name,
		shapeId,
		...(geometry ? { geometry } : {}),
		...(adjust.length > 0 && adjust.every(Number.isFinite) ? { adjust } : {}),
		...(paths ? { paths } : {}),
		...(fill && fill !== 'none' ? { fill: fill.color, ...(fill.alpha < 1 ? { fillOpacity: fill.alpha } : {}) } : {}),
		...(text ? { text } : {}),
		...(headEnd && headEnd !== 'none' ? { headEnd } : {}),
		...(tailEnd && tailEnd !== 'none' ? { tailEnd } : {}),
		...frameField(frame),
		...groupField(space),
	};
	context.shapes.push(shape);
	if (approximated) {
		context.undrawn.push({ kind: 'geometry', ...(name ? { name } : {}), from: box.from });
	}
}

function parsePicture(el: Element, box: AnchorBox, space: GroupSpace | undefined, context: ParseContext): void {
	const { name, shapeId, hidden } = cNvPrOf(xmlChild(el, 'nvPicPr'));
	if (hidden) {
		return;
	}
	const blip = xmlChild(xmlChild(el, 'blipFill'), 'blip');
	const href = context.media[relationshipId(blip, 'embed')];
	if (!href) {
		// EMF・WMF など、表示できない形式か、見つからない画像。
		context.undrawn.push({ kind: 'image', ...(name ? { name } : {}), from: box.from });
		return;
	}
	const spPr = xmlChild(el, 'spPr');
	const xfrm = xmlChild(spPr, 'xfrm');
	if (!reserveShape(context, name, box)) {
		return;
	}
	context.shapes.push({
		type: 'image', ...transformOf(xfrm), from: box.from, to: box.to, outlineWidth: 0, outlineColor: '#000', dash: 'solid', href,
		...(box.ext ? { ext: box.ext } : {}), name, shapeId, ...frameField(childFrame(xfrm, space)), ...groupField(space),
	});
}

function parseGroup(el: Element, box: AnchorBox, space: GroupSpace | undefined, context: ParseContext): void {
	const { name, hidden } = cNvPrOf(xmlChild(el, 'nvGrpSpPr'));
	if (hidden) {
		return;
	}
	const depth = (space?.depth ?? 0) + 1;
	if (depth > context.limits.groupDepth) {
		context.undrawn.push({ kind: 'overLimit', ...(name ? { name } : {}), from: box.from });
		return;
	}
	const xfrm = xmlChild(xmlChild(el, 'grpSpPr'), 'xfrm');
	const frame = childFrame(xfrm, space) ?? FULL_FRAME;
	const chOff = xmlChild(xfrm, 'chOff');
	const chExt = xmlChild(xfrm, 'chExt');
	const ext = xmlChild(xfrm, 'ext');
	const off = xmlChild(xfrm, 'off');
	// グループの回転・反転は、グループの枠の中心まわりに中の図形すべてへ掛かる（Part 1 §20.1.7.5）。
	const { flipH, flipV, rotation } = transformOf(xfrm);
	const transform: IParadisShapeGroupTransform | undefined = flipH || flipV || rotation
		? { frame, ...(rotation ? { rotation } : {}), ...(flipH ? { flipH } : {}), ...(flipV ? { flipV } : {}) }
		: undefined;
	const inner: GroupSpace = {
		frame,
		depth,
		transforms: transform ? [...(space?.transforms ?? []), transform] : space?.transforms ?? [],
		offX: intAttr(chOff ?? off, 'x', 0),
		offY: intAttr(chOff ?? off, 'y', 0),
		extX: intAttr(chExt ?? ext, 'cx', 0),
		extY: intAttr(chExt ?? ext, 'cy', 0),
	};
	for (const child of xmlChildren(el)) {
		if (child.localName !== 'nvGrpSpPr' && child.localName !== 'grpSpPr') {
			parseShapeElement(child, box, inner, context);
		}
	}
}

function parseGraphicFrame(el: Element, box: AnchorBox, space: GroupSpace | undefined, context: ParseContext): void {
	const { name, shapeId, hidden } = cNvPrOf(xmlChild(el, 'nvGraphicFramePr'));
	if (hidden) {
		return;
	}
	const graphicData = xmlChild(xmlChild(el, 'graphic'), 'graphicData');
	const uri = graphicData ? xmlAttr(graphicData, 'uri') : '';
	const chartRef = uri === 'http://schemas.openxmlformats.org/drawingml/2006/chart' ? xmlChild(graphicData, 'chart') : null;
	const chartId = chartRef ? relationshipId(chartRef, 'id') : '';
	// 関係の id は文書が決めるので、`__proto__` などで継承した値を拾わないよう自分の項目だけを引く。
	const xml = chartRef && Object.hasOwn(context.charts, chartId) ? context.charts[chartId] : undefined;
	let chart = xml !== undefined ? context.chartBudget.parsed.get(xml) : undefined;
	if (xml !== undefined && !context.chartBudget.parsed.has(xml)) {
		chart = parseChartXml(xml, context, context.limits);
		context.chartBudget.parsed.set(xml, chart);
	}
	if (chart && chart !== 'overLimit') {
		// 同じグラフを何度参照しても、描く点はシート全体で数える。
		context.chartBudget.points += chartPointCount(chart);
		if (context.chartBudget.points > (context.limits.chartPointsPerSheet ?? Number.POSITIVE_INFINITY)) {
			chart = 'overLimit';
		} else {
			// データラベルもシート全体で数える。越えたらこのグラフのラベルを省く。
			const labels = paradisChartLabelCount(chart);
			if (labels > 0 && context.chartBudget.labels + labels > (context.limits.chartLabelsPerSheet ?? Number.POSITIVE_INFINITY)) {
				chart = withoutParadisChartLabels(chart);
			} else {
				context.chartBudget.labels += labels;
			}
		}
	}
	if (!chart || chart === 'overLimit') {
		context.undrawn.push({ kind: chart === 'overLimit' ? 'overLimit' : chartRef ? 'chart' : 'graphicFrame', ...(name ? { name } : {}), from: box.from });
		return;
	}
	if (!reserveShape(context, name, box)) {
		return;
	}
	if (chart.labelsOmitted) {
		context.undrawn.push({ kind: 'chartLabels', ...(name ? { name } : {}), from: box.from });
	}
	context.shapes.push({
		type: 'chart', flipH: false, flipV: false, from: box.from, to: box.to, outlineWidth: 0, outlineColor: '#000', dash: 'solid',
		...(box.ext ? { ext: box.ext } : {}), name, shapeId, chart, ...frameField(childFrame(xmlChild(el, 'xfrm'), space)), ...groupField(space),
	});
}

/** グラフが描く点の数（値とバブルの大きさ）。 */
function chartPointCount(chart: IParadisChartData): number {
	let count = 0;
	for (const group of chart.groups) {
		for (const series of group.series) {
			count += Math.max(series.values.length, series.categories.length) + (series.bubbleSizes?.length ?? 0);
		}
	}
	return count;
}

/** 既定の系列の色。テーマの accent1〜6 を順に使い、7 番目からは暗くして回す（Excel の既定の並び）。 */
function chartPalette(themeColors: ParadisShapeThemeColors | undefined, index: number): string {
	const name = `accent${(index % 6) + 1}`;
	const base = themeColors?.[name] || SHAPE_THEME_COLORS[name];
	const cycle = Math.floor(index / 6);
	const rgb = hexToRgb(base);
	return cycle === 0 || !rgb ? base : rgbToHex(rgb.map(channel => channel * Math.max(0.4, 1 - 0.25 * cycle)));
}

/** グラフの部品（系列・点）の spPr の塗り、無ければ線の色。 */
function chartPartColor(part: Element | null, themeColors: ParadisShapeThemeColors | undefined): string | undefined {
	const spPr = xmlChild(part, 'spPr');
	const fill = resolveFill(spPr, themeColors) ?? resolveFill(xmlChild(spPr, 'ln'), themeColors);
	return fill && fill !== 'none' ? fill.color : undefined;
}

/**
 * chartN.xml の保存済みの値（numCache・strCache）からグラフを組み立てる。描けない種類が混ざれば undefined、
 * 系列や点が上限を越えれば `overLimit`。読み方は paradisSpreadsheetChartParser.ts にある。
 */
export function parseChartXml(xml: string, context: Pick<ParseContext, 'parser' | 'themeColors'>, limits: Pick<ParadisSpreadsheetDrawingLimits, 'chartSeries' | 'chartPoints'> = PARADIS_SPREADSHEET_DRAWING_LIMITS): IParadisChartData | 'overLimit' | undefined {
	let doc: Document;
	try {
		const trusted = ttPolicy?.createHTML(xml) ?? xml;
		doc = context.parser.parseFromString(trusted as unknown as string, 'application/xml');
	} catch {
		return undefined;
	}
	return parseParadisChartDocument(doc, {
		color: part => chartPartColor(part, context.themeColors),
		palette: index => chartPalette(context.themeColors, index),
	}, limits);
}


function parseAnchor(anchor: Element, context: ParseContext): void {
	let box: AnchorBox;
	if (anchor.localName === 'absoluteAnchor') {
		const pos = xmlChild(anchor, 'pos');
		const extEl = xmlChild(anchor, 'ext');
		if (!pos || !extEl) {
			return;
		}
		const origin = { c: 0, co: intAttr(pos, 'x', 0), r: 0, ro: intAttr(pos, 'y', 0) };
		box = { from: origin, to: origin, ext: { cx: intAttr(extEl, 'cx', 0), cy: intAttr(extEl, 'cy', 0) } };
	} else {
		const from = xmlChild(anchor, 'from');
		if (!from) {
			return;
		}
		const toEl = xmlChild(anchor, 'to');
		const extEl = xmlChild(anchor, 'ext');
		const fromAnchor = parseAnchorPosition(from);
		box = {
			from: fromAnchor,
			to: toEl ? parseAnchorPosition(toEl) : fromAnchor,
			...(extEl ? { ext: { cx: intAttr(extEl, 'cx', 0), cy: intAttr(extEl, 'cy', 0) } } : {}),
		};
	}
	for (const child of xmlChildren(anchor)) {
		parseShapeElement(child, box, undefined, context);
	}
}

/** drawing(XML + 埋め込みメディア + グラフ)群を解析して、描く図形と描けなかった図形を返す。 */
export function parseDrawingObjects(drawings: readonly IParadisDrawingData[] | undefined, themeColors?: ParadisShapeThemeColors, limits: ParadisSpreadsheetDrawingLimits = PARADIS_SPREADSHEET_DRAWING_LIMITS): { readonly shapes: IParadisRenderShape[]; readonly undrawn: IParadisUndrawnObject[] } {
	const shapes: IParadisRenderShape[] = [];
	const undrawn: IParadisUndrawnObject[] = [];
	if (!drawings || drawings.length === 0) {
		return { shapes, undrawn };
	}
	const parser = new DOMParser();
	const chartBudget = { points: 0, labels: 0, parsed: new Map<string, IParadisChartData | 'overLimit' | undefined>() };
	for (const { xml, media, charts, omitted } of drawings) {
		if (omitted) {
			undrawn.push({ kind: 'overLimit' });
			continue;
		}
		let doc: Document;
		try {
			const trusted = ttPolicy?.createHTML(xml) ?? xml;
			doc = parser.parseFromString(trusted as unknown as string, 'application/xml');
		} catch {
			continue;
		}
		const context: ParseContext = { limits, media, charts: charts ?? {}, themeColors, parser, shapes, undrawn, chartBudget };
		const visit = (el: Element) => {
			for (const child of xmlChildren(el)) {
				if (child.localName === 'twoCellAnchor' || child.localName === 'oneCellAnchor' || child.localName === 'absoluteAnchor') {
					parseAnchor(child, context);
				} else if (child.localName === 'AlternateContent') {
					// アンカーそのものを包む AlternateContent。図形の中のものと同じ選び方をする。
					const choice = xmlChildren(child, 'Choice').find(branch => xmlAttr(branch, 'Requires').split(/\s+/).every(prefix => SUPPORTED_MC_PREFIXES.has(prefix)));
					const branch = choice ?? xmlChild(child, 'Fallback');
					if (branch) {
						visit(branch);
					}
				}
			}
		};
		if (doc.documentElement) {
			visit(doc.documentElement);
		}
	}
	return { shapes, undrawn };
}

/** 描けなかった図形を、代替表示の項目にする。描いた図形は数えない。 */
export function spreadsheetUndrawnPlaceholders(sheets: readonly IParadisSheetData[]): ParadisOfficePlaceholder[] {
	const placeholders: ParadisOfficePlaceholder[] = [];
	for (const sheet of sheets) {
		(sheet.undrawnObjects ?? []).forEach((object, index) => {
			placeholders.push({
				nodeId: `${sheet.name}!object:${object.name ?? `${object.kind}-${index + 1}`}`,
				feature: `drawing.${object.kind}`,
				reason: 'unsupported',
				title: object.name ?? localize('paradis.spreadsheet.drawingObject', "図形"),
				detail: undrawnDetail(object.kind),
			});
		});
	}
	return placeholders;
}

function undrawnDetail(kind: IParadisUndrawnObject['kind']): string {
	switch (kind) {
		case 'image': return localize('paradis.spreadsheet.undrawnImage', "この形式の画像（EMF・WMF など）は表示できません。");
		case 'chart': return localize('paradis.spreadsheet.undrawnChart', "この種類のグラフは表示できません。");
		case 'geometry': return localize('paradis.spreadsheet.undrawnGeometry', "この形の図形は、枠の形で近似して表示しています。");
		case 'overLimit': return localize('paradis.spreadsheet.undrawnOverLimit', "図形が多すぎるか複雑すぎるため、表示していません。");
		case 'chartLabels': return localize('paradis.spreadsheet.undrawnChartLabels', "データラベルが多すぎるため、グラフのラベルを省いて表示しています。");
		default: return localize('paradis.spreadsheet.undrawnObject', "この図形は表示できません。");
	}
}
