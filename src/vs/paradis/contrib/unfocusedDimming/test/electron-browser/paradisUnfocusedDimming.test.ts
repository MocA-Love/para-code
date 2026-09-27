/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { trackAttributes } from '../../../../../base/browser/dom.js';
import { IParadisDimmingWindow, PARADIS_WINDOW_INACTIVE_ATTRIBUTE, ParadisWindowInactiveClasses } from '../../electron-browser/paradisUnfocusedDimming.contribution.js';

function fakeWindow(vscodeWindowId: number): IParadisDimmingWindow {
	const container = mainWindow.document.createElement('div');
	container.classList.add('monaco-workbench');
	return { vscodeWindowId, container };
}

function inactive(targetWindow: IParadisDimmingWindow): boolean {
	return targetWindow.container.hasAttribute(PARADIS_WINDOW_INACTIVE_ATTRIBUTE);
}

suite('ParadisUnfocusedDimming', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('ネイティブのウィンドウ単位で、フォーカスの無いウィンドウにだけ印を付ける（補助ウィンドウも別々に）', async () => {
		const focus = store.add(new Emitter<number>());
		const blur = store.add(new Emitter<number>());
		const initial = new DeferredPromise<number | undefined>();
		const classes = store.add(new ParadisWindowInactiveClasses(focus.event, blur.event, initial.p));
		const main = fakeWindow(1);
		const auxiliary = fakeWindow(2);
		store.add(classes.addWindow(main));
		const auxiliaryRegistration = store.add(classes.addWindow(auxiliary));
		const snapshot = () => ({ main: inactive(main), auxiliary: inactive(auxiliary) });

		const beforeKnown = snapshot();
		await initial.complete(1);
		const mainFocused = snapshot();
		// 補助ウィンドウへ移る（フォーカスが先に届く順）
		focus.fire(2);
		blur.fire(1);
		const auxiliaryFocused = snapshot();
		// 別のアプリへ
		blur.fire(2);
		const otherApp = snapshot();
		focus.fire(1);
		auxiliaryRegistration.dispose();

		assert.deepStrictEqual({ beforeKnown, mainFocused, auxiliaryFocused, otherApp, backToMain: snapshot() }, {
			beforeKnown: { main: false, auxiliary: false },
			mainFocused: { main: false, auxiliary: true },
			auxiliaryFocused: { main: true, auxiliary: false },
			otherApp: { main: true, auxiliary: true },
			// 対象から外した補助ウィンドウの印は消える
			backToMain: { main: false, auxiliary: false },
		});
	});

	test('最初のフォーカスの問い合わせより先にイベントが届いたら、イベントの方を使う', async () => {
		const focus = store.add(new Emitter<number>());
		const blur = store.add(new Emitter<number>());
		const initial = new DeferredPromise<number | undefined>();
		const classes = store.add(new ParadisWindowInactiveClasses(focus.event, blur.event, initial.p));
		const main = fakeWindow(1);
		store.add(classes.addWindow(main));
		blur.fire(1);
		await initial.complete(1);
		assert.strictEqual(inactive(main), true);
	});

	test('メインへフォーカスが戻っても、upstream がメインのコンテナの class を写す補助ウィンドウの印は残る', async () => {
		const focus = store.add(new Emitter<number>());
		const blur = store.add(new Emitter<number>());
		const classes = store.add(new ParadisWindowInactiveClasses(focus.event, blur.event, Promise.resolve(2)));
		const main = fakeWindow(1);
		const auxiliary = fakeWindow(2);
		// auxiliaryWindowService.ts と同じく、メインのコンテナの class を補助ウィンドウのコンテナへ写し続ける
		store.add(trackAttributes(main.container, auxiliary.container, ['class']));
		store.add(classes.addWindow(main));
		store.add(classes.addWindow(auxiliary));
		await timeout(0);

		focus.fire(1);
		blur.fire(2);
		await timeout(0); // MutationObserver による写しが走るのを待つ

		assert.deepStrictEqual({ main: inactive(main), auxiliary: inactive(auxiliary), auxiliaryIsWorkbench: auxiliary.container.classList.contains('monaco-workbench') }, {
			main: false,
			auxiliary: true,
			auxiliaryIsWorkbench: true,
		});
	});
});
