/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Codex のアカウント切替の設定スキーマ。読むのは shared process（切替のときの会話ログのリンク）。

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { PARADIS_CODEX_SHARE_CONVERSATIONS_SETTING } from '../common/paradisCodexAccounts.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_CODEX_SHARE_CONVERSATIONS_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.codexAccounts.shareConversations', "使用量パネルで Codex のアカウントを切り替えたとき、切替元と切替先のアカウントの間で会話の記録を共有し、どちらのアカウントからでも `codex resume` で開けるようにします。共有するのは実際に切り替えた2つのアカウントの間だけです。\n\n共有した会話を別のアカウントで再開すると、その会話の内容は再開したアカウント（別の組織のアカウントを含む）へ送られます。仕事用と個人用のように分けておきたい場合はオフにしてください。オフにしても、すでに共有した記録は消しません。")
		}
	}
});
