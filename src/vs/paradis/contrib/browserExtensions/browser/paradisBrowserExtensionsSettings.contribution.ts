/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { PARADIS_BROWSER_EXTENSIONS_ENABLED_SETTING } from '../common/paradisBrowserExtensions.js';

// 内蔵ブラウザの Chrome 拡張機能（試験的、既定オフ、D1）。
// APPLICATION スコープ: 読むのは electron-main（起動の時点で 1 回）で、main は既定プロファイルの settings.json しか読まないため。
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_BROWSER_EXTENSIONS_ENABLED_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			tags: ['experimental'],
			markdownDescription: localize('paradis.browser.extensions.enabled', "（試験的）内蔵ブラウザで Chrome 拡張機能を使えるようにします。拡張機能は通常のタブ・ワークスペースのタブ・名前付きプロファイルのタブに入り、エージェントのタブ・使い捨てのタブ・SSH 先のページには入りません。変更は再起動の後に効きます。"),
		}
	}
});
