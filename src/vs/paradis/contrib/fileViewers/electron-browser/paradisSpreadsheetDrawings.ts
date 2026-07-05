/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// xlsx の drawing XML(shared process から文字列で渡ってくる)を DOMParser で解析し、図形(直線コネクタ/矩形)へ変換する。
// 既存の別実装の drawing 解析部の移植。セル上の斜線もこの直線コネクタで表現される。

import { createTrustedTypesPolicy } from '../../../../base/browser/trustedTypes.js';
import { IParadisDrawingData, IParadisRenderAnchor, IParadisRenderShape } from '../common/paradisSpreadsheet.js';

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

function resolveXmlColor(el: Element | null, themeColors: ParadisShapeThemeColors | undefined): string {
	if (!el) {
		return '#000000';
	}
	const srgb = xmlChild(el, 'srgbClr');
	if (srgb) {
		return `#${xmlAttr(srgb, 'val')}`;
	}
	const scheme = xmlChild(el, 'schemeClr');
	if (scheme) {
		const name = xmlAttr(scheme, 'val');
		return themeColors?.[name] || SHAPE_THEME_COLORS[name] || '#000000';
	}
	return '#000000';
}

function cNvPrOf(container: Element | null): { name?: string; shapeId?: string } {
	const cNvPr = container ? xmlChild(container, 'cNvPr') : null;
	if (!cNvPr) {
		return {};
	}
	return { name: xmlAttr(cNvPr, 'name') || undefined, shapeId: xmlAttr(cNvPr, 'id') || undefined };
}

function parseShapeFromAnchor(anchor: Element, media: { readonly [rid: string]: string }, themeColors: ParadisShapeThemeColors | undefined): IParadisRenderShape | null {
	const from = xmlChild(anchor, 'from');
	if (!from) {
		return null;
	}
	const toEl = xmlChild(anchor, 'to');
	const extEl = xmlChild(anchor, 'ext');
	const fromAnchor = parseAnchorPosition(from);
	const toAnchor = toEl ? parseAnchorPosition(toEl) : fromAnchor;
	const ext = extEl ? { cx: Number.parseInt(xmlAttr(extEl, 'cx') || '0', 10), cy: Number.parseInt(xmlAttr(extEl, 'cy') || '0', 10) } : undefined;

	// 画像(xdr:pic)
	const pic = xmlChild(anchor, 'pic');
	if (pic) {
		const blipFill = xmlChild(pic, 'blipFill');
		const blip = blipFill ? xmlChild(blipFill, 'blip') : null;
		const rid = blip ? (blip.getAttribute('r:embed') || blip.getAttribute('embed') || '') : '';
		const href = rid ? media[rid] : undefined;
		if (!href) {
			return null;
		}
		const { name, shapeId } = cNvPrOf(xmlChild(pic, 'nvPicPr'));
		return { type: 'image', flipV: false, flipH: false, from: fromAnchor, to: toAnchor, outlineWidth: 0, outlineColor: '#000', dash: 'solid', href, ext, name, shapeId };
	}

	// 図形(sp/cxnSp): 直線コネクタ・矩形
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
			lineColor = resolveXmlColor(fill, themeColors);
		}
		const dash = xmlChild(ln, 'prstDash');
		if (dash) {
			lineDash = xmlAttr(dash, 'val') || 'solid';
		}
	}

	const { name, shapeId } = cNvPrOf(xmlChild(sp, 'nvSpPr') || xmlChild(sp, 'nvCxnSpPr'));
	return {
		type: isLine ? 'line' : 'rect',
		flipV,
		flipH,
		from: fromAnchor,
		to: toAnchor,
		outlineWidth: lineWidth,
		outlineColor: lineColor,
		dash: lineDash,
		name,
		shapeId,
	};
}

/** drawing(XML + 埋め込みメディア)群を解析して図形配列(直線/矩形/画像)を返す。 */
export function parseDrawingShapes(drawings: readonly IParadisDrawingData[] | undefined, themeColors?: ParadisShapeThemeColors): IParadisRenderShape[] {
	if (!drawings || drawings.length === 0) {
		return [];
	}
	const parser = new DOMParser();
	const shapes: IParadisRenderShape[] = [];
	for (const { xml, media } of drawings) {
		let doc: Document;
		try {
			const trusted = ttPolicy?.createHTML(xml) ?? xml;
			doc = parser.parseFromString(trusted as unknown as string, 'application/xml');
		} catch {
			continue;
		}
		for (const tag of ['twoCellAnchor', 'oneCellAnchor']) {
			// eslint-disable-next-line no-restricted-syntax -- DOMParser で生成した分離ドキュメントの走査(ライブDOMではない)
			const anchors = doc.getElementsByTagNameNS('*', tag);
			for (let i = 0; i < anchors.length; i++) {
				const shape = parseShapeFromAnchor(anchors[i], media, themeColors);
				if (shape) {
					shapes.push(shape);
				}
			}
		}
	}
	return shapes;
}
