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
import { PARADIS_WEBVIEW_HOST_MESSAGE_CHECK } from '../../common/paradisWebviewHostMessage.js';

/**
 * webview のページを iframe で再現する。webview の基盤（`_vscodeApiScript`）と同じく、ページのスクリプトより先に
 * `window.parent`・`window.top`・`window.frameElement` を置き換える。ページの中には子の iframe を 1 つ置く。
 */
function loadWebviewPage(pageScript: string, bodyHtml: string): {
	readonly window: Window;
	postFromPage(data: unknown): void;
	postFromChild(data: unknown): void;
	settle(): Promise<void>;
	dispose(): void;
} {
	const iframe = mainWindow.document.createElement('iframe');
	mainWindow.document.body.appendChild(iframe);
	const frameWindow = iframe.contentWindow!;
	const frameDocument = frameWindow.document;
	frameDocument.body.innerHTML = bodyHtml;
	const child = frameDocument.createElement('iframe');
	frameDocument.body.appendChild(child);
	const run = (target: Window, code: string) => new (target as unknown as { Function: FunctionConstructor }).Function(code)();
	run(frameWindow, 'window.parent = window; window.top = window; window.frameElement = null;');
	// テストのページには CSP の nonce が無いので、<script> の中身だけを動かす。
	run(frameWindow, pageScript.replace(/^<script[^>]*>|<\/script>$/g, ''));
	const settleMarker = '__paradisSettled';
	return {
		window: frameWindow,
		postFromPage: data => run(frameWindow, `window.postMessage(${JSON.stringify(data)}, '*');`),
		postFromChild: data => run(child.contentWindow!, `window.parent.postMessage(${JSON.stringify(data)}, '*');`),
		// 投げたメッセージは順に届くので、最後に投げた印が届いたら、それより前のものは処理済み。
		settle: () => new Promise<void>(resolve => {
			const listener = (event: MessageEvent) => {
				if (event.data === settleMarker) {
					frameWindow.removeEventListener('message', listener);
					resolve();
				}
			};
			frameWindow.addEventListener('message', listener);
			frameWindow.postMessage(settleMarker, '*');
		}),
		dispose: () => iframe.remove(),
	};
}

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

	test('the page script replaces the body container and runs the after-swap code for messages from the real parent frame', async () => {
		const frame = loadWebviewPage(paradisViewerBodySwapScript('n', 'window.__paradisSwapped=(window.__paradisSwapped||0)+1;'), `<div id="${PARADIS_VIEWER_BODY_ROOT_ID}"><p>old</p></div>`);
		try {
			// ページ自身・ページの中の iframe から届いたものは受けない。
			frame.postFromPage(paradisViewerBodyMessage('<p>forged by the page</p>'));
			frame.postFromChild(paradisViewerBodyMessage('<p>forged by a child frame</p>'));
			// webview の基盤（本物の親のフレーム）から届いたものだけを受ける。
			frame.window.postMessage(paradisViewerBodyMessage('<h1>new</h1>'), '*');
			frame.window.postMessage({ other: 1 }, '*');
			await frame.settle();
			deepStrictEqual({
				parentReplaced: frame.window.parent === frame.window,
				html: frame.window.document.getElementById(PARADIS_VIEWER_BODY_ROOT_ID)?.innerHTML,
				ran: (frame.window as unknown as { __paradisSwapped?: number }).__paradisSwapped,
			}, { parentReplaced: true, html: '<h1>new</h1>', ran: 1 });
		} finally {
			frame.dispose();
		}
	});

	test('the host check accepts only the real parent frame of a page whose window.parent was replaced', async () => {
		const frame = loadWebviewPage(`<script>window.__paradisHost=[];var fromHost=${PARADIS_WEBVIEW_HOST_MESSAGE_CHECK};window.addEventListener('message',function(e){if(e.data&&e.data.from){window.__paradisHost.push(e.data.from+':'+fromHost(e));}});</script>`, '');
		try {
			frame.postFromPage({ from: 'page' });
			frame.postFromChild({ from: 'child' });
			frame.window.postMessage({ from: 'parent' }, '*');
			await frame.settle();
			deepStrictEqual([...(frame.window as unknown as { __paradisHost: string[] }).__paradisHost], ['page:false', 'child:false', 'parent:true']);
		} finally {
			frame.dispose();
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
