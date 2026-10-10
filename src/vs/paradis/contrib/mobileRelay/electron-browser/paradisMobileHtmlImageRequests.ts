/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// HTML の埋め込み画像を 1 枚ずつ返す口（fs.html-images.v1。Q325 案 A）。
//
// - fs の `read` に `htmlImages: true` が付いていて、HTML の本文から画像を抜けたら、provider は抜いた本文と
//   `htmlImages: { token, count }` を返す（{@link paradisPrepareMobileHtmlImages}）。抜いた画像はここで控える
// - fs の `htmlImage` { path, token, index } は、控えた画像の `data:` の文字列を `{ t: 'htmlImage', data }` で返す。
//   控えから外れていたら（PC を開き直した・ほかの文書を開いた）、ファイルを読み直して同じ中身か確かめてから返す。
//   中身が変わっていたら `{ error, code: 'stale' }`（アプリは本文から読み直す）、番号が無ければ `{ error, code: 'missing' }`

import { IFileService } from '../../../../platform/files/common/files.js';
import { localize } from '../../../../nls.js';
import { PARADIS_MOBILE_HTML_IMAGE_MAX_COUNT, paradisSplitMobileHtmlImagesSliced } from '../common/paradisMobileHtmlImages.js';
import { registerParadisMobileRequestHandler } from './paradisMobileRequestHandlers.js';

/** 画像を抜くために読む HTML の大きさの上限。これより大きいファイルは、今までどおり先頭の 20 MiB だけを送る。 */
export const PARADIS_MOBILE_HTML_IMAGES_SOURCE_LIMIT = 64 * 1024 * 1024;
/** 控える文書の数と、控える文書の文字の合計の上限（古いものから捨てる）。 */
const CACHE_DOCUMENTS = 2;
const CACHE_CHARACTERS = 128 * 1024 * 1024;
/** 取り寄せが止まってからこの時間がたったら、控えを全部捨てる（ウィンドウのメモリを抱え続けない。捨てた後は読み直す）。 */
const CACHE_IDLE_MS = 10 * 60 * 1000;

/**
 * 控え。`images` は元の本文の部分文字列なので、V8 では元の本文を丸ごと抱えたままになる（sliced string）。
 * 勘定には元の本文の長さ（`chars`）を使う。
 */
const cache = new Map<string, { readonly images: readonly string[]; readonly chars: number }>();
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function touch(): void {
	clearTimeout(idleTimer);
	idleTimer = setTimeout(() => {
		idleTimer = undefined;
		cache.clear();
	}, CACHE_IDLE_MS);
}

function remember(token: string, images: readonly string[], source: string): void {
	touch();
	cache.delete(token);
	cache.set(token, { images, chars: source.length });
	let total = 0;
	for (const value of cache.values()) {
		total += value.chars;
	}
	for (const [key, value] of cache) {
		if (cache.size <= 1 || (cache.size <= CACHE_DOCUMENTS && total <= CACHE_CHARACTERS)) {
			break;
		}
		cache.delete(key);
		total -= value.chars;
	}
}

/** 文書の中身から、画像を取り寄せるときの印を作る（SHA-256 の先頭 32 桁）。 */
async function tokenOf(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest).subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * HTML の本文から画像を抜き、抜いた画像を控える。抜く画像が無ければ `undefined`（本文はそのまま送る）。
 * provider の fs `read` が、アプリが `htmlImages: true` を付けたときだけ呼ぶ。
 */
export async function paradisPrepareMobileHtmlImages(text: string): Promise<{ readonly html: string; readonly token: string; readonly count: number } | undefined> {
	const split = await paradisSplitMobileHtmlImagesSliced(text);
	if (split === undefined) {
		return undefined;
	}
	const token = await tokenOf(text);
	remember(token, split.images, text);
	return { html: split.html, token, count: split.images.length };
}

/** HTML のファイルか（拡張子で見る）。 */
export function paradisIsMobileHtmlPath(path: string): boolean {
	return /\.html?$/i.test(path);
}

function staleReply(): object {
	return { error: localize('paradis.mobile.htmlImage.stale', "The document changed on the PC. Open it again."), code: 'stale' };
}

registerParadisMobileRequestHandler('fs', 'htmlImage', {
	handle(accessor, request, context) {
		const fileService = accessor.get(IFileService);
		const { path, token, index } = request;
		if (typeof path !== 'string' || !paradisIsMobileHtmlPath(path) || typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)
			|| typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= PARADIS_MOBILE_HTML_IMAGE_MAX_COUNT) {
			context.reply({ error: 'invalid html image request', code: 'missing' });
			return;
		}
		const send = (images: readonly string[]) => {
			const value = images[index];
			context.reply(value === undefined ? { error: 'html image not found', code: 'missing' } : { t: 'htmlImage', data: value });
		};
		const remembered = cache.get(token);
		if (remembered !== undefined) {
			touch();
			send(remembered.images);
			return;
		}
		return (async () => {
			const uri = await context.resolvePath(path);
			if (uri === undefined) {
				context.reply({ error: 'html image not found', code: 'missing' });
				return;
			}
			const stat = await fileService.stat(uri);
			if (stat.isDirectory || (stat.size ?? 0) > PARADIS_MOBILE_HTML_IMAGES_SOURCE_LIMIT) {
				context.reply(staleReply());
				return;
			}
			const content = await fileService.readFile(uri, { length: PARADIS_MOBILE_HTML_IMAGES_SOURCE_LIMIT });
			const text = content.value.toString();
			if (await tokenOf(text) !== token) {
				context.reply(staleReply());
				return;
			}
			const split = await paradisSplitMobileHtmlImagesSliced(text);
			if (split === undefined) {
				context.reply(staleReply());
				return;
			}
			remember(token, split.images, text);
			send(split.images);
		})();
	},
});
