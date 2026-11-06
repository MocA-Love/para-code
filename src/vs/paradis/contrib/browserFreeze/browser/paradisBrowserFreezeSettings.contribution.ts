/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { PARADIS_BROWSER_FREEZE_HIDDEN_TABS_SETTING } from '../common/paradisBrowserFreeze.js';

// APPLICATION スコープ: 読むのは electron-main（休ませる時点で毎回）で、main は既定プロファイルの settings.json しか読まないため。
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_BROWSER_FREEZE_HIDDEN_TABS_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.browser.freezeHiddenTabs', "内蔵ブラウザで 30 分以上見えていないタブを一時停止し、CPU を使わないようにします。ページは読み込み直さず、スクロール位置や入力中の文字もそのまま残り、タブを表示するとすぐ動き出します。エージェントに渡しているタブと、音を鳴らしているタブは止めません。"),
		}
	}
});
