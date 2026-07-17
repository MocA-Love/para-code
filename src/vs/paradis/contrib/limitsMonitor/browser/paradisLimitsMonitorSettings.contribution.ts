/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// AIリミットモニターの設定スキーマ。実体(タイトルバーウィジェット)はElectron専用APIに
// 依存するため electron-browser 側にあるが、設定スキーマ自体はweb/desktop共通で安全なので
// paradis.common.contribution.ts 経由でここだけ先に登録する(resourceMonitor と同じ分離)。

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

// セクションは windowTransparency / resourceMonitor 側と同じ 'paradis' に相乗り(集約セクション)。
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		'paradis.limitsMonitor.enabled': {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.WINDOW,
			description: localize('paradis.limitsMonitor.enabled', "タイトルバーに Claude Code / Codex のレート制限モニターを表示するかどうかを制御します。")
		},
		'paradis.limitsMonitor.cswapPath': {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			description: localize('paradis.limitsMonitor.cswapPath', "claude-swap (cswap) 実行ファイルの絶対パス。空の場合は PATH とよくあるインストール先から自動解決します。")
		},
		'paradis.limitsMonitor.codexHomes': {
			type: 'array',
			items: { type: 'string' },
			default: [],
			scope: ConfigurationScope.APPLICATION,
			description: localize('paradis.limitsMonitor.codexHomes', "自動走査 (~/.codex, ~/.codex-*) に追加で監視する Codex ホームディレクトリのパス。")
		}
	}
});
