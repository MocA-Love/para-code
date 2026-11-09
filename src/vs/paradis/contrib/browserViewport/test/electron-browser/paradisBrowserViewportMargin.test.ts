/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { IAction, SubmenuAction } from '../../../../../base/common/actions.js';
import { AppResourcePath, FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisBuildViewportMarginMenu } from '../../electron-browser/paradisBrowserViewportMarginMenu.js';

// 大きさを決めている間の表示域の外の余白: 透過中は地が透けること（実物の CSS を読み込んで計算後のスタイルで確かめる）と、
// 右クリックのメニューの項目。

function loadStylesheet(path: AppResourcePath): Promise<HTMLLinkElement> {
	const link = mainWindow.document.createElement('link');
	link.rel = 'stylesheet';
	link.href = FileAccess.asBrowserUri(path).toString(true);
	const loaded = new Promise<HTMLLinkElement>((resolve, reject) => {
		link.addEventListener('load', () => resolve(link), { once: true });
		link.addEventListener('error', () => reject(new Error(`could not load ${path}`)), { once: true });
	});
	mainWindow.document.head.appendChild(link);
	return loaded;
}

/** 計算後の背景色（`color(srgb r g b / a)` か `rgb(a)`）の不透明度（0〜1）。 */
function backgroundAlpha(element: HTMLElement): number {
	const value = mainWindow.getComputedStyle(element).backgroundColor;
	const alpha = /\/\s*([\d.]+)\s*\)$/.exec(value) ?? /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)$/.exec(value);
	return alpha ? Math.round(Number(alpha[1]) * 100) / 100 : 1;
}

function el(parent: HTMLElement, className: string): HTMLElement {
	const element = mainWindow.document.createElement('div');
	element.className = className;
	parent.appendChild(element);
	return element;
}

suite('ParadisBrowserViewportMargin', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let links: HTMLLinkElement[] = [];
	let workbench: HTMLElement;

	setup(async () => {
		links = await Promise.all([
			loadStylesheet('vs/paradis/contrib/browserViewport/electron-browser/media/paradisBrowserViewport.css'),
			loadStylesheet('vs/paradis/contrib/windowTransparency/browser/media/paradisWindowTransparency.css'),
		]);
		workbench = el(mainWindow.document.body, 'monaco-workbench');
		workbench.style.cssText = '--vscode-editor-background: rgb(10, 20, 30); --paradis-transparency-opacity: 50%;';
	});

	teardown(() => {
		workbench.remove();
		for (const link of links) {
			link.remove();
		}
		links = [];
	});

	test('the margin around a fixed page size is opaque without transparency and lets the editor layer through with it', () => {
		const editorPart = el(workbench, 'part editor');
		const editorContainer = el(editorPart, 'editor-container');
		editorContainer.style.backgroundColor = 'rgb(10, 20, 30)';
		const wrapper = el(el(editorContainer, 'browser-root'), 'browser-container-wrapper');
		el(el(wrapper, 'browser-container'), 'monaco-sash');

		const read = () => ({ editorContainer: backgroundAlpha(editorContainer), margin: backgroundAlpha(wrapper) });
		const opaque = read();
		workbench.classList.add('paradis-transparent');
		const transparent = read();

		assert.deepStrictEqual({ opaque, transparent }, {
			opaque: { editorContainer: 1, margin: 1 },
			transparent: { editorContainer: 0, margin: 0.18 },
		});
	});

	test('the margin menu offers sizes, scale, swap, screenshot, reload and developer tools', () => {
		const calls: string[] = [];
		const actions = paradisBuildViewportMarginMenu({
			current: { fit: false, name: 'フル HD', width: 1920, height: 1080, mobile: false },
			sizes: [{ name: 'ノート PC', width: 1366, height: 768 }, { name: 'フル HD', width: 1920, height: 1080 }, { name: 'iPhone 15', width: 390, height: 844, mobile: true }],
			scale: undefined,
			effectiveScale: 0.8,
			pageReady: true,
			canMarkup: true,
		}, {
			onSelectSize: size => calls.push(`size ${size.name}`),
			onSelectFit: () => calls.push('fit'),
			onSetScale: scale => calls.push(`scale ${scale}`),
			onSwap: () => calls.push('swap'),
			onMarkupScreenshot: () => calls.push('markup'),
			onReload: () => calls.push('reload'),
			onToggleDevTools: () => calls.push('devtools'),
		});
		const describe = (action: IAction): unknown => action instanceof SubmenuAction
			? { label: action.label, items: action.actions.map(describe) }
			: action.label ? `${action.label}${action.checked ? ' [x]' : ''}${action.enabled ? '' : ' (off)'}` : '---';
		const all = (list: readonly IAction[]): IAction[] => list.flatMap(action => action instanceof SubmenuAction ? all(action.actions) : [action]);
		for (const action of all(actions)) {
			if (action.label) {
				action.run();
			}
		}

		assert.deepStrictEqual({ menu: actions.map(describe), calls }, {
			menu: [
				{ label: 'ページの大きさ', items: ['ノート PC  1366×768', 'フル HD  1920×1080 [x]', 'iPhone 15  390×844・モバイル', '---', 'エディタに合わせる（大きさを決めない）'] },
				{ label: '表示の倍率', items: ['自動（80%） [x]', '---', '50%', '75%', '100%', '125%', '150%', '200%'] },
				'縦横を入れ替える',
				'---',
				'スクリーンショットに書き込む',
				'再読み込み',
				'開発者ツール',
			],
			calls: ['size ノート PC', 'size フル HD', 'size iPhone 15', 'fit', 'scale undefined', 'scale 0.5', 'scale 0.75', 'scale 1', 'scale 1.25', 'scale 1.5', 'scale 2', 'swap', 'markup', 'reload', 'devtools'],
		});
	});
});
