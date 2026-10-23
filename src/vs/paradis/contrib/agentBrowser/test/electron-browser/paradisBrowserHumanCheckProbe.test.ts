/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_HUMAN_CHECK_PAGE_PROBE } from '../../common/paradisBrowserHumanCheck.js';

interface IProbeResult {
	readonly page: boolean;
	readonly unsolvedVisible: boolean;
	readonly submits: number;
}

suite('ParadisBrowserHumanCheck page probe', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('counts only actions that send the form that has the Turnstile', () => {
		const doc = mainWindow.document;
		const root = doc.createElement('div');
		root.innerHTML = `
			<form id="login">
				<input id="email" type="email">
				<textarea id="note"></textarea>
				<div style="width:300px;height:65px"><input type="hidden" name="cf-turnstile-response" value=""></div>
				<button id="show" type="button">Show password</button>
				<button id="send">Sign in</button>
			</form>
			<form id="search"><input id="query" type="text"><button id="other" type="button">Clear</button></form>
			<button id="outside" type="button">Menu</button>`;
		doc.body.appendChild(root);
		// 本番と同じ式の文字列をそのまま動かす（main は executeJavaScriptInIsolatedWorld で同じ文字列を渡す）
		// eslint-disable-next-line no-eval
		const run = () => (0, eval)(PARADIS_HUMAN_CHECK_PAGE_PROBE) as IProbeResult;
		const byId = (id: string) => doc.getElementById(id)!;
		const enter = (id: string) => byId(id).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		const tab = (id: string) => byId(id).dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
		// 送信を止める（テストのページを移動させない）
		const preventSubmit = (event: Event) => event.preventDefault();
		doc.addEventListener('submit', preventSubmit);
		try {
			const counts: number[] = [];
			const step = (action: () => void) => {
				action();
				counts.push(run().submits);
			};
			const first = run();
			step(() => byId('email').click()); // 入力欄へのフォーカスのクリック
			step(() => tab('email')); // Tab
			step(() => enter('note')); // textarea の Enter
			step(() => byId('outside').click()); // form の外のボタン
			step(() => byId('other').click()); // Turnstile の無い form の type=button
			step(() => byId('show').click()); // Turnstile と同じ form の中のボタン
			step(() => enter('email')); // 入力欄の Enter
			step(() => byId('send').click()); // 送信ボタン（click と submit の 2 つ）
			assert.deepStrictEqual({ first: { page: first.page, unsolvedVisible: first.unsolvedVisible }, counts }, {
				first: { page: false, unsolvedVisible: true },
				counts: [0, 0, 0, 0, 0, 1, 2, 4],
			});
		} finally {
			doc.removeEventListener('submit', preventSubmit);
			root.remove();
		}
	});
});
