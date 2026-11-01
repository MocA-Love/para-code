/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { PARADIS_BROWSER_EXTENSIONS_ALLOW_WHILE_SHARED_SETTING, PARADIS_BROWSER_EXTENSIONS_ENABLED_SETTING } from '../common/paradisBrowserExtensions.js';

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
			markdownDescription: localize('paradis.browser.extensions.enabled', "（試験的）内蔵ブラウザで Chrome 拡張機能を使えるようにします。拡張機能は通常のタブ・ワークスペースのタブ・名前付きプロファイルのタブに入り、エージェントのタブ・使い捨てのタブには入りません。SSH 先のページには、拡張機能の管理で「SSH 先のページでも使う」をオンにした拡張機能だけが入ります。変更は再起動の後に効きます。"),
		},
		// 共有中のタブでも拡張機能の画面を出す（Q527、既定オフ）。APPLICATION スコープ: electron-main が読み、変わったらすぐ効かせる
		[PARADIS_BROWSER_EXTENSIONS_ALLOW_WHILE_SHARED_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			tags: ['experimental'],
			markdownDescription: localize('paradis.browser.extensions.allowWhileShared', "（試験的）エージェントと共有中のタブでも、拡張機能のサイドパネルと、拡張機能がページの中に出す小さな画面（パスワード管理の候補など）を出します。オンにすると、エージェントが撮るページのスクリーンショットに拡張機能の候補（アカウント名など）が写ることがあり、エージェントが画面の位置を指定してクリックすると候補を選べてしまいます。オフに戻した後、ページの中に出ている小さな画面は、ページを読み込み直すと消えます。"),
		}
	}
});
