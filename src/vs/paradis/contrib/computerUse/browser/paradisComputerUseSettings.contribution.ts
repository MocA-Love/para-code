/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Computer Use の設定スキーマ（設計書 3.6）。実体は shared process（node/paradisComputerUse.sharedProcess.ts）。

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { PARADIS_COMPUTER_USE_ENABLED_SETTING } from '../common/paradisComputerUse.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_COMPUTER_USE_ENABLED_SETTING]: {
			type: 'boolean',
			default: false,
			// リポジトリの .vscode/settings.json から勝手にオンにされないよう、利用者の設定でだけ変えられる
			scope: ConfigurationScope.APPLICATION,
			restricted: true,
			markdownDescription: localize('paradis.computerUse.enabled', "エージェントが Para Code の MCP ツールで、この Mac のほかのアプリの画面を読めるようにします（macOS 14 以降）。アプリごとに、初めて使うときに承認を求めます。パスワードマネージャー・キーチェーンアクセス・Para Code 自身は読めません。\n\n**Computer Use は、エージェントのサンドボックスと許可設定の外で、あなたの権限で動きます。** 読み取りを許可したアプリの画面（メール本文やチャットなど）はエージェントへ渡り、エージェントの提供元へ送られます。画面に表示された Web ページやメールに仕込まれた指示をエージェントが読む危険もあります。\n\nオンにした後は、エージェント側で MCP の再接続（Claude Code の `/mcp` など）が必要です。"),
		},
	},
});
