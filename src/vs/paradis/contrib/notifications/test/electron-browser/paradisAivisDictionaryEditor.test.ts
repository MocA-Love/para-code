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
import { ParadisAivisDictionarySection, ParadisCreateDictionaryDialog, ParadisDictionaryEditorDialog } from '../../electron-browser/paradisAivisDictionarySection.js';
import { invalidateAivisDictionaryListCache, setCachedAivisDictionaryList } from '../../electron-browser/paradisAivisApiCache.js';
import { IParadisNotificationsSettingsService } from '../../browser/paradisNotificationsSettings.js';
import { IParadisDialogService } from '../../../confirmDialog/browser/paradisDialogService.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { Event as BaseEvent } from '../../../../../base/common/event.js';
import { paradisOpenAnotherModal } from '../../../paradisSettings/test/browser/paradisModalTestUtils.js';
import { IFileDialogService, ISaveDialogOptions } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';

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

	test('shows why deleting or exporting a dictionary failed', async () => {
		const root = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(root);
		const apiKey = 'dictionary-section-test-key';
		setCachedAivisDictionaryList(apiKey, [{ uuid: 'd1', name: 'Words', description: '', word_count: 1, created_at: '', updated_at: '2026-01-01' }]);
		const sharedProcessService = upcastPartial<ISharedProcessService>({
			getChannel: () => ({ call: async (command: string) => { throw new Error(`${command} failed: 401`); }, listen: () => { throw new Error('not used'); } }) as never,
		});
		const settingsService = upcastPartial<IParadisNotificationsSettingsService>({
			onDidChange: BaseEvent.None,
			getAivisSettings: () => ({ engine: 'aivis', apiKey, userDictionaryUuid: '' }) as ReturnType<IParadisNotificationsSettingsService['getAivisSettings']>,
		});
		const dialogService = upcastPartial<IParadisDialogService>({ confirm: async () => ({ confirmed: true }) });
		const section = new ParadisAivisDictionarySection(root, sharedProcessService, settingsService, dialogService, upcastPartial<ILayoutService>({ activeContainer: root }), new NullLogService(), upcastPartial<IContextViewService>({}), { getValue: () => undefined } as unknown as IConfigurationService, NullHoverService, upcastPartial<IFileDialogService>({}), upcastPartial<IFileService>({}));
		const errorText = () => root.querySelector('.pns-error')?.textContent ?? '';
		const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('.pns-dict-actions button')];
		try {
			buttons().find(button => button.classList.contains('pns-delete'))!.click();
			await timeout(0);
			const afterDelete = errorText();
			buttons()[buttons().length - 2].click();
			await timeout(0);
			const afterExport = errorText();
			assert.deepStrictEqual({ afterDelete, afterExport }, {
				afterDelete: 'deleteAivisDictionary failed: 401',
				afterExport: 'exportAivisDictionary failed: 401',
			});
		} finally {
			section.dispose();
			invalidateAivisDictionaryListCache(apiKey);
			root.remove();
		}
	});

	test('exports a dictionary to the file picked in the save dialog, on the local disk, and writes nothing when cancelled', async () => {
		const root = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(root);
		const apiKey = 'dictionary-export-test-key';
		setCachedAivisDictionaryList(apiKey, [{ uuid: 'd1', name: 'My/Words', description: '', word_count: 1, created_at: '', updated_at: '2026-01-01' }]);
		const sharedProcessService = upcastPartial<ISharedProcessService>({
			getChannel: () => ({ call: async () => ({ d1: { surface: 'Para' } }), listen: () => { throw new Error('not used'); } }) as never,
		});
		const settingsService = upcastPartial<IParadisNotificationsSettingsService>({
			onDidChange: BaseEvent.None,
			getAivisSettings: () => ({ engine: 'aivis', apiKey, userDictionaryUuid: '' }) as ReturnType<IParadisNotificationsSettingsService['getAivisSettings']>,
		});
		const asked: { defaultUri: string | undefined; availableFileSystems: readonly string[] | undefined }[] = [];
		const answers: (URI | undefined)[] = [URI.file('/picked/words.json'), undefined];
		const fileDialogService = upcastPartial<IFileDialogService>({
			defaultFilePath: async () => URI.file('/home'),
			showSaveDialog: async (options: ISaveDialogOptions) => {
				asked.push({ defaultUri: options.defaultUri?.path, availableFileSystems: options.availableFileSystems });
				return answers.shift();
			},
		});
		const written: { path: string; text: string }[] = [];
		const fileService = upcastPartial<IFileService>({
			writeFile: async (resource: URI, content: VSBuffer) => {
				written.push({ path: resource.path, text: content.toString() });
				return undefined as never;
			},
		});
		const dialogService = upcastPartial<IParadisDialogService>({});
		const section = new ParadisAivisDictionarySection(root, sharedProcessService, settingsService, dialogService, upcastPartial<ILayoutService>({ activeContainer: root }), new NullLogService(), upcastPartial<IContextViewService>({}), { getValue: () => undefined } as unknown as IConfigurationService, NullHoverService, fileDialogService, fileService);
		const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('.pns-dict-actions button')];
		try {
			buttons()[buttons().length - 2].click();
			await timeout(0);
			buttons()[buttons().length - 2].click();
			await timeout(0);
			assert.deepStrictEqual({ asked, written, error: root.querySelector('.pns-error')?.textContent ?? '' }, {
				asked: [
					{ defaultUri: '/home/My_Words.aivisspeech.json', availableFileSystems: ['file'] },
					{ defaultUri: '/home/My_Words.aivisspeech.json', availableFileSystems: ['file'] },
				],
				written: [{ path: '/picked/words.json', text: JSON.stringify({ d1: { surface: 'Para' } }, null, 2) }],
				error: '',
			});
		} finally {
			section.dispose();
			invalidateAivisDictionaryListCache(apiKey);
			root.remove();
		}
	});
});
