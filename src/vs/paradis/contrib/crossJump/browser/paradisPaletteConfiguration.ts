/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 中央のパレットの右のプレビューの on/off（Q609 の 2）。パレットの中のボタンと Alt+P はこの設定を書き換えるので、
// 切り替えた状態は次に開いたときも続く。「設定 (Para Code)」にも載せる（paradisSettingsDialog.ts）。

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

/** プレビューを出すか。 */
export const PARADIS_PALETTE_PREVIEW_SETTING = 'paradis.palette.preview';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_PALETTE_PREVIEW_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('paradis.palette.preview.setting', "「エージェント・タブ・スペースへ移動」とコマンドパレットで、窓が広いとき（1100px 以上）にパレットを広げ、選んだ行の中身（エージェントの最後の発言、スペースの差分、ファイルの先頭など）を右に出します。パレットの中のボタンか Alt+P（macOS は Cmd+Option+P）でも切り替えられます。"),
		},
	},
});
