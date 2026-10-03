/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude Code の mod（Claude Mods）の設定。読むのは renderer（ペインの env）と shared process（承認の待ち）。

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { PARADIS_CLAUDE_MOD_APPROVAL_WAIT_DEFAULT_MINUTES, PARADIS_CLAUDE_MOD_APPROVAL_WAIT_SETTING, PARADIS_CLAUDE_MOD_ENABLED_SETTING } from '../common/paradisClaudeMod.js';

const paradisConfigurationNodeBase = Object.freeze<IConfigurationNode>({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object'
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...paradisConfigurationNodeBase,
	properties: {
		[PARADIS_CLAUDE_MOD_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.agentHooks.claudeMod.enabled', "Para Code のターミナルで起動した Claude Code に、Para Code の mod（Claude Mods）を読ませます。会話と生成中の文章がモバイルへ速く届き、モバイルからの質問への回答・承認・送信をキーの入力ではなく値で渡せるようになります。`#paradis.agentHooks.enabled#` がオンのときだけ働きます。変更は新しく開いたターミナルから反映されます。\n\n対象は macOS と Linux の手元のターミナルです（SSH の接続先と Windows はまだ対象外）。組織の管理設定で Claude Code のプラグインフォルダの読み込みが禁止されている場合（`disableSideloadFlags`）は、Claude Code が起動しなくならないよう自動で読ませません。"),
		},
		[PARADIS_CLAUDE_MOD_APPROVAL_WAIT_SETTING]: {
			type: 'number',
			default: PARADIS_CLAUDE_MOD_APPROVAL_WAIT_DEFAULT_MINUTES,
			minimum: 0,
			maximum: 60,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.agentHooks.claudeMod.approvalWaitMinutes', "Claude Code の許可の確認を、モバイルが接続している間だけモバイルからも答えられるようにする上限の時間（分）です。PC のターミナルにも同じ確認が出ていて、先に答えた方が使われます。上限を過ぎるか、モバイルの接続が切れると、PC のターミナルの確認だけが残ります。0 にするとモバイルからの承認は今までどおりの方式（ターミナルへのキーの入力）になります。"),
		},
	}
});
