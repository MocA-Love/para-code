/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { PARADIS_BROWSER_DOWNLOADS_ENABLED_KEY, PARADIS_BROWSER_DOWNLOADS_PATH_KEY } from '../common/paradisBrowserDownloads.js';

// 共通の 'paradis' セクションへプロパティを追加する。id/title は windowTransparency の設定登録
// (src/vs/paradis/contrib/windowTransparency/browser/paradisSettings.contribution.ts) と揃えており、
// 同じ id で複数回 registerConfiguration を呼んでも Settings UI 上は同じ「Para Code」カテゴリへ
// マージ表示される（ConfigurationRegistry は id の重複チェックをせず単純にノードを積み上げるだけのため）。
const paradisConfigurationNodeBase = Object.freeze<IConfigurationNode>({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object'
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...paradisConfigurationNodeBase,
	properties: {
		[PARADIS_BROWSER_DOWNLOADS_ENABLED_KEY]: {
			type: 'boolean',
			default: true,
			// APPLICATIONスコープ: 実際の適用は electron-main の BrowserSession が行い、mainプロセスは
			// defaultプロファイルの user settings.json しか見えないため、Workspace/プロファイルスコープでの
			// 上書きを許すとmainとレンダラで見えている値が食い違う（windowTransparency.enabledと同じ理由）。
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.browser.downloads.enabled', "内蔵ブラウザでのファイルダウンロード時に保存先を選ぶシステムダイアログを出さず、`#paradis.browser.downloads.path#` へ自動保存するかどうかを制御します。無効にすると、これまで通り保存先を選ぶダイアログが毎回表示されます。")
		},
		[PARADIS_BROWSER_DOWNLOADS_PATH_KEY]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.browser.downloads.path', "内蔵ブラウザのダウンロードの自動保存先フォルダを指定します（絶対パスのみ有効。相対パスは無視され既定値にフォールバックします）。空の場合は、OS標準のダウンロードフォルダ配下の `Paracode` サブフォルダ（例: macOSでは `~/Downloads/Paracode/`）が使われます。フォルダが存在しない場合は自動的に作成されます。`#paradis.browser.downloads.enabled#` が無効な場合は使われません。")
		}
	}
});
