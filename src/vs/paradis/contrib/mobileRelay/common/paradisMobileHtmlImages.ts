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
 * 抜くのは、`<script>`・`<style>`・`<textarea>`・`<template>`・`<noscript>`・`<title>`・コメントなどの外にあり、`srcset` が無く、`<picture>` の外にある `img` で、`data:` の
 * 文字列が {@link PARADIS_MOBILE_HTML_IMAGE_MIN_CHARS} 以上・{@link PARADIS_MOBILE_HTML_IMAGE_MAX_CHARS} 以下、
 * 見出しから縦横が読めるものだけ。それ以外（CSS の `url()`・`srcset`・`<a href="data:...">` など）は元のまま残す。
 *
 * PC の側だけで使う純関数（ファイルもサービスも読まない）。
 */

import { decodeBase64 } from '../../../../base/common/buffer.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
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

/**
 * 中身を書き換えない要素（中の `<img` は文字列か、文書に入らない）。閉じのタグまで丸ごと飛ばす。
 * `<template>` の入れ子は数えない（最初の閉じまでを飛ばす。後ろの画像は抜かれうるが、印の付いた画像は
 * 取り寄せの仕組みが文書から見つけられず仮の画像のまま残るだけで、ほかを壊さない）。
 */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(['script', 'style', 'textarea', 'template', 'noscript', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);

/** 画像を抜く。抜く画像が 1 枚も無ければ `undefined`（元の本文をそのまま送る）。 */
export function paradisSplitMobileHtmlImages(html: string): IParadisMobileHtmlImageSplit | undefined {
	const steps = splitSteps(html);
	let step = steps.next();
	while (!step.done) {
		step = steps.next();
	}
	return step.value;
}

/**
 * {@link paradisSplitMobileHtmlImages} と同じ結果を、`sliceMs` ごとに手を離しながら作る（ウィンドウを固めない）。
 * 手を離すたびに `token` を見て、取り消されていたら {@link CancellationError} で抜ける。
 */
export async function paradisSplitMobileHtmlImagesSliced(html: string, token?: CancellationToken, sliceMs = 12): Promise<IParadisMobileHtmlImageSplit | undefined> {
	const steps = splitSteps(html);
	let sliceStart = Date.now();
	let step = steps.next();
	while (!step.done) {
		if (Date.now() - sliceStart >= sliceMs) {
			await new Promise<void>(resolve => setTimeout(resolve, 0));
			if (token?.isCancellationRequested) {
				throw new CancellationError();
			}
			sliceStart = Date.now();
		}
		step = steps.next();
	}
	return step.value;
}

/** 手を離してよい区切りまでに見るタグの数。 */
const STEP_TAGS = 2_048;

/**
 * 画像を抜く本体。{@link STEP_TAGS} 個のタグごと・画像 1 枚ごとに区切りを返す。
 *
 * 本文は先頭から一方向に 1 回だけ走る（`indexOf` と、後戻りしない正規表現の検索だけを使う）。閉じの無い `<!--`・
 * `<script`・`<img` などが見つかったら、そこから後ろは書き換えずに残して打ち切る（壊れた・細工された文書で
 * 何度も読み直さない）。
 */
function* splitSteps(html: string): Generator<void, IParadisMobileHtmlImageSplit | undefined> {
	if (html.indexOf('data:image/') === -1) {
		return undefined;
	}
	let tags = 0;
	const images: string[] = [];
	const out: string[] = [];
	// 見るのはコメントと、中身を飛ばす要素・`picture`・`img` の始まりだけ（ほかのタグは正規表現の中で読み飛ばす）
	const endTags = new Map<string, RegExp>();
	const interesting = new RegExp(`<(?:!--|(?<close>/?)(?<name>${[...RAW_TEXT_ELEMENTS, 'picture', 'img'].join('|')})(?![A-Za-z0-9-]))`, 'gi');
	let copied = 0;
	let pictureDepth = 0;
	let match: RegExpExecArray | null;
	while (images.length < PARADIS_MOBILE_HTML_IMAGE_MAX_COUNT && (match = interesting.exec(html)) !== null) {
		if (++tags % STEP_TAGS === 0) {
			yield;
		}
		const position = match.index;
		const name = match.groups?.name?.toLowerCase();
		if (name === undefined) {
			const close = yield* searchForward(html, COMMENT_END, position + 4);
			if (close === undefined) {
				break;
			}
			interesting.lastIndex = close;
			continue;
		}
		const closing = match.groups?.close === '/';
		const nameEnd = position + match[0].length;
		if (!closing && RAW_TEXT_ELEMENTS.has(name)) {
			// 閉じのタグは大文字小文字を問わない。先へ 1 回だけ探す
			let endTag = endTags.get(name);
			if (endTag === undefined) {
				endTag = new RegExp(`</${name}(?![A-Za-z0-9-])`, 'i');
				endTags.set(name, endTag);
			}
			const end = yield* searchForward(html, endTag, nameEnd);
			if (end === undefined) {
				break;
			}
			interesting.lastIndex = end;
			continue;
		}
		const tagEnd = html.indexOf('>', nameEnd);
		if (tagEnd === -1) {
			break;
		}
		if (name === 'picture') {
			pictureDepth = Math.max(0, pictureDepth + (closing ? -1 : 1));
		} else if (!closing && pictureDepth === 0 && tagEnd - position > PARADIS_MOBILE_HTML_IMAGE_MIN_CHARS) {
			// 抜ける大きさの data: が入らない短いタグは読まない
			const tag = html.slice(position, tagEnd + 1);
			const rewritten = rewriteImageTag(tag, images);
			if (rewritten !== undefined) {
				out.push(html.slice(copied, position), rewritten);
				copied = tagEnd + 1;
			}
			yield;
		}
		interesting.lastIndex = tagEnd + 1;
	}
	if (images.length === 0) {
		return undefined;
	}
	out.push(html.slice(copied));
	return { html: out.join(''), images };
}

const COMMENT_END = /-->/;
/** 閉じを探す 1 回分の長さ。近くの閉じは短く探して見つけ、遠いときは 16 倍ずつ広げる（最大で 1 MiB ごとに手を離す）。 */
const SEARCH_WINDOW_FIRST = 4 * 1024;
const SEARCH_WINDOW_MAX = 1024 * 1024;

/**
 * `from` から先で最初に `pattern`（短い・`g` 無し）に合う所を探し、合った部分の終わりの位置を返す。無ければ `undefined`。
 * 区切って探し、区切りごとに手を離す。区切りの端の一致（後ろの 1 文字を見られない）は、次の区切りで確かめ直す。
 */
function* searchForward(html: string, pattern: RegExp, from: number): Generator<void, number | undefined> {
	let window = SEARCH_WINDOW_FIRST;
	for (let start = from; start < html.length; start += window, window = Math.min(window * 16, SEARCH_WINDOW_MAX)) {
		const chunk = html.slice(start, start + window + 32);
		const found = pattern.exec(chunk);
		if (found !== null && (found.index + found[0].length < chunk.length || start + chunk.length >= html.length)) {
			return start + found.index + found[0].length;
		}
		if (window >= SEARCH_WINDOW_MAX) {
			yield;
		}
	}
	return undefined;
}

/** `img` のタグ 1 つを書き換える。抜かないなら `undefined`。抜いたら画像を `images` に足す。 */
function rewriteImageTag(tag: string, images: string[]): string | undefined {
	if (/\s(?:srcset|data-paradis-img)\s*=/i.test(tag)) {
		return undefined;
	}
	const source = /\ssrc\s*=\s*(?<quote>["'])(?<value>data:image\/[a-z0-9.+-]+;base64,(?<payload>[A-Za-z0-9+/=\s]+))\k<quote>/i.exec(tag);
	const value = source?.groups?.value;
	const payload = source?.groups?.payload;
	if (source === null || value === undefined || payload === undefined || value.length < PARADIS_MOBILE_HTML_IMAGE_MIN_CHARS || value.length > PARADIS_MOBILE_HTML_IMAGE_MAX_CHARS) {
		return undefined;
	}
	const size = paradisReadDataImageSize(payload);
	if (size === undefined) {
		return undefined;
	}
	const id = images.length;
	images.push(value);
	const placeholder = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${size.width}' height='${size.height}'/%3E`;
	// 元の属性の並びはそのまま。`src` の値だけを替え、印を先頭に足す。
	const start = source.index;
	return `<img ${PARADIS_MOBILE_HTML_IMAGE_ATTRIBUTE}="${id}"${tag.slice(4, start)} src="${placeholder}"${tag.slice(start + source[0].length)}`;
}

/** 見出しを読むために戻す、base64 の先頭の長さ（4 の倍数）。まず短く読み、JPEG の SOF が届かなければ 64 KiB 分まで読む。 */
const HEADER_BASE64_CHARS = [4 * 1024 / 3 * 4, 64 * 1024 / 3 * 4];

/** 画像の見出しから縦横を読む（PNG・GIF・JPEG・WebP）。全体は戻さない。読めなければ `undefined`。 */
export function paradisReadDataImageSize(base64: string): { readonly width: number; readonly height: number } | undefined {
	for (const chars of HEADER_BASE64_CHARS) {
		// 折り返しの空白を除いてから先頭を取る（空白の分だけ多めに切り出す）
		const compact = base64.slice(0, chars * 2).replace(/\s+/g, '');
		const prefix = compact.slice(0, chars);
		let bytes: Uint8Array;
		try {
			bytes = decodeBase64(prefix.slice(0, prefix.length - prefix.length % 4)).buffer;
		} catch {
			return undefined;
		}
		const size = paradisReadImageDimensions(bytes);
		if (size !== undefined) {
			return size.width <= 65_535 && size.height <= 65_535 ? size : undefined;
		}
		if (compact.length <= chars) {
			return undefined;
		}
	}
	return undefined;
}
