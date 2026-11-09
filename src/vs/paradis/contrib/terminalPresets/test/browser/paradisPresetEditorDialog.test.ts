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
});
