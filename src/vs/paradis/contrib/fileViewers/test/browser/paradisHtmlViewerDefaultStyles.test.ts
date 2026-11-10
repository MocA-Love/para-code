/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisHtmlViewerHeadStyle } from '../../common/paradisHtmlViewerDefaultStyles.js';

/** webview の基盤（pre/index.html）が先頭に入れる層の、色に関わる指定（ダークのテーマの値）。 */
const WEBVIEW_DEFAULT_LAYER = '<style>@layer vscode-default{body{background-color:transparent;color:#bbbebf;}a{color:#4daafc;}a:hover{color:#4daafc;}}</style>';

/** ビューアと同じ順（基盤の層 → ビューアの <style> → ページ）で組んだ文書の、要素ごとの色。 */
async function colorsOf(pageHead: string): Promise<{ readonly text: string; readonly link: string; readonly background: string }> {
	const frame = mainWindow.document.createElement('iframe');
	const loaded = new Promise<void>(resolve => frame.addEventListener('load', () => resolve(), { once: true }));
	frame.srcdoc = `<!DOCTYPE html><html><head>${WEBVIEW_DEFAULT_LAYER}${paradisHtmlViewerHeadStyle(1)}${pageHead}</head><body><p>text <a href="https://example.com/never-visited">link</a></p></body></html>`;
	mainWindow.document.body.appendChild(frame);
	try {
		await loaded;
		const doc = frame.contentDocument!;
		const view = doc.defaultView!;
		return {
			text: view.getComputedStyle(doc.querySelector('p')!).color,
			link: view.getComputedStyle(doc.querySelector('a')!).color,
			background: view.getComputedStyle(doc.documentElement).backgroundColor,
		};
	} finally {
		frame.remove();
	}
}

suite('ParadisHtmlViewerDefaultStyles', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('pages without colors get the browser defaults on the white page, and colors the page sets win', async () => {
		assert.deepStrictEqual({
			plain: await colorsOf(''),
			textColor: await colorsOf('<style>body{color:#333366;}a{color:#008000;}</style>'),
			darkBackground: await colorsOf('<style>html{background-color:#202020;}</style>'),
		}, {
			plain: { text: 'rgb(0, 0, 0)', link: 'rgb(0, 0, 238)', background: 'rgb(255, 255, 255)' },
			textColor: { text: 'rgb(51, 51, 102)', link: 'rgb(0, 128, 0)', background: 'rgb(255, 255, 255)' },
			darkBackground: { text: 'rgb(0, 0, 0)', link: 'rgb(0, 0, 238)', background: 'rgb(32, 32, 32)' },
		});
	});
});
