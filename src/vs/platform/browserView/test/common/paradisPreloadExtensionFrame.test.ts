/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { PARADIS_BROWSER_EXTENSION_WINDOW_CHANNEL } from '../../common/paradisBrowserExtensionWindow.js';

suite('ParadisPreloadExtensionFrame', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('skips the preload only in extension frames embedded in another frame', async function () {
		// browserViewAutomationInput.test.ts と同じく、Electron の中では読んだだけで init() が走るので node でだけ確かめる
		if (process.versions.electron) {
			this.skip();
		}
		const { paradisIsEmbeddedExtensionFrame } = await import('../../electron-browser/preload-browserView.js');
		const extension = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
		assert.deepStrictEqual([
			// 拡張機能の iframe（ページの中）。拡張機能がその中に作る blob: / about:blank の iframe も同じ origin を持つ
			paradisIsEmbeddedExtensionFrame(extension, false),
			// タブで開いた拡張機能のページ（オプション画面など）
			paradisIsEmbeddedExtensionFrame(extension, true),
			// 通常のページとその iframe
			paradisIsEmbeddedExtensionFrame('https://example.com', false),
			paradisIsEmbeddedExtensionFrame('https://example.com', true),
			// 開いた直後など origin が無いとき
			paradisIsEmbeddedExtensionFrame('null', false),
			paradisIsEmbeddedExtensionFrame('', false),
		], [true, false, false, false, false, false]);
	});

	test('asks main per window whether an extension page is in a window the extension opened', async function () {
		if (process.versions.electron) {
			this.skip();
		}
		const { paradisIsBrowserExtensionWindow, PARADIS_BROWSER_EXTENSION_WINDOW_QUERY } = await import('../../electron-browser/preload-browserView.js');
		const asked: string[] = [];
		const answer = (value: unknown) => (channel: string) => {
			asked.push(channel);
			return value;
		};
		const extension = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
		const results = [
			paradisIsBrowserExtensionWindow(extension, true, answer(true)),
			paradisIsBrowserExtensionWindow(extension, true, answer(false)),
			// 答えが壊れていても、IPC が投げても、preload は動かす側（今までどおり）
			paradisIsBrowserExtensionWindow(extension, true, answer('yes')),
			paradisIsBrowserExtensionWindow(extension, true, () => { throw new Error('no handler'); }),
		];
		const askedByExtensionPages = asked.length;
		// ウェブのページと埋め込みのフレームは尋ねない（同期の IPC で止めない）
		results.push(paradisIsBrowserExtensionWindow('https://example.com', true, answer(true)), paradisIsBrowserExtensionWindow(extension, false, answer(true)));
		assert.deepStrictEqual({ results, askedByExtensionPages, askedAfter: asked.length, channel: PARADIS_BROWSER_EXTENSION_WINDOW_QUERY }, {
			results: [true, false, false, false, false, false],
			askedByExtensionPages: 3,
			askedAfter: 3,
			// preload は束ねないので channel の名前を自分でも持つ。main の受け手（common の定数）と同じであること
			channel: PARADIS_BROWSER_EXTENSION_WINDOW_CHANNEL,
		});
	});
});
