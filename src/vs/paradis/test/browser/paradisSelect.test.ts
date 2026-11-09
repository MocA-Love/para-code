/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IContextViewDelegate, IContextViewService } from '../../../platform/contextview/browser/contextView.js';
import { PARADIS_MODAL_POPUP_LAYER, ParadisSelect } from '../../browser/paradisSelect.js';

suite('ParadisSelect', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('draws the list itself above the modals, keeps the values on the element, and reports only what the user picks', () => {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const shown: IContextViewDelegate[] = [];
		const contextViewService = {
			showContextView: (delegate: IContextViewDelegate) => {
				shown.push(delegate);
				return { close: () => { } };
			},
			hideContextView: () => { },
			layout: () => { },
		} as unknown as IContextViewService;
		const configurationService = { getValue: () => undefined } as unknown as IConfigurationService;
		try {
			const select = store.add(new ParadisSelect(container, contextViewService, configurationService, [
				{ value: 'updated', label: '更新順' },
				{ value: 'created', label: '作成順' },
			], 'created', { ariaLabel: '並び', className: 'my-select' }));
			const changes: string[] = [];
			store.add(select.onDidChange(value => changes.push(value)));
			const element = container.querySelector('select')!;

			select.value = 'updated';
			const unchanged = select.setOptions([{ value: 'updated', label: '更新順' }, { value: 'created', label: '作成順' }]);
			const replaced = select.setOptions([{ value: 'title', label: '名前順' }, { value: 'updated', label: '更新順' }]);
			element.selectedIndex = 0;
			element.dispatchEvent(new Event('change'));
			element.click();

			assert.deepStrictEqual({
				ariaLabel: element.getAttribute('aria-label'),
				className: element.className,
				optionValues: [...element.options].map(option => option.value),
				value: select.value,
				unchanged,
				replaced,
				changes,
				layer: shown[0]?.layer,
			}, {
				ariaLabel: '並び',
				className: 'monaco-select-box my-select',
				optionValues: ['title', 'updated'],
				value: 'title',
				unchanged: false,
				replaced: true,
				// 代入（value・setOptions）では知らせず、利用者が選んだときだけ知らせる
				changes: ['title'],
				layer: PARADIS_MODAL_POPUP_LAYER,
			});
		} finally {
			container.remove();
		}
	});
	test('shows a value that is not among the choices instead of the first choice, so picking the first choice is saved', () => {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const contextViewService = { showContextView: () => ({ close: () => { } }), hideContextView: () => { }, layout: () => { } } as unknown as IContextViewService;
		const configurationService = { getValue: () => undefined } as unknown as IConfigurationService;
		try {
			const levels = [{ value: '50', label: '中 (50%)' }, { value: '100', label: '大 (100%)' }];
			const select = store.add(new ParadisSelect(container, contextViewService, configurationService, levels, '73', { ariaLabel: '音量' }));
			const changes: string[] = [];
			store.add(select.onDidChange(value => changes.push(value)));
			const element = container.querySelector('select')!;
			const shownAtOpen = [...element.options].map(option => `${option.value}:${option.text}`);
			const valueAtOpen = select.value;

			element.selectedIndex = 0;
			element.dispatchEvent(new Event('change'));
			// 一覧が後から届いたときも、保存済みの値は残す。値を省いた入れ替えでは、今の値が無ければ先頭に戻す
			select.setOptions(levels, 'old-model');
			const shownAfterLoad = [...element.options].map(option => option.value);
			select.setOptions([{ value: '', label: '既定' }]);

			assert.deepStrictEqual({ shownAtOpen, valueAtOpen, changes, shownAfterLoad, valueAfterReset: select.value, values: select.values.length }, {
				shownAtOpen: ['50:中 (50%)', '100:大 (100%)', '73:73'],
				valueAtOpen: '73',
				changes: ['50'],
				shownAfterLoad: ['50', '100', 'old-model'],
				valueAfterReset: '',
				values: 1,
			});
		} finally {
			container.remove();
		}
	});
});
