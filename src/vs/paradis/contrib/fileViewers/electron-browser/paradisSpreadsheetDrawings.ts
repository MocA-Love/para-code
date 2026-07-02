/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// xlsx の drawing XML(shared process から文字列で渡ってくる)を DOMParser で解析し、図形(直線コネクタ/矩形)へ変換する。
// Superset apps/desktop の parseWorkbook.ts の drawing 解析部の移植。重要事項説明書等の「斜線」はこの直線コネクタで表現される。

import { createTrustedTypesPolicy } from '../../../../base/browser/trustedTypes.js';
import { IParadisRenderAnchor, IParadisRenderShape } from '../common/paradisSpreadsheet.js';

// VS Code workbench は Trusted Types を強制しており、DOMParser.parseFromString に生文字列を渡すとブロックされる。
// upstream の htmlToMarkdown.ts と同じく、専用ポリシーで文字列を Trusted 化してから渡す。
const ttPolicy = createTrustedTypesPolicy('paradisSpreadsheetDrawings', { createHTML: value => value });

// 図形の schemeClr 用の標準Officeテーマ色。
const SHAPE_THEME_COLORS: Record<string, string> = {
	lt1: '#FFFFFF', dk1: '#000000', lt2: '#E7E6E6', dk2: '#44546A',
	accent1: '#4472C4', accent2: '#ED7D31', accent3: '#A5A5A5',
	accent4: '#FFC000', accent5: '#5B9BD5', accent6: '#70AD47',
};

function xmlAttr(el: Element, name: string): string {
	return el.getAttribute(name) || '';
}

function xmlChild(el: Element, localName: string): Element | null {
	for (let i = 0; i < el.children.length; i++) {
		const child = el.children[i];
		if (child.localName === localName) {
			return child;
		}
	}
	return null;
}

function xmlText(el: Element, localName: string): string {
	const child = xmlChild(el, localName);
	return child?.textContent?.trim() || '0';
}

function parseAnchorPosition(el: Element): IParadisRenderAnchor {
	return {
		c: Number.parseInt(xmlText(el, 'col'), 10),
		co: Number.parseInt(xmlText(el, 'colOff'), 10),
		r: Number.parseInt(xmlText(el, 'row'), 10),
		ro: Number.parseInt(xmlText(el, 'rowOff'), 10),
	};
}

function resolveXmlColor(el: Element | null): string {
	if (!el) {
		return '#000000';
	}
	const srgb = xmlChild(el, 'srgbClr');
	if (srgb) {
		return `#${xmlAttr(srgb, 'val')}`;
	}
	const scheme = xmlChild(el, 'schemeClr');
	if (scheme) {
		return SHAPE_THEME_COLORS[xmlAttr(scheme, 'val')] || '#000000';
	}
	return '#000000';
}

function parseShapeFromAnchor(anchor: Element): IParadisRenderShape | null {
	const from = xmlChild(anchor, 'from');
	const to = xmlChild(anchor, 'to');
	if (!from || !to) {
		return null;
	}
	const sp = xmlChild(anchor, 'sp') || xmlChild(anchor, 'cxnSp');
	if (!sp) {
		return null;
	}
	const spPr = xmlChild(sp, 'spPr');
	if (!spPr) {
		return null;
	}
	const prstGeom = xmlChild(spPr, 'prstGeom');
	const prst = prstGeom ? xmlAttr(prstGeom, 'prst') : '';
	const isLine = prst === 'line' || prst === 'straightConnector1' || sp.localName === 'cxnSp';

	const xfrm = xmlChild(spPr, 'xfrm');
	const flipH = xfrm ? xmlAttr(xfrm, 'flipH') === '1' : false;
	const flipV = xfrm ? xmlAttr(xfrm, 'flipV') === '1' : false;

	const ln = xmlChild(spPr, 'ln');
	let lineWidth = 1;
	let lineColor = '#000000';
	let lineDash = 'solid';
	if (ln) {
		const w = xmlAttr(ln, 'w');
		if (w) {
			// EMU(1/12700 pt) → pt → px(96/72)
			lineWidth = (Number.parseInt(w, 10) / 12700) * (96 / 72);
		}
		const fill = xmlChild(ln, 'solidFill');
		if (fill) {
			lineColor = resolveXmlColor(fill);
		}
		const dash = xmlChild(ln, 'prstDash');
		if (dash) {
			lineDash = xmlAttr(dash, 'val') || 'solid';
		}
	}

	return {
		type: isLine ? 'line' : 'rect',
		flipV,
		flipH,
		from: parseAnchorPosition(from),
		to: parseAnchorPosition(to),
		outlineWidth: lineWidth,
		outlineColor: lineColor,
		dash: lineDash,
	};
}

/** drawing XML 文字列群を解析して図形配列を返す。 */
export function parseDrawingShapes(xmlStrings: readonly string[] | undefined): IParadisRenderShape[] {
	if (!xmlStrings || xmlStrings.length === 0) {
		return [];
	}
	const parser = new DOMParser();
	const shapes: IParadisRenderShape[] = [];
	for (const xml of xmlStrings) {
		let doc: Document;
		try {
			const trusted = ttPolicy?.createHTML(xml) ?? xml;
			doc = parser.parseFromString(trusted as unknown as string, 'application/xml');
		} catch {
			continue;
		}
		// eslint-disable-next-line no-restricted-syntax -- DOMParser で生成した分離ドキュメントの走査(ライブDOMではない)
		const anchors = doc.getElementsByTagNameNS('*', 'twoCellAnchor');
		for (let i = 0; i < anchors.length; i++) {
			const shape = parseShapeFromAnchor(anchors[i]);
			if (shape) {
				shapes.push(shape);
			}
		}
	}
	return shapes;
}
