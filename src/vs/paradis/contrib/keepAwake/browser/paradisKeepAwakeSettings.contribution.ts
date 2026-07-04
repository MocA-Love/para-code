/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { PARADIS_KEEP_AWAKE_SETTING } from '../common/paradisKeepAwake.js';

// Paradis独自設定の集約セクション（windowTransparency の paradisSettings.contribution.ts と同じ id/title に
// 揃えることで、設定UI上は1つの「Para Code」セクションにマージされる）。
const paradisConfigurationNodeBase = Object.freeze<IConfigurationNode>({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object'
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...paradisConfigurationNodeBase,
	properties: {
		[PARADIS_KEEP_AWAKE_SETTING]: {
			type: 'string',
			enum: ['off', 'system', 'display'],
			default: 'off',
			// APPLICATIONスコープ: powerSaveBlocker はアプリ（マシン）全体に効くグローバルな状態のため、
			// ワークスペース設定での上書きを許すと「どのウィンドウの設定が勝つか」が不定になる。
			scope: ConfigurationScope.APPLICATION,
			enumDescriptions: [
				localize('paradis.power.keepAwake.off', "スリープを防止しません。"),
				localize('paradis.power.keepAwake.system', "システムスリープを防止します。画面の消灯やロックは通常どおり行われますが、その間もターミナルやエージェントは動き続けます。モバイルからの遠隔操作にはこの値を推奨します。"),
				localize('paradis.power.keepAwake.display', "画面スリープも防止します。画面が消灯しないため、無操作による自動ロックも発動しなくなります。")
			],
			markdownDescription: localize('paradis.power.keepAwake', "Para Code の起動中に PC をスリープさせないようにします。有効中はステータスバーにインジケーターが表示されます。手動ロックや OS ポリシーによる強制ロック、ノート PC の蓋を閉じた際のスリープは防止できません。")
		}
	}
});
