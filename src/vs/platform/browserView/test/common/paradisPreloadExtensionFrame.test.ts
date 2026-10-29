/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

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
});
