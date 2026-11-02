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
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IParadisElevenLabsDictionaryDetail, IParadisElevenLabsDictionaryListItem } from '../../common/paradisElevenLabs.js';
import { ParadisElevenLabsDictionaryEditorDialog } from '../../electron-browser/paradisElevenLabsDictionarySection.js';
import { paradisOpenAnotherModal } from '../../../paradisSettings/test/browser/paradisModalTestUtils.js';

suite('ParadisElevenLabsDictionaryEditor', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps unsaved rows per dictionary when another modal closes the box, restores them on the next open, and drops them on Cancel', async () => {
		const root = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(root);
		const detail = (id: string): IParadisElevenLabsDictionaryDetail => ({
			id, name: `Saved ${id}`, description: '', latestVersionId: 'v1', archived: false,
			rules: [{ type: 'alias', string_to_replace: 'Para', alias: 'ぱら' }],
		});
		const sharedProcessService = upcastPartial<ISharedProcessService>({
			getChannel: () => ({ call: async (_command: string, args: string[]) => detail(args[1]), listen: () => { throw new Error('not used'); } }) as never,
		});
		const layoutService = upcastPartial<ILayoutService>({ activeContainer: root });
		const item = (id: string): IParadisElevenLabsDictionaryListItem => ({ id, name: `Saved ${id}`, description: '', latestVersionId: 'v1', ruleCount: 1, createdAt: null });
		const open = async (id: string) => {
			const dialog = new ParadisElevenLabsDictionaryEditorDialog(layoutService, sharedProcessService, 'key', item(id), () => { });
			await timeout(0);
			return dialog;
		};
		const reading = () => [...root.querySelectorAll<HTMLInputElement>('.pns-dict-table tbody input')].map(input => input.value);
		const hasNote = () => (root.textContent ?? '').includes('保存する前に閉じた編集を戻しました');
		try {
			const first = await open('dict-a');
			const inputs = root.querySelectorAll<HTMLInputElement>('.pns-dict-table tbody input');
			inputs[1].value = 'ぱらこーど';
			inputs[1].dispatchEvent(new Event('input'));
			const other = paradisOpenAnotherModal();
			const closedByOther = root.children.length === 0;
			other.dispose();
			const otherDictionary = await open('dict-b');
			const forOtherDictionary = { rows: reading(), note: hasNote() };
			otherDictionary.dispose();
			const second = await open('dict-a');
			const afterReopen = { rows: reading(), note: hasNote() };
			const cancel = [...root.querySelectorAll<HTMLButtonElement>('.pns-nested-footer button')].find(button => !button.classList.contains('pns-btn-primary'))!;
			cancel.click();
			const third = await open('dict-a');
			const afterCancel = reading();
			third.dispose();
			second.dispose();
			first.dispose();
			assert.deepStrictEqual({ closedByOther, forOtherDictionary, afterReopen, afterCancel, leftOpen: root.children.length }, {
				closedByOther: true,
				forOtherDictionary: { rows: ['Para', 'ぱら'], note: false },
				afterReopen: { rows: ['Para', 'ぱらこーど'], note: true },
				afterCancel: ['Para', 'ぱら'],
				leftOpen: 0,
			});
		} finally {
			root.remove();
		}
	});
});
