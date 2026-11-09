/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ResultKind } from '../../../../../platform/keybinding/common/keybindingResolver.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IHostService } from '../../../../../workbench/services/host/browser/host.js';
import { IParadisConfirmServices, PARADIS_CONFIRM_DIALOG_CLASS, paradisConfirm } from '../../browser/paradisConfirmDialog.js';

suite('Paradis confirm dialog', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let container: HTMLElement;
	let services: IParadisConfirmServices;

	setup(() => {
		container = mainWindow.document.createElement('div');
		container.className = 'monaco-workbench';
		mainWindow.document.body.appendChild(container);
		services = {
			layoutService: { activeContainer: container } as unknown as ILayoutService,
			keybindingService: { softDispatch: () => ({ kind: ResultKind.NoMatchingKb }) } as unknown as IKeybindingService,
			hostService: { setWindowDimmed: () => { } } as unknown as IHostService,
		};
	});

	teardown(() => container.remove());

	test('upstream Dialog (modal, labelled by the question) with the kit classes; the action button is the danger button, cancel is secondary and comes back as undefined on Escape', async () => {
		const pending = paradisConfirm(services, {
			message: 'プリセット「npm run dev」を削除しますか？',
			detail: '同じ名前のプリセットが他に1件ありますが、そちらは残ります。',
			buttons: [{ label: '削除', kind: 'danger', run: () => 'deleted' }],
			cancelLabel: 'キャンセル',
		});
		const box = container.querySelector<HTMLElement>('.monaco-dialog-box')!;
		const buttons = [...box.querySelectorAll<HTMLElement>('.dialog-buttons .monaco-button')];
		const shown = {
			kit: box.classList.contains(PARADIS_CONFIRM_DIALOG_CLASS),
			role: box.getAttribute('role'),
			modal: box.getAttribute('aria-modal'),
			labelledBy: box.getAttribute('aria-labelledby'),
			// ボタンの並び（取消が先か後か）は OS ごとに本家が決めるので、並びは見ない。inline の色が無いことは見る
			buttons: buttons.map(button => `${button.textContent}:${button.classList.contains('paradis-button-danger') ? 'danger' : button.classList.contains('paradis-button-secondary') ? 'secondary' : 'other'}:${button.style.backgroundColor}`).sort(),
		};
		// 本家は Esc を押して離したときに取消にする
		for (const type of ['keydown', 'keyup']) {
			box.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
		}
		const result = await pending;
		assert.deepStrictEqual({ shown, result, closed: container.querySelector('.monaco-dialog-box') === null }, {
			shown: {
				kit: true,
				role: 'dialog',
				modal: 'true',
				labelledBy: 'monaco-dialog-icon monaco-dialog-message-text',
				buttons: ['キャンセル:secondary:', '削除:danger:'],
			},
			result: undefined,
			closed: true,
		});
	});

	test('pressing the action button returns its result', async () => {
		const pending = paradisConfirm(services, {
			message: 'フォルダ「dev」を削除しますか？',
			buttons: [
				{ label: 'フォルダだけ消す', kind: 'primary', run: () => 'keep' },
				{ label: '中身ごと消す', kind: 'danger', run: () => 'deleteAll' },
			],
		});
		const all = [...container.querySelectorAll<HTMLElement>('.dialog-buttons .monaco-button')];
		all.find(button => button.textContent === '中身ごと消す')!.click();
		assert.deepStrictEqual({ labels: all.map(button => button.textContent).sort(), result: await pending }, {
			labels: ['キャンセル', 'フォルダだけ消す', '中身ごと消す'].sort(),
			result: 'deleteAll',
		});
	});
});
