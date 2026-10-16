/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 図形（drawing）の外枠が届く右端の列を求める。印刷範囲の右の余白に置いた吹き出しなどを見せるために、表示する
// 列をそこまで延ばすのに使う。外枠は枠（アンカー）に、形の道筋（吹き出しのしっぽなど枠の外へ伸びる分）・反転・
// 回転を足したもの。位置の求め方は renderer の makeAnchorResolver と同じ（列の左端 + オフセット、1px = 9525 EMU）。

import type { ParadisOfficeXmlNode } from '../office/paradisOfficeArchive.js';
import { parseParadisOfficeXml, type ParadisOfficeXmlLimits } from '../office/paradisOfficeCanonicalXml.js';
import { paradisShapeGeometry } from './paradisPresetShapeGeometry.js';

type XmlElement = Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>;

const EMU_PER_PX = 9525;
const XML_LIMITS: ParadisOfficeXmlLimits = { depth: 256, nodes: 2_000_000, attributeLength: 65_536, characters: 32 * 1024 * 1024 };
/** 枠の高さを行の高さの和で求めるときに数える行の上限。これより高い枠は、そこまでの高さとして扱う。 */
const MAX_ROWS_FOR_HEIGHT = 1_000;
/** 1 つの drawing で見る図形の上限。 */
const MAX_ANCHORS = 10_000;
/** 形の道筋（paradisShapeGeometry の出力）の命令ごとの数の個数。 */
const PATH_ARITY: Readonly<Record<string, number>> = { M: 2, L: 2, Q: 4, C: 6, A: 7, Z: 0 };

/** 列の幅と行の高さ（px、どちらも 1 始まり、非表示は 0）。 */
export interface IParadisDrawingExtentMetrics {
	columnWidth(column: number): number;
	rowHeight(row: number): number;
}

interface IAnchorPosition {
	readonly column: number;
	readonly columnOffset: number;
	readonly row: number;
	readonly rowOffset: number;
}

function children(element: XmlElement, local?: string): XmlElement[] {
	const result: XmlElement[] = [];
	for (const child of element.children) {
		if (child.kind === 'element' && (local === undefined || child.local === local)) {
			result.push(child);
		}
	}
	return result;
}

function child(element: XmlElement | undefined, local: string): XmlElement | undefined {
	return element ? children(element, local)[0] : undefined;
}

function attribute(element: XmlElement | undefined, local: string): string | undefined {
	return element?.attributes.find(candidate => candidate.uri === '' && candidate.local === local)?.value;
}

function textOf(element: XmlElement | undefined): string {
	let text = '';
	for (const node of element?.children ?? []) {
		if (node.kind === 'text') {
			text += node.value;
		}
	}
	return text.trim();
}

function integer(value: string | undefined): number {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isFinite(parsed) ? parsed : 0;
}

function anchorPosition(element: XmlElement | undefined): IAnchorPosition | undefined {
	if (!element) {
		return undefined;
	}
	return {
		column: Math.max(0, integer(textOf(child(element, 'col')))),
		columnOffset: integer(textOf(child(element, 'colOff'))),
		row: Math.max(0, integer(textOf(child(element, 'row')))),
		rowOffset: integer(textOf(child(element, 'rowOff'))),
	};
}

