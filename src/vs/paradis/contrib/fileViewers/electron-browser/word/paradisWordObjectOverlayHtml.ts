/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// docx-preview が描けない図形(グラフ・SmartArt・図形・テキストボックス・OLE)を SVG にして、
// webview へ渡せる形にする。
//
// docx-preview は理解できない <w:drawing> でも「extent の大きさを持つ空の inline-block div」を
// 出力する(renderDrawing)。そこがそのまま差し込み先になるので、図形ごとに独立した SVG を作り、
// 中身がその枠にちょうど収まるよう viewBox を合わせる。

import { renderWordObjectOverlay, resolveWordObjectGeometry } from './paradisWordObjectRenderer.js';
import type { ParadisWordRenderableObject } from '../../common/word/paradisWordRenderableObjects.js';

/** EMU→CSS px。docx-preview の extent 換算と同じ係数。 */
const EMU_PER_PIXEL = 9_525;

/** webview へ渡す1件分。差し込み先の照合に使う寸法を併せて持つ。 */
export interface IParadisWordOverlayItem {
	/** 図形の安定 ID(照合の失敗時に原因を追うため)。 */
	readonly id: string;
	readonly kind: string;
	/** 差し込み先の枠と突き合わせる大きさ(CSS px)。 */
	readonly width: number;
	readonly height: number;
	/** そのまま innerHTML に入れられる SVG。 */
	readonly svg: string;
}

function emuToPixels(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value)) {
		return undefined;
	}
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed / EMU_PER_PIXEL : undefined;
}

/** docx-preview が枠の大きさに使う extent。transform の extent より wp:extent が優先される。 */
function containerSize(object: ParadisWordRenderableObject): { readonly width: number; readonly height: number } | undefined {
	const width = emuToPixels(object.geometry.extent?.cx);
	const height = emuToPixels(object.geometry.extent?.cy);
	return width === undefined || height === undefined ? undefined : { width, height };
}

/**
 * 図形ごとに SVG を作る。描画できなかったもの(位置が解けない等)は落とす。
 * `document` は表示中の文書とは別の切り離した Document を渡すこと。
 */
export function buildParadisWordOverlayItems(
	objects: readonly ParadisWordRenderableObject[],
	document: Document,
): readonly IParadisWordOverlayItem[] {
	const items: IParadisWordOverlayItem[] = [];
	const serializer = new XMLSerializer();
	for (const object of objects) {
		const size = containerSize(object);
		const geometry = resolveWordObjectGeometry(object.geometry);
		if (!size || !geometry || size.width <= 0 || size.height <= 0) {
			continue;
		}
		const { element } = renderWordObjectOverlay([object], { document, assets: new Map() });
		if (element.childElementCount === 0) {
			continue;
		}
		// 中身は図形自身の座標系で描かれているので、その矩形を枠いっぱいに映す。
		const { x, y, width, height } = geometry.bounds;
		element.setAttribute('viewBox', `${x} ${y} ${Math.max(width, 1)} ${Math.max(height, 1)}`);
		element.setAttribute('width', '100%');
		element.setAttribute('height', '100%');
		element.setAttribute('preserveAspectRatio', 'none');
		element.setAttribute('focusable', 'false');
		element.setAttribute('aria-hidden', 'true');
		items.push({
			id: object.id,
			kind: object.kind,
			width: size.width,
			height: size.height,
			svg: serializer.serializeToString(element),
		});
	}
	return items;
}

/**
 * webview の HTML へ安全に埋め込める JSON にする。
 * `</script>` や U+2028/2029 でスクリプトを抜け出せないようにエスケープする。
 */
export function encodeParadisWordOverlayPayload(items: readonly IParadisWordOverlayItem[]): string {
	return JSON.stringify(items)
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}
