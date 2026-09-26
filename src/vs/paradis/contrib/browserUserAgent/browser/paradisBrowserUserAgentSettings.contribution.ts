/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { PARADIS_BROWSER_UA_INCLUDE_APP_TOKEN_KEY } from '../common/paradisBrowserUserAgent.js';

// id/title は他の Para Code 設定（browserDownloads 等）と揃え、Settings UI の同じカテゴリにまとめる。
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_BROWSER_UA_INCLUDE_APP_TOKEN_KEY]: {
			type: 'boolean',
			default: false,
			// APPLICATION スコープ: 適用は electron-main の BrowserSession が行い、main プロセスは
			// 既定プロファイルの settings.json しか読まないため（browserDownloads と同じ理由）。
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.browser.userAgent.includeParaCodeToken', "内蔵ブラウザがサイトに送る User-Agent に `ParaCode/<バージョン>` を含めるかどうかを制御します。既定では含めず、通常の Chrome と同じ形で名乗ります。変更は新しく開いたタブから反映されます。")
		}
	}
});