/** 調整値（`<a:gd name="adj1" fmla="val -62000"/>`）。 */
function adjustValues(geometry: XmlElement | undefined): Record<string, number> | undefined {
	const list = child(geometry, 'avLst');
	if (!list) {
		return undefined;
	}
	const result: Record<string, number> = {};
	for (const guide of children(list, 'gd')) {
		const name = attribute(guide, 'name');
		const match = /^val\s+(?<value>-?\d+)$/.exec(attribute(guide, 'fmla') ?? '');
		if (name && match?.groups) {
			result[name] = Number(match.groups.value);
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

/** 道筋の座標（端点と制御点）を拾う。円弧（A）は最後の 2 つが端点。 */
function pathPoints(d: string, visit: (x: number, y: number) => void): void {
	const tokens = d.split(' ');
	for (let index = 0; index < tokens.length;) {
		const command = tokens[index++];
		if (!Object.hasOwn(PATH_ARITY, command)) {
			return;
		}
		const count = PATH_ARITY[command];
		const values = tokens.slice(index, index + count).map(Number);
		index += count;
		const pairs = command === 'A' ? [values.slice(5)] : Array.from({ length: count / 2 }, (_, pair) => values.slice(pair * 2, pair * 2 + 2));
		for (const [x, y] of pairs) {
			if (Number.isFinite(x) && Number.isFinite(y)) {
				visit(x, y);
			}
		}
	}
}

/**
 * 枠（幅 `width`・高さ `height`）の中の図形が、左右へどれだけはみ出すか（px）。形の道筋・反転・回転を見る。
 * 形が分からなければ枠のまま。
 */
function horizontalOverhang(shape: XmlElement, width: number, height: number): { readonly left: number; readonly right: number } {
	const properties = child(shape, 'spPr');
	const transform = child(properties, 'xfrm');
	let minX = 0, maxX = width, minY = 0, maxY = height;
	const geometry = child(properties, 'prstGeom');
	const preset = attribute(geometry, 'prst');
	if (preset) {
		const result = paradisShapeGeometry(preset, { x: 0, y: 0, width, height }, adjustValues(geometry));
		for (const path of result?.paths ?? []) {
			pathPoints(path.d, (x, y) => {
				minX = Math.min(minX, x);
				maxX = Math.max(maxX, x);
				minY = Math.min(minY, y);
				maxY = Math.max(maxY, y);
			});
		}
	}
	if (attribute(transform, 'flipH') === '1' || attribute(transform, 'flipH') === 'true') {
		[minX, maxX] = [width - maxX, width - minX];
	}
	if (attribute(transform, 'flipV') === '1' || attribute(transform, 'flipV') === 'true') {
		[minY, maxY] = [height - maxY, height - minY];
	}
	const rotation = integer(attribute(transform, 'rot')) / 60000 * Math.PI / 180;
	if (rotation !== 0) {
		// 枠の中心のまわりに回した 4 隅。
		const cx = width / 2, cy = height / 2;
		const cos = Math.cos(rotation), sin = Math.sin(rotation);
		const xs = [[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]].map(([x, y]) => cx + (x - cx) * cos - (y - cy) * sin);
		minX = Math.min(...xs);
		maxX = Math.max(...xs);
	}
	return { left: Math.min(0, minX), right: Math.max(0, maxX - width) };
}

/**
 * drawing の XML の図形の外枠の右端が入る列（1 始まり）を返す。図形が無ければ undefined。`maxColumn` より右は
 * 数えず、そこで止める（極端に右へ置いた図形で表が大きくなりすぎないように）。読めない XML は無いものとして扱う。
 */
export function paradisDrawingRightmostColumn(xmls: readonly string[], metrics: IParadisDrawingExtentMetrics, maxColumn: number): number | undefined {
	// 列の左端（0 始まりの列 c の左端 = 1〜c 列の幅の和）。maxColumn までだけ持つ。
	const lefts: number[] = [0];
	const columnLeft = (column: number): number => {
		const target = Math.min(column, maxColumn);
		while (lefts.length <= target) {
			lefts.push(lefts[lefts.length - 1] + Math.max(0, metrics.columnWidth(lefts.length)));
		}
		return lefts[target];
	};
	const rowsHeight = (from: number, to: number): number => {
		let height = 0;
		for (let row = from; row < to && row < from + MAX_ROWS_FOR_HEIGHT; row++) {
			height += Math.max(0, metrics.rowHeight(row + 1));
		}
		return height;
	};

	let right: number | undefined;
	let anchors = 0;
	const visit = (element: XmlElement) => {
		for (const node of children(element)) {
			if (anchors >= MAX_ANCHORS) {
				return;
			}
			if (node.local === 'AlternateContent') {
				const branch = child(node, 'Choice') ?? child(node, 'Fallback');
				if (branch) {
					visit(branch);
				}
				continue;
			}
			if (node.local !== 'twoCellAnchor' && node.local !== 'oneCellAnchor' && node.local !== 'absoluteAnchor') {
				continue;
			}
			anchors++;
			const extent = child(node, 'ext');
			let left: number, width: number, height: number;
			if (node.local === 'absoluteAnchor') {
				left = integer(attribute(child(node, 'pos'), 'x')) / EMU_PER_PX;
				width = integer(attribute(extent, 'cx')) / EMU_PER_PX;
				height = integer(attribute(extent, 'cy')) / EMU_PER_PX;
			} else {
				const from = anchorPosition(child(node, 'from'));
				if (!from) {
					continue;
				}
				left = columnLeft(from.column) + from.columnOffset / EMU_PER_PX;
				const to = node.local === 'twoCellAnchor' ? anchorPosition(child(node, 'to')) : undefined;
				if (to) {
					width = columnLeft(to.column) + to.columnOffset / EMU_PER_PX - left;
					height = rowsHeight(from.row, to.row) - from.rowOffset / EMU_PER_PX + to.rowOffset / EMU_PER_PX;
				} else {
					width = integer(attribute(extent, 'cx')) / EMU_PER_PX;
					height = integer(attribute(extent, 'cy')) / EMU_PER_PX;
				}
			}
			width = Math.max(0, width);
			height = Math.max(0, height);
			// 図形が 1 つ（sp・cxnSp・pic）なら形を見る。グループや表・グラフは枠のまま。
			const shape = children(node).find(candidate => candidate.local === 'sp' || candidate.local === 'cxnSp' || candidate.local === 'pic');
			const overhang = shape ? horizontalOverhang(shape, width, height) : { left: 0, right: 0 };
			const shapeRight = left + width + overhang.right;
			if (Number.isFinite(shapeRight)) {
				right = Math.max(right ?? 0, shapeRight);
			}
		}
	};
	for (const xml of xmls) {
		if (!xml) {
			continue;
		}
		try {
			visit(parseParadisOfficeXml(xml, XML_LIMITS).root);
		} catch {
			// 読めない drawing は描けないので、列を延ばす理由にもならない。
		}
	}
	if (right === undefined) {
		return undefined;
	}
	// 右端を含む列。右端がちょうど列の境目なら、その左の列で足りる。
	let column = 1;
	while (column < maxColumn && columnLeft(column) < right) {
		column++;
	}
	return column;
}
