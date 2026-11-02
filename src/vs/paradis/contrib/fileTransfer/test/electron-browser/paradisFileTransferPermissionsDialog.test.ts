/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisPermissionsDialogOptions, paradisShowPermissionsDialog } from '../../electron-browser/paradisFileTransferPermissionsDialog.js';
import { paradisOpenAnotherModal } from '../../../paradisSettings/test/browser/paradisModalTestUtils.js';

suite('ParadisFileTransferPermissionsDialog', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the chosen permissions when another modal closes the dialog, restores them for the same items, and drops them on Cancel', async () => {
		const root = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(root);
		const options = (draftKey: string, initialMode = 0o644): IParadisPermissionsDialogOptions => ({
			title: 'deploy.sh', location: 'example:/srv/deploy.sh', initialMode, typeChar: '-', hasDirectory: false, draftKey,
		});
		const octal = () => root.querySelector<HTMLInputElement>('.para-ft-octal-input')!.value;
		const hasNote = () => (root.textContent ?? '').includes('保存する前に閉じた編集を戻しました');
		const view = () => ({ octal: octal(), note: hasNote() });
		const cancel = () => root.querySelector<HTMLButtonElement>('.para-ft-modal-buttons button.secondary')!.click();
		try {
			const first = paradisShowPermissionsDialog(root, options('remote\nfile-a'));
			// Turn on the owner's execute bit
			const ownerExecute = root.querySelectorAll<HTMLInputElement>('.para-ft-pgrid input')[2];
			ownerExecute.checked = true;
			ownerExecute.dispatchEvent(new Event('change'));
			const other = paradisOpenAnotherModal();
			const closedByOther = await first;
			other.dispose();

			const forOtherItem = paradisShowPermissionsDialog(root, options('remote\nfile-b'));
			const otherItemView = view();
			cancel();
			await forOtherItem;

			const modeChangedMeanwhile = paradisShowPermissionsDialog(root, options('remote\nfile-a', 0o600));
			const modeChangedView = view();
			cancel();
			await modeChangedMeanwhile;

			const second = paradisShowPermissionsDialog(root, options('remote\nfile-a'));
			const afterReopen = view();
			cancel();
			await second;

			const third = paradisShowPermissionsDialog(root, options('remote\nfile-a'));
			const afterCancel = view();
			cancel();
			await third;
			assert.deepStrictEqual({ closedByOther, otherItemView, modeChangedView, afterReopen, afterCancel, leftOpen: root.children.length }, {
				closedByOther: undefined,
				otherItemView: { octal: '644', note: false },
				modeChangedView: { octal: '600', note: false },
				afterReopen: { octal: '744', note: true },
				afterCancel: { octal: '644', note: false },
				leftOpen: 0,
			});
		} finally {
			root.remove();
		}
	});
});
