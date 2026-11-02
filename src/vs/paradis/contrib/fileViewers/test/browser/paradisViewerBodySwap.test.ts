/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import { loadParadisMermaidScriptSource } from '../../browser/paradisMarkdownMermaid.js';
import { PARADIS_VIEWER_BODY_ROOT_ID, paradisCanSwapViewerBody, paradisMustResendViewerHtmlOnClaim, paradisViewerBodyMessage, paradisViewerBodySwapScript, type IParadisSwappableBody } from '../../common/paradisViewerBodySwap.js';

suite('ParadisViewerBodySwap', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('swaps only the body of a confirmed page of the same file in the same webview with the same outside', () => {
		const webview = {};
		const shown = (overrides: Partial<IParadisSwappableBody<object, string>> = {}): IParadisSwappableBody<object, string> => ({ webview, resource: 'a.md', key: 'k', confirmed: true, swapped: false, ...overrides });
		const same = (left: string, right: string) => left === right;
		deepStrictEqual([
			paradisCanSwapViewerBody(shown(), webview, 'a.md', 'k', same),
			paradisCanSwapViewerBody(undefined, webview, 'a.md', 'k', same),
			paradisCanSwapViewerBody(shown({ confirmed: false }), webview, 'a.md', 'k', same),
			paradisCanSwapViewerBody(shown(), {}, 'a.md', 'k', same),
			paradisCanSwapViewerBody(shown(), webview, 'b.md', 'k', same),
			paradisCanSwapViewerBody(shown(), webview, 'a.md', 'other', same),
		], [true, false, false, false, false, false]);
		// 本文を差し替えた後に claim し直したら、webview が貼り直す古い HTML ではなく、HTML 全体を送り直す。
		deepStrictEqual([undefined, shown(), shown({ swapped: true })].map(paradisMustResendViewerHtmlOnClaim), [false, false, true]);
	});

	test('the page script replaces the body container and runs the after-swap code', () => {
		const doc = mainWindow.document;
		const root = doc.createElement('div');
		root.id = PARADIS_VIEWER_BODY_ROOT_ID;
		root.innerHTML = '<p>old</p>';
		doc.body.appendChild(root);
		const script = doc.createElement('script');
		// テストのページには CSP の nonce が無いので、中身だけを動かす。
		script.textContent = paradisViewerBodySwapScript('n', 'window.__paradisSwapped=(window.__paradisSwapped||0)+1;').replace(/^<script[^>]*>|<\/script>$/g, '');
		doc.body.appendChild(script);
		try {
			// 親のフレーム（webview の基盤）以外から届いたものは受けない。
			const channel = new MessageChannel();
			mainWindow.dispatchEvent(new MessageEvent('message', { data: paradisViewerBodyMessage('<p>forged</p>'), source: channel.port1 }));
			channel.port1.close();
			channel.port2.close();
			mainWindow.dispatchEvent(new MessageEvent('message', { data: paradisViewerBodyMessage('<h1>new</h1>'), source: mainWindow.parent }));
			mainWindow.dispatchEvent(new MessageEvent('message', { data: { other: 1 }, source: mainWindow.parent }));
			deepStrictEqual({ html: root.innerHTML, ran: (mainWindow as unknown as { __paradisSwapped?: number }).__paradisSwapped }, { html: '<h1>new</h1>', ran: 1 });
		} finally {
			root.remove();
			script.remove();
		}
	});

	test('does not remember a failed read of mermaid.js', async () => {
		let reads = 0;
		const fileService = {
			readFile: async () => {
				reads++;
				if (reads === 1) {
					throw new Error('not yet');
				}
				return { value: VSBuffer.fromString('mermaid();</script>') };
			},
		} as unknown as IFileService;
		const first = await loadParadisMermaidScriptSource(fileService);
		const second = await loadParadisMermaidScriptSource(fileService);
		const third = await loadParadisMermaidScriptSource(fileService);
		deepStrictEqual({ first, second, third, reads }, { first: undefined, second: 'mermaid();<\\/script>', third: 'mermaid();<\\/script>', reads: 2 });
	});
});
