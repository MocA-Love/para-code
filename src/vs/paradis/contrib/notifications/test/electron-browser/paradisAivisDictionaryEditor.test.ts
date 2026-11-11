/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { timeout } from '../../../../../base/common/async.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IParadisAivisDictionaryDetail } from '../../common/paradisNotifications.js';
import { ParadisCreateDictionaryDialog, ParadisDictionaryEditorDialog } from '../../electron-browser/paradisAivisDictionarySection.js';
import { paradisOpenAnotherModal } from '../../../paradisSettings/test/browser/paradisModalTestUtils.js';

suite('ParadisAivisDictionaryEditor', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps unsaved edits as a draft when closed from outside, restores them on the next open, and drops them on Cancel', async () => {
		const root = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(root);
		const detail: IParadisAivisDictionaryDetail = {
			name: 'Saved name',
			description: '',
			word_properties: [{ uuid: 'w1', surface: ['Para'], pronunciation: ['パラ'], accent_type: [0], word_type: 'PROPER_NOUN', priority: 5 }],
			created_at: '',
			updated_at: '',
		};
		const sharedProcessService = upcastPartial<ISharedProcessService>({
			getChannel: () => ({ call: async () => detail, listen: () => { throw new Error('not used'); } }) as never,
		});
		const layoutService = upcastPartial<ILayoutService>({ activeContainer: root });
		const open = async () => {
			const dialog = new ParadisDictionaryEditorDialog(layoutService, sharedProcessService, 'dictionary-1', 'key', () => { }, Object.create(null), { getValue: () => undefined } as unknown as IConfigurationService);
			await timeout(0);
			return dialog;
		};
		const nameInput = () => root.querySelector<HTMLInputElement>('.pns-field input')!;
		try {
			const first = await open();
			nameInput().value = 'Typed but not saved';
			nameInput().dispatchEvent(new Event('input'));
			// Another modal (or the Hub closing) disposes the box without the user pressing Cancel
			first.dispose();
			const second = await open();
			const afterReopen = { name: nameInput().value, note: (root.textContent ?? '').includes('保存する前に閉じた編集を戻しました') };
			const cancel = [...root.querySelectorAll<HTMLElement>('.paradis-modal-foot .paradis-button')].find(button => !button.classList.contains('paradis-button-primary'))!;
			cancel.click();
			const third = await open();
			const afterCancel = nameInput().value;
			third.dispose();
			second.dispose();
			assert.deepStrictEqual({ afterReopen, afterCancel, leftOpen: root.children.length }, {
				afterReopen: { name: 'Typed but not saved', note: true },
				afterCancel: 'Saved name',
				leftOpen: 0,
			});
		} finally {
			root.remove();
		}
	});

	test('the new dictionary box keeps typed text when another modal closes it, restores it on the next open, and drops it on Cancel', () => {
		const root = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(root);
		const sharedProcessService = upcastPartial<ISharedProcessService>({});
		const layoutService = upcastPartial<ILayoutService>({ activeContainer: root });
		const open = () => new ParadisCreateDictionaryDialog(layoutService, sharedProcessService, 'key', () => { });
		const inputs = () => [...root.querySelectorAll<HTMLInputElement>('.pns-field input')];
		try {
			const first = open();
			inputs()[0].value = 'New words';
			inputs()[1].value = 'Typed but not created';
			// Another modal opened from the command palette closes the box
			const other = paradisOpenAnotherModal();
			const closedByOther = root.children.length === 0;
			other.dispose();
			const second = open();
			const afterReopen = { values: inputs().map(input => input.value), note: (root.textContent ?? '').includes('保存する前に閉じた編集を戻しました') };
			const cancel = [...root.querySelectorAll<HTMLElement>('.paradis-modal-foot .paradis-button')].find(button => !button.classList.contains('paradis-button-primary'))!;
			cancel.click();
			const third = open();
			const afterCancel = inputs().map(input => input.value);
			third.dispose();
			second.dispose();
			first.dispose();
			assert.deepStrictEqual({ closedByOther, afterReopen, afterCancel, leftOpen: root.children.length }, {
				closedByOther: true,
				afterReopen: { values: ['New words', 'Typed but not created'], note: true },
				afterCancel: ['', ''],
				leftOpen: 0,
			});
		} finally {
			root.remove();
		}
	});
});
