/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IPreferencesService } from '../../../../workbench/services/preferences/common/preferences.js';

/**
 * `paradis.*` の設定だけに絞り込んだ状態で標準の設定エディタを開くコマンド。
 * `@id:` フィルタは settingsTreeModels.ts の matchesAnyId が設定キーの前方一致
 * (末尾 `*`) をサポートしているため、`paradis.*` で fork独自設定だけに絞り込める。
 *
 * 歯車メニュー(左下)に出す「設定 (Para Code)」は、デスクトップでは専用ダイアログ
 * (paradisSettings/electron-browser/paradisSettingsDialog.contribution.ts) が登録する。
 * こちらは生の設定キーを触りたいとき、および Web ビルド向けの入口としてコマンド
 * パレットから使う。
 */
const PARADIS_OPEN_SETTINGS_COMMAND_ID = 'paradis.openSettings';

class ParadisOpenSettingsAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_OPEN_SETTINGS_COMMAND_ID,
			// allow-any-unicode-next-line
			title: localize2('paradis.openSettings', "設定 (Para Code) を設定エディタで開く"),
			category: localize2('paradis.settings.category', "Para Code"),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IPreferencesService).openSettings({ query: '@id:paradis.*' });
	}
}

registerAction2(ParadisOpenSettingsAction);
