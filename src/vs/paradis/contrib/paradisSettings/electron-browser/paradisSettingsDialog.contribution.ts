/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「設定 (Para Code)」のコマンド登録と、歯車メニュー(左下)への項目追加。統合のモーダルに「設定」の領域を登録し、
// コマンドはその領域（以前の節の ID は、移った先の領域）を開く。
//
// 歯車メニューの項目はここ (electron-browser) だけから登録する。ダイアログが開く先の
// 通知設定・バインディング・使用量ダッシュボードがいずれも electron-browser 層でしか
// 登録されないため、Web ビルドで項目を出しても押した先が無い。Web 側は
// settingsMenu/browser/ 側のコマンド (標準の設定エディタを @id:paradis.* で開く) を
// コマンドパレットから使う。

import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ParadisHubAreaId, paradisRegisterHubArea } from '../../paradisHub/electron-browser/paradisHub.js';
import { paradisOpenHub } from '../../paradisHub/electron-browser/paradisHubOpen.js';
import { PARADIS_SETTINGS_LEGACY_NOTIFICATIONS_SECTION_ID, PARADIS_SETTINGS_LEGACY_USAGE_SECTION_ID, ParadisSettingsArea } from './paradisSettingsDialog.js';

export const PARADIS_OPEN_SETTINGS_DIALOG_COMMAND_ID = 'paradis.openSettingsDialog';

paradisRegisterHubArea({
	id: ParadisHubAreaId.Settings,
	// allow-any-unicode-next-line
	label: localize('paradis.settings.areaLabel', "設定"),
	order: 20,
	create: (instantiationService, containers, host) => instantiationService.createInstance(ParadisSettingsArea, containers, host),
});

/**
 * 節の ID を、統合のモーダルの領域と節へ読み替える。以前の「使用量」「通知」の節（`psd-sec-usage` / `psd-sec-notif`）は、
 * いまはそれぞれの領域にある（Q537 の 35 A）。
 */
export function paradisSettingsSectionTarget(sectionId: string | undefined): { readonly area: ParadisHubAreaId; readonly section?: string } {
	switch (sectionId) {
		case PARADIS_SETTINGS_LEGACY_USAGE_SECTION_ID: return { area: ParadisHubAreaId.Usage, section: 'settings' };
		case PARADIS_SETTINGS_LEGACY_NOTIFICATIONS_SECTION_ID: return { area: ParadisHubAreaId.Notifications };
		default: return { area: ParadisHubAreaId.Settings, section: sectionId };
	}
}

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

	/** @param sectionId 開いたときに出す節（例: メニューバーのアイコンから開くときの 'psd-sec-menubar'）。 */
	run(accessor: ServicesAccessor, sectionId?: unknown): void {
		const target = paradisSettingsSectionTarget(typeof sectionId === 'string' ? sectionId : undefined);
		paradisOpenHub(accessor, target.area, target.section);
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
