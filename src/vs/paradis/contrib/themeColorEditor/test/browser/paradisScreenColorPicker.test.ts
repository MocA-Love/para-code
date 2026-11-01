/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { TestColorTheme, TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { ParadisScreenColorPicker, ParadisScreenPickResult } from '../../browser/paradisScreenColorPicker.js';

suite('ParadisScreenColorPicker', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let container: HTMLElement;
	let target: HTMLElement;
	let style: HTMLStyleElement;
	let picks: ParadisScreenPickResult[];
	let ends: number;

	setup(() => {
		// 本物のワークベンチと同じく、テーマの色の変数は `.monaco-workbench` の器の上にだけある。
		container = mainWindow.document.createElement('div');
		container.className = 'monaco-workbench paradis-tce-test-workbench';
		target = mainWindow.document.createElement('div');
		target.className = 'paradis-tce-test-target';
		target.style.cssText = 'position: fixed; left: 10px; top: 20px; width: 30px; height: 40px;';
		container.appendChild(target);
		mainWindow.document.body.appendChild(container);
		style = mainWindow.document.createElement('style');
		style.textContent = '.paradis-tce-test-target { background-color: var(--vscode-editor-background); }';
		mainWindow.document.head.appendChild(style);
		picks = [];
		ends = 0;
	});

	teardown(() => {
		container.remove();
		style.remove();
	});

	function createPicker(store: DisposableStore): ParadisScreenColorPicker {
		const layoutService = new class extends mock<ILayoutService>() {
			override getContainer(): HTMLElement {
				return container;
			}
		};
		const themeService = new TestThemeService(new TestColorTheme({ 'editor.background': '#112233' }));
		return store.add(new ParadisScreenColorPicker(mainWindow, result => picks.push(result), () => ends++, themeService, layoutService));
	}

	function mouse(type: string, element: HTMLElement): void {
		const init = { bubbles: true, cancelable: true, button: 0, clientX: 15, clientY: 25 };
		element.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, init) : new MouseEvent(type, init));
	}

	/** 本物のクリックの並び。pointerdown を取り消すと Chromium は mousedown / mouseup を出さず、click だけが来る。 */
	function click(element: HTMLElement): void {
		mouse('pointerdown', element);
		mouse('pointerup', element);
		mouse('click', element);
	}

	function key(key: string): void {
		mainWindow.document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
	}

	function overlay(): { parentIsWorkbench: boolean[]; highlight: string; pinned: boolean; firstRow: string | undefined } {
		const banner = container.querySelector<HTMLElement>('.paradis-tce-screen-banner');
		const highlight = container.querySelector<HTMLElement>('.paradis-tce-screen-highlight');
		const panel = container.querySelector<HTMLElement>('.paradis-tce-screen-panel');
		return {
			parentIsWorkbench: [banner, highlight, panel].map(element => element?.parentElement === container),
			highlight: highlight ? `${highlight.style.left} ${highlight.style.top} ${highlight.style.width} ${highlight.style.height}` : '',
			pinned: !!panel?.classList.contains('pinned'),
			firstRow: panel?.querySelector('.paradis-tce-screen-id')?.textContent ?? undefined,
		};
	}

	test('覆いをワークベンチの器に置き、クリックした要素を枠で囲んで色のキーを出す', () => {
		const store = disposables.add(new DisposableStore());
		createPicker(store);
		click(target);

		assert.deepStrictEqual(overlay(), {
			parentIsWorkbench: [true, true, true],
			highlight: '10px 20px 30px 40px',
			pinned: true,
			firstRow: 'editor.background',
		});
	});

	test('候補をクリックすると色のキーを返して終わり、Esc でも終わる。終わると覆いが外れる', () => {
		const store = disposables.add(new DisposableStore());
		createPicker(store);
		click(target);
		const row = container.querySelector<HTMLElement>('.paradis-tce-screen-row');
		assert.ok(row);
		row.click();
		store.dispose();

		const second = disposables.add(new DisposableStore());
		createPicker(second);
		key('Escape');

		second.dispose();
		assert.deepStrictEqual({ picks, ends, left: container.querySelectorAll('[class^="paradis-tce-screen-"]').length }, {
			picks: [{ kind: 'color', colorId: 'editor.background' }],
			ends: 2,
			left: 0,
		});
	});

	test('Enter でポインタの下の場所を決め、もう一度 Enter で選んでいる色のキーを返す', async () => {
		const store = disposables.add(new DisposableStore());
		createPicker(store);
		mouse('mousemove', target);
		// mousemove の調べはアニメーションフレームで行う
		await new Promise<void>(resolve => mainWindow.requestAnimationFrame(() => resolve()));
		key('Enter');
		const pinned = overlay().pinned;
		key('Enter');

		assert.deepStrictEqual({ pinned, picks, ends }, {
			pinned: true,
			picks: [{ kind: 'color', colorId: 'editor.background' }],
			ends: 1,
		});
		store.dispose();
	});
});
