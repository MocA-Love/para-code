/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IPreferencesService } from '../../../../workbench/services/preferences/common/preferences.js';

/**
 * 歯車メニュー(左下)の「Settings」の直下に「設定 (Para Code)」を追加し、
 * `paradis.*` の設定だけに絞り込んだ状態で設定エディタを開けるようにする。
 * `@id:` フィルタは settingsTreeModels.ts の matchesAnyId が設定キーの前方一致
 * (末尾 `*`) をサポートしているため、`paradis.*` で fork独自設定だけに絞り込める。
 */
const PARADIS_OPEN_SETTINGS_COMMAND_ID = 'paradis.openSettings';

class ParadisOpenSettingsAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_OPEN_SETTINGS_COMMAND_ID,
			title: localize2('paradis.openSettings', "設定 (Para Code)"),
			category: localize2('paradis.settings.category', "Para Code"),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IPreferencesService).openSettings({ query: '@id:paradis.*' });
	}
}

registerAction2(ParadisOpenSettingsAction);

// group '2_configuration' の並びは Profiles(1) / Settings(2) / Extensions(3) / ... なので、
// Settings の直後に来るよう order は 2 と 3 の間の小数にする (upstream 側のorder値は変更しない)
MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
	group: '2_configuration',
	order: 2.5,
	command: {
		id: PARADIS_OPEN_SETTINGS_COMMAND_ID,
		title: localize('paradis.openSettings.menu', "設定 (Para Code)")
	}
});
