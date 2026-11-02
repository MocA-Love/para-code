/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

// ウィンドウの透過の CSS が、地を 1 枚にしていること（ワークベンチの地は透明、各部の地だけが半透明）と、
// ページの中身・浮き窓が透けないことを、実物の CSS を読み込んで計算後のスタイルで確かめる。

function loadStylesheet(): Promise<HTMLLinkElement> {
	const link = mainWindow.document.createElement('link');
	link.rel = 'stylesheet';
	link.href = FileAccess.asBrowserUri('vs/paradis/contrib/windowTransparency/browser/media/paradisWindowTransparency.css').toString(true);
	const loaded = new Promise<HTMLLinkElement>((resolve, reject) => {
		link.addEventListener('load', () => resolve(link), { once: true });
		link.addEventListener('error', () => reject(new Error('could not load paradisWindowTransparency.css')), { once: true });
	});
	mainWindow.document.head.appendChild(link);
	return loaded;
}

/** 計算後の背景色の不透明度（0〜1）。color-mix の結果は `color(srgb r g b / a)` で返る。 */
function backgroundAlpha(element: HTMLElement): number {
	const value = mainWindow.getComputedStyle(element).backgroundColor;
	const slash = /\/\s*([\d.]+)\s*\)$/.exec(value);
	if (slash) {
		return Math.round(Number(slash[1]) * 100) / 100;
	}
	const rgba = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)$/.exec(value);
	if (rgba) {
		return Math.round(Number(rgba[1]) * 100) / 100;
	}
	return 1;
}

function el(parent: HTMLElement, className: string, id?: string): HTMLElement {
	const element = mainWindow.document.createElement('div');
	element.className = className;
	if (id) {
		element.id = id;
	}
	parent.appendChild(element);
	return element;
}

/** エディタの領域: エディタのグループの器（本家が不透明の地をインラインで塗る）と、その中のエディタ。 */
function editorContainer(editorPart: HTMLElement, inner?: (container: HTMLElement) => void): HTMLElement {
	const container = el(editorPart, 'editor-container');
	container.style.backgroundColor = 'rgb(10, 20, 30)';
	inner?.(container);
	return container;
}

suite('ParadisWindowTransparencyCss', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let link: HTMLLinkElement | undefined;
	let workbench: HTMLElement;

	setup(async () => {
		link = await loadStylesheet();
		workbench = mainWindow.document.createElement('div');
		workbench.className = 'monaco-workbench paradis-transparent';
		workbench.style.cssText = '--vscode-editor-background: rgb(10, 20, 30); --vscode-sideBar-background: rgb(30, 30, 30); --vscode-statusBar-background: rgb(9, 175, 217); --vscode-editorWidget-background: rgb(40, 40, 40); --paradis-transparency-opacity: 50%;';
		mainWindow.document.body.appendChild(workbench);
	});

	teardown(() => {
		workbench.remove();
		link?.remove();
		link = undefined;
	});

	test('paints one translucent layer per part, keeps the status bar, page content and editor widgets opaque', () => {
		const sidebar = el(workbench, 'part sidebar');
		const statusbar = el(workbench, 'part statusbar');
		const editorPart = el(workbench, 'part editor');
		const plain = editorContainer(editorPart);
		const image = editorContainer(editorPart, c => el(c, 'paradis-image-viewer'));
		const webview = editorContainer(editorPart, c => el(c, '', 'webview-editor-element-1'));
		const rendered = editorContainer(editorPart, c => el(el(el(c, 'paradis-file-viewer'), 'paradis-file-viewer-content'), 'paradis-file-viewer-editor'));
		const raw = editorContainer(editorPart, c => el(el(el(c, 'paradis-file-viewer'), 'paradis-file-viewer-content'), 'paradis-file-viewer-editor active'));
		const suggest = el(el(editorPart, 'monaco-editor'), 'suggest-widget');

		assert.deepStrictEqual({
			workbench: backgroundAlpha(workbench),
			sidebar: backgroundAlpha(sidebar),
			editorPart: backgroundAlpha(editorPart),
			statusbar: backgroundAlpha(statusbar),
			textEditor: backgroundAlpha(plain),
			imageViewer: backgroundAlpha(image),
			webviewEditor: backgroundAlpha(webview),
			renderedViewer: backgroundAlpha(rendered),
			rawViewer: backgroundAlpha(raw),
			suggestWidget: backgroundAlpha(suggest),
		}, {
			workbench: 0,
			sidebar: 0.5,
			editorPart: 0.5,
			statusbar: 1,
			textEditor: 0,
			imageViewer: 1,
			webviewEditor: 1,
			renderedViewer: 1,
			rawViewer: 0,
			suggestWidget: 1,
		});
	});

	test('moves the editor layer under the rounded corners in Modern UI without floating panels', () => {
		workbench.classList.add('modern-ui');
		const cell = el(el(workbench, 'monaco-grid-view'), 'split-view-view');
		const editorPart = el(cell, 'part editor');

		assert.deepStrictEqual({ cell: backgroundAlpha(cell), editorPart: backgroundAlpha(editorPart) }, { cell: 0.5, editorPart: 0 });
	});
});
