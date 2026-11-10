/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../base/browser/window.js';
import { Codicon } from '../../../base/common/codicons.js';
import { AppResourcePath, FileAccess } from '../../../base/common/network.js';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IContextViewDelegate, IContextViewService } from '../../../platform/contextview/browser/contextView.js';
import { IParadisComboGroup, IParadisComboItem, ParadisComboBox, paradisComboRows } from '../../browser/paradisComboBox.js';

// 寸法を computed style で確かめるため、部品の CSS を link で読み込んで読み込み終わりを待つ（paradisUiParts.test.ts と同じ）。
const STYLESHEETS: AppResourcePath[] = [
	'vs/paradis/browser/media/paradisTokens.css',
	'vs/paradis/browser/media/paradisButton.css',
	'vs/paradis/browser/media/paradisBadges.css',
	'vs/paradis/browser/media/paradisInputField.css',
	'vs/paradis/browser/media/paradisComboBox.css',
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

suite('ParadisComboBox', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const groups: IParadisComboGroup[] = [
		{ label: 'ローカル', icon: Codicon.gitBranch, items: [{ id: 'local:main', label: 'main', chip: '使用中' }, { id: 'local:feature/login', label: 'feature/login', detail: '5 日前' }] },
		{ label: 'origin', icon: Codicon.cloud, items: [{ id: 'origin:dependabot/npm_and_yarn/a-very-long-branch-name-that-does-not-fit', label: 'dependabot/npm_and_yarn/a-very-long-branch-name-that-does-not-fit', prefix: 'origin/', detail: '3 日前' }, { id: 'origin:feature/login', label: 'feature/login', prefix: 'origin/', detail: 'ローカルにもあり' }] },
	];

	/** コンテキストビューの代わりに、渡された入れ物へその場で描く。 */
	function fakeContextView(host: HTMLElement): { service: IContextViewService; shown: IContextViewDelegate[] } {
		const shown: IContextViewDelegate[] = [];
		let rendered: IDisposable | undefined;
		let current: IContextViewDelegate | undefined;
		const hide = () => {
			rendered?.dispose();
			rendered = undefined;
			const delegate = current;
			current = undefined;
			delegate?.onHide?.();
		};
		const service = {
			showContextView: (delegate: IContextViewDelegate) => {
				hide();
				shown.push(delegate);
				current = delegate;
				rendered = delegate.render(host);
				return { close: hide };
			},
			hideContextView: hide,
			layout: () => { },
		} as unknown as IContextViewService;
		return { service, shown };
	}

	const KEY_CODES: Record<string, number> = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Escape: 27 };
	function key(target: HTMLElement, key: string): KeyboardEvent {
		const event = new KeyboardEvent('keydown', { key, code: key, keyCode: KEY_CODES[key], bubbles: true, cancelable: true });
		target.dispatchEvent(event);
		return event;
	}

	function type(input: HTMLInputElement, value: string): void {
		input.value = value;
		input.dispatchEvent(new Event('input', { bubbles: true }));
	}

	test('filters both groups by typing, skips the headings with the arrow keys, picks with Enter, and closes only itself with Escape', () => {
		const container = mainWindow.document.createElement('div');
		container.style.width = '600px';
		const popupHost = mainWindow.document.createElement('div');
		mainWindow.document.body.append(container, popupHost);
		try {
			const { service, shown } = fakeContextView(popupHost);
			const combo = store.add(new ParadisComboBox(container, service, { ariaLabel: 'ブランチ', placeholder: '探す', emptyLabel: '無し', footer: '↑↓' }));
			combo.setGroups(groups);
			const picked: IParadisComboItem[] = [];
			store.add(combo.onDidSelect(item => picked.push(item)));
			const outsideKeys: string[] = [];
			const onOutside = (e: KeyboardEvent) => outsideKeys.push(e.key);
			container.addEventListener('keydown', onOutside);
			const input = combo.inputElement;

			key(input, 'ArrowDown');
			const opened = { expanded: input.getAttribute('aria-expanded'), role: input.getAttribute('role'), controls: input.getAttribute('aria-controls') === popupHost.querySelector('.monaco-list')?.id };
			type(input, 'LOGIN');
			const rowTexts = [...popupHost.querySelectorAll('.monaco-list-row')].map(row => row.textContent);
			const roles = [...popupHost.querySelectorAll('.monaco-list-row')].map(row => row.getAttribute('role'));
			// 先頭の候補に注目している。↓ で次の候補へ（見出しの行を飛ばす）
			key(input, 'ArrowDown');
			const activeLabel = mainWindow.document.getElementById(input.getAttribute('aria-activedescendant')!)?.getAttribute('aria-label');
			key(input, 'Enter');
			const afterPick = { value: input.value, open: combo.isOpen, expanded: input.getAttribute('aria-expanded') };
			// 開いていないときの Esc は外側へ通す（モーダルが閉じる）。開いているときは一覧だけを閉じる
			key(input, 'Escape');
			key(input, 'ArrowDown');
			const escape = key(input, 'Escape');
			container.removeEventListener('keydown', onOutside);

			assert.deepStrictEqual({ opened, rowTexts, roles, activeLabel, picked: picked.map(item => item.id), afterPick, escapePrevented: escape.defaultPrevented, outsideKeys, stillOpen: combo.isOpen, shown: shown.length }, {
				opened: { expanded: 'true', role: 'combobox', controls: true },
				rowTexts: ['ローカル1', 'feature/login5 日前', 'origin1', 'origin/feature/loginローカルにもあり'],
				roles: ['presentation', 'option', 'presentation', 'option'],
				activeLabel: 'origin/feature/login, origin, ローカルにもあり',
				picked: ['origin:feature/login'],
				afterPick: { value: 'origin/feature/login', open: false, expanded: 'false' },
				escapePrevented: true,
				// 閉じているときの Esc と、開くための ↓ は外側に届く。開いているときの Esc は届かない
				outsideKeys: ['ArrowDown', 'ArrowDown', 'Escape', 'ArrowDown'],
				stillOpen: false,
				shown: 2,
			});
		} finally {
			container.remove();
			popupHost.remove();
		}
	});

	test('keeps the popup inside a 390px window and cuts long names with an ellipsis and a title', async () => {
		const links = await Promise.all(STYLESHEETS.map(loadStylesheet));
		// 幅 390 の窓のダイアログの本文（左右の余白を除いた 340px）に置いた欄
		const workbench = mainWindow.document.createElement('div');
		workbench.className = 'monaco-workbench';
		const container = mainWindow.document.createElement('div');
		container.style.cssText = 'position: fixed; left: 25px; top: 10px; width: 340px;';
		const popupHost = mainWindow.document.createElement('div');
		popupHost.style.cssText = 'position: fixed; left: 25px; top: 44px;';
		workbench.append(container, popupHost);
		mainWindow.document.body.append(workbench);
		try {
			const { service } = fakeContextView(popupHost);
			const combo = store.add(new ParadisComboBox(container, service, { ariaLabel: 'ブランチ', placeholder: '探す', emptyLabel: '無し' }));
			combo.setGroups(groups);
			combo.setNotice({ icon: Codicon.warning, text: 'origin に接続できません。前回（2 時間前）の一覧です', warning: true, actionLabel: '再試行' });
			combo.open();
			const popup = popupHost.querySelector<HTMLElement>('.paradis-combo-popup')!;
			const width = Number.parseFloat(popup.style.width);
			const rows = [...popupHost.querySelectorAll<HTMLElement>('.paradis-combo-item')];
			const longRow = rows.find(row => row.title.startsWith('origin/dependabot'));
			assert.ok(longRow, `rendered rows: ${rows.map(row => row.title).join(' | ')} (list ${popup.querySelector<HTMLElement>('.paradis-combo-list')?.style.height}, window ${mainWindow.innerWidth}x${mainWindow.innerHeight}, popup ${popup.offsetHeight})`);
			const name = longRow.querySelector<HTMLElement>('.paradis-combo-item-name')!;
			const noticeButton = popup.querySelector<HTMLElement>('.paradis-combo-notice .paradis-button')!;
			assert.deepStrictEqual({
				// 窓の幅 390 から左右 4px ずつを除いた中に収まる
				fitsIn390: 25 + width <= 390 - 4,
				atMost360: width <= 360,
				nameOverflow: name.scrollWidth > name.clientWidth,
				nameEllipsis: mainWindow.getComputedStyle(name).textOverflow,
				title: longRow.title,
				rowFits: longRow.scrollWidth <= longRow.clientWidth,
				notice: popup.querySelector('.paradis-combo-notice-text')?.textContent,
				noticeButtonShown: !noticeButton.classList.contains('hidden'),
			}, {
				fitsIn390: true,
				atMost360: true,
				nameOverflow: true,
				nameEllipsis: 'ellipsis',
				title: 'origin/dependabot/npm_and_yarn/a-very-long-branch-name-that-does-not-fit',
				rowFits: true,
				notice: 'origin に接続できません。前回（2 時間前）の一覧です',
				noticeButtonShown: true,
			});
			combo.close();
		} finally {
			workbench.remove();
			links.forEach(link => link.remove());
		}
	});

	test('filters case-insensitively including the prefix and drops empty groups', () => {
		assert.deepStrictEqual(paradisComboRows(groups, 'origin/FEAT').map(row => row.kind === 'item' ? row.item.id : `# ${row.label} ${row.count}`), [
			'# origin 1',
			'origin:feature/login',
		]);
	});
});
