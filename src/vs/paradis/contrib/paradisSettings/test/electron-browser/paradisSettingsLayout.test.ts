/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { AppResourcePath, FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisButton } from '../../../../browser/paradisButton.js';
import { ParadisInputField } from '../../../../browser/paradisInputField.js';
import { ParadisSwitch } from '../../../../browser/paradisSwitch.js';

// 設定の行（名前・説明・右端の部品）の形を、実物の CSS で組んで寸法を確かめる。
const STYLESHEETS: AppResourcePath[] = [
	'vs/paradis/browser/media/paradisTokens.css',
	'vs/paradis/browser/media/paradisButton.css',
	'vs/paradis/browser/media/paradisSwitch.css',
	'vs/paradis/browser/media/paradisInputField.css',
	'vs/paradis/contrib/paradisSettings/electron-browser/media/paradisSettingsDialog.css',
];

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

suite('Paradis settings rows', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let workbench: HTMLElement;
	let links: HTMLLinkElement[] = [];

	setup(async () => {
		workbench = mainWindow.document.createElement('div');
		workbench.className = 'monaco-workbench';
		mainWindow.document.body.appendChild(workbench);
		links = await Promise.all(STYLESHEETS.map(loadStylesheet));
	});

	teardown(() => {
		workbench.remove();
		for (const link of links) {
			link.remove();
		}
		links = [];
	});

	/** 本文の幅 `width` の設定の領域に、入力欄・ボタン・スイッチの行を 1 つずつ置く。 */
	function buildRows(width: number) {
		const area = mainWindow.document.createElement('div');
		area.className = 'paradis-settings-area';
		area.style.display = 'flex';
		area.style.width = `${width}px`;
		workbench.appendChild(area);
		const content = mainWindow.document.createElement('div');
		content.className = 'psd-content';
		area.appendChild(content);
		const row = (label: string) => {
			const element = mainWindow.document.createElement('div');
			element.className = 'psd-row';
			const main = mainWindow.document.createElement('div');
			main.className = 'psd-row-main';
			const name = mainWindow.document.createElement('div');
			name.className = 'psd-row-label';
			name.textContent = label;
			const desc = mainWindow.document.createElement('div');
			desc.className = 'psd-row-desc';
			desc.textContent = 'エージェントの一覧は、新しいスペースで選べるエージェントと、モデル・エフォート・権限の候補を編集します。書き換えると、インストール済みの一覧は使わなくなります。';
			main.append(name, desc);
			element.appendChild(main);
			content.appendChild(element);
			return element;
		};
		const fieldRow = row('既定のエージェント');
		const field = store.add(new ParadisInputField(fieldRow, { ariaLabel: '既定のエージェント', small: true }));
		field.element.classList.add('psd-input');
		const buttonRow = row('エージェントの一覧');
		store.add(new ParadisButton(buttonRow, { kind: 'secondary', label: '設定エディタで開く' }));
		const switchRow = row('終わったエージェントを休止する');
		store.add(new ParadisSwitch(switchRow, { checked: true, ariaLabel: '休止する' }));
		return { content, rows: [fieldRow, buttonRow, switchRow] };
	}

	test('a wide body keeps each control at the right end of its row; rows are at least 52px', () => {
		const { rows } = buildRows(900);
		const layout = rows.map(row => {
			const main = (row.firstElementChild as HTMLElement).getBoundingClientRect();
			const control = (row.lastElementChild as HTMLElement).getBoundingClientRect();
			return { controlBesideText: Math.round(control.top) < Math.round(main.bottom) && control.left >= main.right, atLeast52: row.getBoundingClientRect().height >= 52 };
		});
		assert.deepStrictEqual(layout, [
			{ controlBesideText: true, atLeast52: true },
			{ controlBesideText: true, atLeast52: true },
			{ controlBesideText: true, atLeast52: true },
		]);
	});

	test('a 390px window: nothing runs past the body; the field and the button go below the text, the switch stays beside it', () => {
		// 390px の窓の L 段の箱（95vw）から、本文の左右の余白を引いた幅
		const { content, rows } = buildRows(370);
		const right = content.getBoundingClientRect().right;
		const layout = rows.map(row => {
			const main = (row.firstElementChild as HTMLElement).getBoundingClientRect();
			const control = (row.lastElementChild as HTMLElement).getBoundingClientRect();
			return { below: control.top >= main.bottom, inside: control.right <= right + 0.5 && main.right <= right + 0.5 };
		});
		assert.deepStrictEqual({ scrollsSideways: content.scrollWidth > content.clientWidth, layout }, {
			scrollsSideways: false,
			layout: [
				{ below: true, inside: true },
				{ below: true, inside: true },
				{ below: false, inside: true },
			],
		});
	});
});
