/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { VSBuffer, encodeBase64 } from '../../../../../base/common/buffer.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_MOBILE_HTML_IMAGE_MIN_CHARS, paradisReadDataImageSize, paradisSplitMobileHtmlImages, paradisSplitMobileHtmlImagesSliced } from '../../common/paradisMobileHtmlImages.js';

/** 見出しだけが本物の PNG（縦横を読むのに足りる）を、`data:` の文字列にする。`bytes` で全体の大きさを決める。 */
function pngDataUrl(width: number, height: number, bytes = PARADIS_MOBILE_HTML_IMAGE_MIN_CHARS): string {
	const png = new Uint8Array(bytes);
	png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	new DataView(png.buffer).setUint32(16, width);
	new DataView(png.buffer).setUint32(20, height);
	return `data:image/png;base64,${encodeBase64(VSBuffer.wrap(png))}`;
}

function placeholder(width: number, height: number): string {
	return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}'/%3E`;
}

suite('ParadisMobileHtmlImages', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('takes out only large img src images outside raw text elements, comments, srcset and picture', () => {
		const first = pngDataUrl(1200, 700);
		const second = pngDataUrl(720, 420);
		const small = pngDataUrl(10, 10, 64);
		const html = [
			'<!doctype html><title>架空の資料</title>',
			`<style>.hero { background: url(${first}); }</style>`,
			`<p><img class="figure" loading="lazy" src="${first}" alt="図 1" onclick="zoom(this)"></p>`,
			`<p><img alt='図 2' src='${second}'></p>`,
			`<p><img src="${small}" alt="小さい図"></p>`,
			`<p><img src="${first}" srcset="${second} 2x"></p>`,
			`<picture><source srcset="${second}"><img src="${first}"></picture>`,
			`<script>const later = '<img src="${second}">';</script>`,
			`<SCRIPT type="text/x-template"><img src="${second}"></Script>`,
			`<textarea><img src="${second}"></textarea>`,
			`<template><img src="${second}"></template>`,
			`<noscript><img src="${second}"></noscript>`,
			`<svg><title><img src="${second}"></title></svg>`,
			`<!-- <img src="${second}"> -->`,
			`<a href="${second}" download>保存</a>`,
			`<p><img src="data:image/png;base64,${'A'.repeat(PARADIS_MOBILE_HTML_IMAGE_MIN_CHARS)}"></p>`,
		].join('\n');

		const split = paradisSplitMobileHtmlImages(html);

		assert.deepStrictEqual(split, {
			images: [first, second],
			html: html
				.replace(`<img class="figure" loading="lazy" src="${first}"`, `<img data-paradis-img="0" class="figure" loading="lazy" src="${placeholder(1200, 700)}"`)
				.replace(`<img alt='図 2' src='${second}'>`, `<img data-paradis-img="1" alt='図 2' src="${placeholder(720, 420)}">`),
		});
	});

	test('returns undefined when nothing is taken out, and does not take out an image twice', () => {
		const image = pngDataUrl(640, 480);
		const once = paradisSplitMobileHtmlImages(`<img src="${image}">`);
		assert.deepStrictEqual([
			paradisSplitMobileHtmlImages('<p>画像の無いページ</p><img src="photo.png">'),
			once?.images.length,
			once !== undefined ? paradisSplitMobileHtmlImages(once.html) : 'not split',
		], [undefined, 1, undefined]);
	});

	test('scans once and stops at an unclosed comment, raw text element or tag', async () => {
		const image = pngDataUrl(320, 240);
		const lead = `<p><img src="${image}"></p>`;
		const tails = ['<script '.repeat(80_000), '<img '.repeat(80_000), '<!--'.repeat(80_000), '<style '.repeat(80_000), '<textarea>' + '<img '.repeat(80_000), '<a'.repeat(80_000), '<'.repeat(80_000)];
		const started = Date.now();
		const results = tails.map(tail => {
			const split = paradisSplitMobileHtmlImages(lead + tail);
			return split !== undefined && split.images.length === 1 && split.html.endsWith(tail) && !split.html.includes(image);
		});
		const elapsed = Date.now() - started;
		// 区切って手を離す版も同じ結果を返す
		const long = lead + '<script>x</script>'.repeat(20_000) + lead;
		const sliced = await paradisSplitMobileHtmlImagesSliced(long, undefined, 1);
		// 以前の正規表現の書き方では、1 つ目と 2 つ目だけで 30 秒近くかかった。混んだ CI でも落ちないよう、上限は広く取る
		assert.deepStrictEqual({ results, fast: elapsed < 10_000, sliced: sliced?.images.length }, { results: tails.map(() => true), fast: true, sliced: 2 });
		assert.deepStrictEqual(sliced, paradisSplitMobileHtmlImages(long));
	});

	test('the sliced split stops at the next slice once the token is cancelled', async () => {
		const image = pngDataUrl(320, 240);
		const source = new CancellationTokenSource();
		source.cancel();
		const error = await paradisSplitMobileHtmlImagesSliced(`<img src="${image}">${'<p>x</p>'.repeat(10_000)}<img src="${image}">`, source.token, 0).then(() => undefined, (reason: unknown) => reason);
		source.dispose();
		assert.strictEqual(isCancellationError(error), true);
	});

	test('reads the size from the start of a wrapped base64 payload', () => {
		const payload = pngDataUrl(300, 200).slice('data:image/png;base64,'.length).replace(/.{76}/g, line => `${line}\n`);
		assert.deepStrictEqual([
			paradisReadDataImageSize(payload),
			paradisReadDataImageSize('not base64 at all'),
		], [{ width: 300, height: 200 }, undefined]);
	});
});
