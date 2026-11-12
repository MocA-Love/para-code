/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { IContextMenuDelegate } from '../../../../../base/browser/contextmenu.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Separator } from '../../../../../base/common/actions.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { openParadisPresetEditorDialog } from '../../browser/paradisPresetEditorDialog.js';
import { IParadisPresetService, IParadisResolvedPreset } from '../../common/paradisTerminalPresets.js';
import { IParadisDialogService } from '../../../confirmDialog/browser/paradisDialogService.js';

suite('preset editor dialog: row actions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('rows show only Run and ..., the default user source has no chip, the hints are gone, and unavailable moves say why', () => {
		const presets: IParadisResolvedPreset[] = [
			{ name: 'C', commands: ['claude'], source: 'user', sourceIndex: 0, key: 'user:0' } as unknown as IParadisResolvedPreset,
			{ name: 'X', commands: ['codex'], source: 'workspace', sourceUri: URI.file('/repo/.paracode.json'), sourceIndex: 0, key: 'workspace:0' } as unknown as IParadisResolvedPreset,
		];
		const presetService = { presets, folders: [], onDidChangePresets: Event.None, isFolderLabelShown: () => false } as unknown as IParadisPresetService;
		let menu: IContextMenuDelegate | undefined;
		const contextMenuService = { showContextMenu: (delegate: IContextMenuDelegate) => { menu = delegate; } } as unknown as IContextMenuService;
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const services = new Map<unknown, unknown>([
			[ILayoutService, { activeContainer: container }],
			[IParadisPresetService, presetService],
			[IDialogService, {}],
			[IParadisDialogService, {}],
			[IWorkspaceContextService, { getWorkspace: () => ({ folders: [] }) }],
			[IContextMenuService, contextMenuService],
			[IHoverService, NullHoverService],
			[IContextViewService, {}],
			[IConfigurationService, { getValue: () => undefined }],
		]);
		const accessor = { get: (id: unknown) => services.get(id) } as unknown as ServicesAccessor;
		try {
			openParadisPresetEditorDialog(accessor);
			const rows = [...container.querySelectorAll<HTMLElement>('.ppe-row')].map(row => ({
				name: row.querySelector('.ppe-row-name-text')?.textContent,
				chips: [...row.querySelectorAll('.ppe-badge')].map(chip => chip.textContent),
				buttons: [...row.querySelectorAll<HTMLElement>('.ppe-row-actions > button')].map(button => button.textContent || button.getAttribute('aria-label')),
			}));
			container.querySelector<HTMLElement>('.ppe-row .ppe-icon-btn')!.click();
			const menuItems = (menu?.getActions() ?? []).map(action => action instanceof Separator ? '-' : action.label);
			assert.deepStrictEqual({
				rows,
				menuItems,
				// 幕は fork のモーダルの段の印を持ち、メニューは layer を渡さずに本家のコンテキストビューの層へ出る
				// （どちらの段も paradisModal.ts の表。コンテキストビューはモーダルより上）
				menuLayer: menu?.layer,
				backdropOnModalLayer: container.querySelector('.paradis-preset-editor-backdrop')?.classList.contains('paradis-modal-backdrop'),
				hints: container.querySelector('.ppe-nav-hint') === null,
			}, {
				rows: [
					{ name: 'C', chips: [], buttons: ['実行', 'C のその他の操作'] },
					{ name: 'X', chips: ['リポジトリ'], buttons: ['実行', 'X のその他の操作'] },
				],
				menuItems: ['編集', '複製', '-', '上へ移動（一番上です）', '下へ移動（保存先（ユーザー設定 / .paracode.json）を跨いでは移せません）', '-', '削除...'],
				menuLayer: undefined,
				backdropOnModalLayer: true,
				hints: true,
			});
		} finally {
			container.querySelector<HTMLElement>('.ppe-close-btn')?.click();
			container.remove();
		}
	});
	test('safety: the confirm switch starts off; turning it on shows the levels at "show the details" and blocks auto-run; turning it on again starts over', async () => {
		const presetService = { presets: [], folders: [], onDidChangePresets: Event.None, isFolderLabelShown: () => false } as unknown as IParadisPresetService;
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const services = new Map<unknown, unknown>([
			[ILayoutService, { activeContainer: container }],
			[IParadisPresetService, presetService],
			[IDialogService, {}],
			[IParadisDialogService, { confirm: async () => ({ confirmed: true }) }],
			[IWorkspaceContextService, { getWorkspace: () => ({ folders: [] }) }],
			[IContextMenuService, {}],
			[IHoverService, NullHoverService],
			[IContextViewService, {}],
			[IConfigurationService, { getValue: () => undefined }],
		]);
		const accessor = { get: (id: unknown) => services.get(id) } as unknown as ServicesAccessor;
		try {
			openParadisPresetEditorDialog(accessor);
			[...container.querySelectorAll<HTMLElement>('button')].find(button => button.textContent?.includes('新規作成'))!.click();
			// 「新規作成」は書きかけの確認（非同期）の後でフォームを描く
			await new Promise(resolve => setTimeout(resolve, 0));
			const confirmSwitch = container.querySelector<HTMLButtonElement>('.ppe-confirm-switch button')!;
			const level = container.querySelector<HTMLElement>('.ppe-confirm-level')!;
			const autoRun = [...container.querySelectorAll<HTMLElement>('.ppe-switch-row')].find(row => row.textContent?.includes('自動実行'))!.querySelector<HTMLButtonElement>('button')!;
			const state = () => ({
				on: confirmSwitch.getAttribute('aria-checked'),
				levelShown: level.style.display !== 'none',
				level: level.querySelector('select')?.value,
				autoRunDisabled: autoRun.disabled,
			});
			const initial = state();
			confirmSwitch.click();
			const turnedOn = state();
			const select = level.querySelector('select')!;
			select.value = 'type-name';
			select.dispatchEvent(new mainWindow.Event('change', { bubbles: true }));
			confirmSwitch.click();
			const turnedOff = state();
			confirmSwitch.click();
			const turnedOnAgain = state();
			assert.deepStrictEqual({ initial, turnedOn, turnedOff, turnedOnAgain }, {
				initial: { on: 'false', levelShown: false, level: 'details', autoRunDisabled: false },
				turnedOn: { on: 'true', levelShown: true, level: 'details', autoRunDisabled: true },
				turnedOff: { on: 'false', levelShown: false, level: 'type-name', autoRunDisabled: false },
				turnedOnAgain: { on: 'true', levelShown: true, level: 'details', autoRunDisabled: true },
			});
		} finally {
			container.querySelector<HTMLElement>('.ppe-close-btn')?.click();
			// 書きかけを捨てる確認（非同期）の後で閉じる
			await new Promise(resolve => setTimeout(resolve, 0));
			container.remove();
		}
	});
	test('the dialog is named by its title, takes the focus when it opens, and closes on Escape right away', () => {
		const presetService = { presets: [], folders: [], onDidChangePresets: Event.None, isFolderLabelShown: () => false } as unknown as IParadisPresetService;
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const outside = mainWindow.document.createElement('button');
		mainWindow.document.body.appendChild(outside);
		const services = new Map<unknown, unknown>([
			[ILayoutService, { activeContainer: container }],
			[IParadisPresetService, presetService],
			[IDialogService, {}],
			[IParadisDialogService, {}],
			[IWorkspaceContextService, { getWorkspace: () => ({ folders: [] }) }],
			[IContextMenuService, {}],
			[IHoverService, NullHoverService],
			[IContextViewService, {}],
			[IConfigurationService, { getValue: () => undefined }],
		]);
		const accessor = { get: (id: unknown) => services.get(id) } as unknown as ServicesAccessor;
		try {
			outside.focus();
			openParadisPresetEditorDialog(accessor);
			const dialog = container.querySelector<HTMLElement>('.paradis-preset-editor-dialog')!;
			const opened = {
				role: dialog.getAttribute('role'),
				modal: dialog.getAttribute('aria-modal'),
				name: mainWindow.document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent,
				focusInside: dialog.contains(mainWindow.document.activeElement),
			};
			mainWindow.document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 27, bubbles: true }));
			assert.deepStrictEqual({ opened, closed: container.children.length === 0, focusBack: mainWindow.document.activeElement === outside }, {
				opened: { role: 'dialog', modal: 'true', name: 'コマンドプリセット', focusInside: true },
				closed: true,
				focusBack: true,
			});
		} finally {
			container.querySelector<HTMLElement>('.ppe-close-btn')?.click();
			container.remove();
			outside.remove();
		}
	});
});
