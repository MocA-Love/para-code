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
		const button = add(container, 'button', '');
		add(button, 'span', 'Buy now');
		add(button, 'span', 'HIDDEN-display', 'display:none');
		add(button, 'span', 'HIDDEN-visibility', 'visibility:hidden');
		add(button, 'span', 'HIDDEN-transparent', 'color:transparent');
		add(button, 'span', 'HIDDEN-tiny', 'font-size:0');
		add(button, 'span', 'HIDDEN-opacity', 'opacity:0');
		add(button, 'span', 'HIDDEN-aria', '', { 'aria-hidden': 'true' });
		add(button, 'span', 'HIDDEN-offscreen', 'position:absolute;left:-9999px');
		button.appendChild(mainWindow.document.createComment('HIDDEN-comment'));
		add(container, 'p', 'Visible neighbour');
		add(container, 'p', 'HIDDEN-neighbour', 'display:none');

		const result = extract(button);
		const everything = JSON.stringify(result);
		assert.deepStrictEqual({
			text: result.textSnippet,
			nearby: result.nearbyText,
			name: result.accessibleName,
			leaked: everything.includes('HIDDEN'),
		}, {
			text: 'Buy now',
			nearby: ['Visible neighbour'],
			name: 'Buy now',
			leaked: false,
		});
	});
});
