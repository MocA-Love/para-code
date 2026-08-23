/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「設定 (Para Code)」ダイアログのコマンド登録と、歯車メニュー(左下)への項目追加。
//
// 歯車メニューの項目はここ (electron-browser) だけから登録する。ダイアログが開く先の
// 通知設定・バインディング・使用量ダッシュボードがいずれも electron-browser 層でしか
// 登録されないため、Web ビルドで項目を出しても押した先が無い。Web 側は
// settingsMenu/browser/ 側のコマンド (標準の設定エディタを @id:paradis.* で開く) を
// コマンドパレットから使う。

import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ParadisSettingsDialog } from './paradisSettingsDialog.js';

export const PARADIS_OPEN_SETTINGS_DIALOG_COMMAND_ID = 'paradis.openSettingsDialog';

/** 同時に1つだけ開く (通知設定ダイアログ・バインディングダイアログと同じ方式)。 */
let activeDialog: ParadisSettingsDialog | undefined;

class ParadisOpenSettingsDialogAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_OPEN_SETTINGS_DIALOG_COMMAND_ID,
			// allow-any-unicode-next-line
			title: localize2('paradis.openSettingsDialog', "設定 (Para Code)"),
			// allow-any-unicode-next-line
			category: localize2('paradis.settingsDialog.category', "Para Code"),
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		activeDialog?.dispose();
		activeDialog = accessor.get(IInstantiationService).createInstance(ParadisSettingsDialog);
	}
}

registerAction2(ParadisOpenSettingsDialogAction);

// group '2_configuration' の並びは Profiles(1) / Settings(2) / Extensions(3) / ... なので、
// Settings の直後に来るよう order は 2 と 3 の間の小数にする (upstream 側のorder値は変更しない)
MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
	group: '2_configuration',
	order: 2.5,
	command: {
		id: PARADIS_OPEN_SETTINGS_DIALOG_COMMAND_ID,
		// allow-any-unicode-next-line
		title: localize('paradis.openSettingsDialog.menu', "設定 (Para Code)"),
	},
});
