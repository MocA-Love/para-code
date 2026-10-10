/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * モバイルへ送る HTML から、`<img src="data:...">` で埋め込んだ大きな画像を抜く（Q325 案 A）。
 *
 * 本文は軽くなり（20 MiB の上限に収まる）、画像はアプリが見えたときに 1 枚ずつ取り寄せる。抜いた場所の
 * `src` には、元の画像と同じ縦横を持つ空の SVG を置く。読み込んだ画像の大きさが元と同じなので、レイアウト・
 * 遅延読み込みの時機・`naturalWidth` は元と変わらない。アプリは届いた画像を元の `data:` の文字列のまま戻すので、
 * スクリプトから見える `src` と canvas の読み出しも元と同じになる（調査: mobile-html-image-split-research.html）。
 *
 * 抜くのは、`<script>`・`<style>` の外にあり、`srcset` が無く、`<picture>` の外にある `img` で、`data:` の
 * 文字列が {@link PARADIS_MOBILE_HTML_IMAGE_MIN_CHARS} 以上・{@link PARADIS_MOBILE_HTML_IMAGE_MAX_CHARS} 以下、
 * 見出しから縦横が読めるものだけ。それ以外（CSS の `url()`・`srcset`・`<a href="data:...">` など）は元のまま残す。
 *
 * PC の側だけで使う純関数（ファイルもサービスも読まない）。
 */

import { decodeBase64 } from '../../../../base/common/buffer.js';
import { paradisReadImageDimensions } from './paradisMobileAttachment.js';

/** これより短い `data:` の文字列は抜かない（本文はほとんど軽くならず、取り寄せの往復だけが増える）。 */
export const PARADIS_MOBILE_HTML_IMAGE_MIN_CHARS = 16 * 1024;
/** 1 枚で送れる `data:` の文字列の上限（リレーの 1 応答に収める）。これより長い画像は本文に残す。 */
export const PARADIS_MOBILE_HTML_IMAGE_MAX_CHARS = 16 * 1024 * 1024;
/** 1 つの文書から抜く画像の数の上限。超えた分は本文に残す。 */
export const PARADIS_MOBILE_HTML_IMAGE_MAX_COUNT = 2_000;
/** 抜いた `img` に付ける印（値は画像の番号）。アプリの取り寄せの仕組みが読む。 */
export const PARADIS_MOBILE_HTML_IMAGE_ATTRIBUTE = 'data-paradis-img';

export interface IParadisMobileHtmlImageSplit {
	/** 画像を抜いた本文。 */
	readonly html: string;
	/** 抜いた画像の `data:` の文字列（番号順）。 */
	readonly images: readonly string[];
}

/** 画像を抜く。抜く画像が 1 枚も無ければ `undefined`（元の本文をそのまま送る）。 */
export function paradisSplitMobileHtmlImages(html: string): IParadisMobileHtmlImageSplit | undefined {
	const images: string[] = [];
	// <script> と <style> の中は書き換えない（文字列の中の data: や、CSS の url() を壊さない）。
	const parts = html.split(/(<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->)/i);
	let pictureDepth = 0;
	for (let index = 0; index < parts.length; index += 2) {
		parts[index] = parts[index].replace(/<(\/?)picture\b[^>]*>|<img\b[^>]*>/gi, (tag: string, close: string | undefined) => {
			if (!/^<img\b/i.test(tag)) {
				pictureDepth = Math.max(0, pictureDepth + (close ? -1 : 1));
				return tag;
			}
			if (pictureDepth > 0 || images.length >= PARADIS_MOBILE_HTML_IMAGE_MAX_COUNT || /\s(?:srcset|data-paradis-img)\s*=/i.test(tag)) {
				return tag;
			}
			const source = /\ssrc\s*=\s*(?<quote>["'])(?<value>data:image\/[a-z0-9.+-]+;base64,(?<payload>[A-Za-z0-9+/=\s]+))\k<quote>/i.exec(tag);
			const value = source?.groups?.value;
			const payload = source?.groups?.payload;
			if (source === null || value === undefined || payload === undefined || value.length < PARADIS_MOBILE_HTML_IMAGE_MIN_CHARS || value.length > PARADIS_MOBILE_HTML_IMAGE_MAX_CHARS) {
				return tag;
			}
			const size = paradisReadDataImageSize(payload);
			if (size === undefined) {
				return tag;
			}
			const id = images.length;
			images.push(value);
			const placeholder = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${size.width}' height='${size.height}'/%3E`;
			// 元の属性の並びはそのまま。`src` の値だけを替え、印を先頭に足す。
			return tag.replace(source[0], ` src="${placeholder}"`).replace(/^<img\b/i, `<img ${PARADIS_MOBILE_HTML_IMAGE_ATTRIBUTE}="${id}"`);
		});
	}
	return images.length > 0 ? { html: parts.join(''), images } : undefined;
}

/** 見出しを読むために戻す、base64 の先頭の長さ（4 の倍数。64 KiB 分）。JPEG の SOF が後ろにあっても届く。 */
const HEADER_BASE64_CHARS = 64 * 1024 / 3 * 4;

/** 画像の見出しから縦横を読む（PNG・GIF・JPEG・WebP）。全体は戻さない。読めなければ `undefined`。 */
export function paradisReadDataImageSize(base64: string): { readonly width: number; readonly height: number } | undefined {
	const compact = base64.length > HEADER_BASE64_CHARS * 2 ? base64.slice(0, HEADER_BASE64_CHARS * 2).replace(/\s+/g, '') : base64.replace(/\s+/g, '');
	const prefix = compact.slice(0, HEADER_BASE64_CHARS);
	let bytes: Uint8Array;
	try {
		bytes = decodeBase64(prefix.length % 4 === 0 ? prefix : prefix.slice(0, prefix.length - prefix.length % 4)).buffer;
	} catch {
		return undefined;
	}
	const size = paradisReadImageDimensions(bytes);
	return size !== undefined && size.width <= 65_535 && size.height <= 65_535 ? size : undefined;
}
