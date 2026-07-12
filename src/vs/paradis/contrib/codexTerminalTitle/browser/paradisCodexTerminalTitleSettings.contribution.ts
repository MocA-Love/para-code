/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { PARADIS_CODEX_TERMINAL_TITLE_ENABLED_SETTING } from '../common/paradisCodexTerminalTitle.js';

const paradisConfigurationNodeBase = Object.freeze<IConfigurationNode>({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object'
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...paradisConfigurationNodeBase,
	properties: {
		[PARADIS_CODEX_TERMINAL_TITLE_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.codex.terminalTitle.enabled', "Codex の統合ターミナルタブ名を、Codex が会話内容から自動生成するスレッドタイトルに設定します。タイトル生成が完了するまではスレッド ID（UUID）が表示されます。有効時は `~/.codex/config.toml` の `[tui].terminal_title` を `[\"app-name\", \"thread-title\"]` に更新します。設定変更後に起動した Codex セッションから反映されます。")
		}
	}
});
