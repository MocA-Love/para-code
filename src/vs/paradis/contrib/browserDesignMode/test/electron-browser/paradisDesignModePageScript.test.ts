/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ページへ入れる仕掛けの「取り出し」の規則を、テスト用の DOM の上で確かめる。本番では isolated
// world で動くが、取り出しの処理は DOM の API しか使わないので、テストの window でそのまま動かす。

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisBuildInstallScript } from '../../common/paradisDesignModePageScript.js';

interface IExtracted {
	readonly selector: string;
	readonly textSnippet: string;
	readonly htmlSnippet: string;
	readonly nearbyText: readonly string[];
	readonly accessibleName: string;
}

interface IDesignApi {
	extract(element: Element): IExtracted;
	dispose(): void;
}

interface IDesignGlobal {
	__paradisDesign?: IDesignApi;
}

suite('paradisDesignModePageScript', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let fixture: HTMLElement;

	setup(() => {
		fixture = mainWindow.document.createElement('div');
		// 見えているかを一番手前の要素で調べるので、テストの画面の左上・最前面に置く
		fixture.style.cssText = 'position:fixed;left:0;top:0;width:600px;z-index:2147483646;background:#ffffff;color:#000000;font-size:14px';
		mainWindow.document.body.appendChild(fixture);
	});

	teardown(() => {
		const global = mainWindow as unknown as IDesignGlobal;
		global.__paradisDesign?.dispose();
		delete global.__paradisDesign;
		fixture.remove();
	});

	function extract(element: Element): IExtracted {
		new Function(paradisBuildInstallScript())();
		const api = (mainWindow as unknown as IDesignGlobal).__paradisDesign;
		assert.ok(api);
		return api.extract(element);
	}

	function add(parent: HTMLElement, tag: string, text: string, style = '', attributes: Record<string, string> = {}): HTMLElement {
		const element = mainWindow.document.createElement(tag);
		element.textContent = text;
		element.style.cssText = style;
		for (const [name, value] of Object.entries(attributes)) {
			element.setAttribute(name, value);
		}
		parent.appendChild(element);
		return element;
	}

	test('見えないテキスト・要素・コメントは取り出さない', () => {
		const container = add(fixture, 'div', '');
		const button = add(container, 'button', '', 'background:#ffffff;color:#000000;border:0;padding:0');
		add(button, 'span', 'Buy now');
		add(button, 'span', 'HIDDEN-display', 'display:none');
		add(button, 'span', 'HIDDEN-visibility', 'visibility:hidden');
		add(button, 'span', 'HIDDEN-transparent', 'color:transparent');
		add(button, 'span', 'HIDDEN-tiny', 'font-size:0');
		add(button, 'span', 'HIDDEN-opacity', 'opacity:0');
		add(button, 'span', 'HIDDEN-aria', '', { 'aria-hidden': 'true' });
		add(button, 'span', 'HIDDEN-offscreen', 'position:absolute;left:-9999px');
		add(button, 'span', 'HIDDEN-right', 'position:absolute;left:100000px');
		add(button, 'span', 'HIDDEN-fixed', 'position:fixed;top:-9999px');
		add(button, 'span', 'HIDDEN-almost-transparent', 'color:rgba(0,0,0,0.01)');
		add(button, 'span', 'HIDDEN-almost-opacity', 'opacity:0.01');
		add(button, 'span', 'HIDDEN-fill', '-webkit-text-fill-color:transparent');
		add(button, 'span', 'HIDDEN-same-color', 'color:#ffffff');
		add(button, 'span', 'HIDDEN-indent', 'display:inline-block;width:80px;overflow:hidden;white-space:nowrap;text-indent:-9999px');
		// 祖先の切り抜き: 1px の箱の中の文字は、文字自身の箱が大きいままでも見えていない
		const clipped = add(button, 'span', '', 'position:absolute;width:1px;height:1px;overflow:hidden');
		add(clipped, 'b', 'HIDDEN-ancestor-overflow');
		const clipPath = add(button, 'span', '', 'clip-path:inset(50%)');
		add(clipPath, 'b', 'HIDDEN-ancestor-clip-path');
		const faded = add(button, 'span', '', 'opacity:0.3');
		add(faded, 'span', 'HIDDEN-nested-opacity', 'opacity:0.2');
		// ほかの要素で覆った文字
		const covered = add(button, 'span', '', 'position:relative;display:inline-block');
		add(covered, 'span', 'HIDDEN-covered');
		add(covered, 'span', '', 'position:absolute;inset:0;background:#ffffff');
		// 画面に出ない属性
		button.setAttribute('aria-label', 'HIDDEN-aria-label');
		button.setAttribute('title', 'HIDDEN-title');
		button.id = 'HIDDEN-this-id-is-a-sentence-that-should-not-be-used-in-a-selector';
		button.appendChild(mainWindow.document.createComment('HIDDEN-comment'));
		add(container, 'p', 'Visible neighbour');
		add(container, 'p', 'HIDDEN-neighbour', 'display:none');

		const result = extract(button);
		const everything = JSON.stringify(result);
		assert.deepStrictEqual({
			leakedParts: everything.match(/HIDDEN-[a-z-]+/g) ?? [],
			text: result.textSnippet,
			nearby: result.nearbyText,
			name: result.accessibleName,
			leaked: everything.includes('HIDDEN'),
		}, {
			leakedParts: [],
			text: 'Buy now',
			nearby: ['Visible neighbour'],
			name: 'Buy now',
			leaked: false,
		});
	});
});
