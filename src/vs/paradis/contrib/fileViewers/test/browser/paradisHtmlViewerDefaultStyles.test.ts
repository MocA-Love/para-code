/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisHtmlViewerCanvasScript, paradisHtmlViewerHeadStyle } from '../../common/paradisHtmlViewerDefaultStyles.js';

/** webview の基盤（pre/index.html）が先頭に入れる層の、色に関わる指定（ダークのテーマの値）。 */
const WEBVIEW_DEFAULT_LAYER = '<style>@layer vscode-default{body{background-color:transparent;color:#bbbebf;}a{color:#4daafc;}a:hover{color:#4daafc;}'
	+ 'code{font-family:serif;color:#d7ba7d;background-color:#333333;padding:1px 3px;border-radius:4px;}pre code{background-color:transparent;padding:0;}'
	+ 'blockquote{background:#222222;border-color:#444444;}}</style>';

/** ビューアと同じ順（基盤の層 → ビューアの <style> → ページ）で組んだ文書の、要素ごとの色。 */
interface IColors {
	readonly text: string;
	readonly link: string;
	/** `html` の背景（白い地を外したときは透明になり、`body` の背景が画面全体に広がる）。 */
	readonly background: string;
	readonly code: string;
}

async function colorsOf(pageHead: string): Promise<IColors> {
	const frame = mainWindow.document.createElement('iframe');
	const loaded = new Promise<void>(resolve => frame.addEventListener('load', () => resolve(), { once: true }));
	frame.srcdoc = `<!DOCTYPE html><html><head>${WEBVIEW_DEFAULT_LAYER}${paradisHtmlViewerHeadStyle(1)}${pageHead}</head><body><p>text <a href="https://example.com/never-visited">link</a> <code>code</code></p>${paradisHtmlViewerCanvasScript()}</body></html>`;
	mainWindow.document.body.appendChild(frame);
	try {
		await loaded;
		const doc = frame.contentDocument!;
		const view = doc.defaultView!;
		return {
			text: view.getComputedStyle(doc.querySelector('p')!).color,
			link: view.getComputedStyle(doc.querySelector('a')!).color,
			background: view.getComputedStyle(doc.documentElement).backgroundColor,
			code: ['color', 'backgroundColor', 'fontFamily', 'paddingLeft'].map(name => view.getComputedStyle(doc.querySelector('code')!)[name as 'color']).join(' / '),
		};
	} finally {
		frame.remove();
	}
}

suite('ParadisHtmlViewerDefaultStyles', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('pages without colors get the browser defaults on the white page, and colors the page sets win', async () => {
		const browserCode = 'rgb(0, 0, 0) / rgba(0, 0, 0, 0) / monospace / 0px';
		assert.deepStrictEqual({
			plain: await colorsOf(''),
			textColor: await colorsOf('<style>body{color:#333366;}a{color:#008000;}code{color:#aa0000;}</style>'),
			htmlBackground: await colorsOf('<style>html{background-color:#202020;}</style>'),
			// body だけに背景を付けたページは白い地を外す（ブラウザと同じく body の背景が画面全体に広がる）。
			bodyBackground: await colorsOf('<style>body{background-color:#1e1e2e;}</style>'),
		}, {
			plain: { text: 'rgb(0, 0, 0)', link: 'rgb(0, 0, 238)', background: 'rgb(255, 255, 255)', code: browserCode },
			textColor: { text: 'rgb(51, 51, 102)', link: 'rgb(0, 128, 0)', background: 'rgb(255, 255, 255)', code: 'rgb(170, 0, 0) / rgba(0, 0, 0, 0) / monospace / 0px' },
			htmlBackground: { text: 'rgb(0, 0, 0)', link: 'rgb(0, 0, 238)', background: 'rgb(32, 32, 32)', code: browserCode },
			bodyBackground: { text: 'rgb(0, 0, 0)', link: 'rgb(0, 0, 238)', background: 'rgba(0, 0, 0, 0)', code: browserCode },
		});
	});
});
