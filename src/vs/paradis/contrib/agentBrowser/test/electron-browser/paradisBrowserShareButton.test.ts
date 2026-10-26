/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Action } from '../../../../../base/common/actions.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { BrowserViewSharingState, IBrowserViewModel } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserEditor } from '../../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { IParadisAgentBrowserBindingModel, IParadisPageShare } from '../../electron-browser/paradisAgentBrowserBindingModel.js';
import { IParadisAgentBrowserTabsService } from '../../electron-browser/paradisAgentBrowserTabsService.js';
import { ParadisBrowserShareActionViewItem, paradisShareButtonTarget } from '../../electron-browser/paradisBrowserShareButton.js';

suite('ParadisBrowserShareActionViewItem', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let shares: IParadisPageShare[];
	let onDidChangeBindings: Emitter<void>;
	let dialogRuns: number;
	let container: HTMLElement;
	let item: ParadisBrowserShareActionViewItem;

	setup(() => {
		shares = [];
		dialogRuns = 0;
		onDidChangeBindings = store.add(new Emitter<void>());
		container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);

		const bindingModel = upcastPartial<IParadisAgentBrowserBindingModel>({
			onDidChange: onDidChangeBindings.event,
			getPageShares: () => shares,
			getPanes: () => [],
		});
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IParadisAgentBrowserBindingModel, bindingModel);
		instantiationService.stub(IParadisAgentBrowserTabsService, {});
		instantiationService.stub(ILayoutService, { getContainer: () => container });

		const model = upcastPartial<IBrowserViewModel>({
			id: 'page',
			sharingState: BrowserViewSharingState.Available,
			onDidChangeSharingState: Event.None,
		});
		const editor: BrowserEditor = Object.create(BrowserEditor.prototype);
		Object.defineProperty(editor, 'model', { value: model });
		Object.defineProperty(editor, 'onDidChangeModel', { value: Event.None });

		const action = store.add(new Action('share', 'Share', undefined, true, async () => { dialogRuns++; }));
		item = store.add(new ParadisBrowserShareActionViewItem(action, {}, bindingModel, NullHoverService, instantiationService));
		item.setActionContext(editor);
		const element = mainWindow.document.createElement('div');
		container.appendChild(element);
		item.render(element);
	});

	teardown(() => {
		container.remove();
	});

	function part(selector: string): HTMLElement {
		return container.querySelector<HTMLElement>(selector)!;
	}

	function share(): void {
		shares = [{ token: 'pane', kind: 'user' }];
		onDidChangeBindings.fire();
	}

	function snapshot() {
		const main = part('.paradis-browser-share-main');
		const list = part('.paradis-browser-share-list-button');
		return {
			checked: part('.paradis-browser-share-item').classList.contains('checked'),
			badge: part('.paradis-browser-share-badge').textContent,
			mainLabel: main.getAttribute('aria-label'),
			listHidden: list.hidden,
			listLabel: list.getAttribute('aria-label'),
			dialogRuns,
			popover: !!container.querySelector('.paradis-browser-share-popover'),
		};
	}

	const KEY_CODES: Record<string, number> = { ArrowLeft: 37, ArrowRight: 39, Enter: 13, Escape: 27 };

	function key(target: HTMLElement, keyName: string): void {
		target.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, code: keyName, keyCode: KEY_CODES[keyName], bubbles: true }));
	}

	// 本体はいつもダイアログ。▾ は共有があるときだけ一覧
	test('opens the dialog from the main part and the list only from the chevron while shared', () => {
		assert.deepStrictEqual(
			[paradisShareButtonTarget('main', 0), paradisShareButtonTarget('main', 2), paradisShareButtonTarget('list', 2), paradisShareButtonTarget('list', 0)],
			['dialog', 'dialog', 'list', 'dialog'],
		);
	});

	test('shows the chevron only while shared, and the main part opens the dialog either way', () => {
		const states: ReturnType<typeof snapshot>[] = [];
		part('.paradis-browser-share-main').click();
		states.push(snapshot());
		share();
		part('.paradis-browser-share-main').click();
		states.push(snapshot());
		part('.paradis-browser-share-list-button').click();
		states.push(snapshot());
		assert.deepStrictEqual(states, [
			{ checked: false, badge: '', mainLabel: 'エージェントと共有', listHidden: true, listLabel: 'このページを使えるペインの一覧（0 件）', dialogRuns: 1, popover: false },
			{ checked: true, badge: '1', mainLabel: 'エージェントと共有中: 1 件（クリックで共有の設定）', listHidden: false, listLabel: 'このページを使えるペインの一覧（1 件）', dialogRuns: 2, popover: false },
			{ checked: true, badge: '1', mainLabel: 'エージェントと共有中: 1 件（クリックで共有の設定）', listHidden: false, listLabel: 'このページを使えるペインの一覧（1 件）', dialogRuns: 2, popover: true },
		]);
	});

	// キーボード: 左右の矢印で本体と ▾ を行き来し、Enter で押す。一覧を閉じたらフォーカスは ▾ へ戻る
	test('moves between the parts with the arrow keys and presses them with Enter', () => {
		share();
		const main = part('.paradis-browser-share-main');
		const list = part('.paradis-browser-share-list-button');
		item.focus();
		const focused = [mainWindow.document.activeElement === main];
		key(main, 'ArrowRight');
		focused.push(mainWindow.document.activeElement === list);
		key(list, 'Enter');
		const opened = snapshot().popover;
		key(part('.paradis-browser-share-popover'), 'Escape');
		focused.push(mainWindow.document.activeElement === list);
		key(list, 'ArrowLeft');
		focused.push(mainWindow.document.activeElement === main);
		key(main, 'Enter');
		assert.deepStrictEqual({ focused, opened, after: snapshot() }, {
			focused: [true, true, true, true],
			opened: true,
			after: { checked: true, badge: '1', mainLabel: 'エージェントと共有中: 1 件（クリックで共有の設定）', listHidden: false, listLabel: 'このページを使えるペインの一覧（1 件）', dialogRuns: 1, popover: false },
		});
	});

	// 共有が無くなったら ▾ を隠し、▾ にあったフォーカスは本体へ移す
	test('hides the chevron when the last share goes away and keeps the focus on the button', () => {
		share();
		item.focus(true);
		shares = [];
		onDidChangeBindings.fire();
		assert.deepStrictEqual({ listHidden: snapshot().listHidden, mainFocused: mainWindow.document.activeElement === part('.paradis-browser-share-main') }, { listHidden: true, mainFocused: true });
	});
});
