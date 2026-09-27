/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// デスクトップのチャット表示の設定。画面そのものは electron-browser 側（会話を shared process から引く）。

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { PARADIS_AGENT_CHAT_ENABLED_SETTING, PARADIS_AGENT_CHAT_SEND_KEY_SETTING } from '../common/paradisAgentChat.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_AGENT_CHAT_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.agentChat.enabled', "エディタエリアのターミナルで動いている Claude Code / Codex を、同じタブの中でチャット表示に切り替えられるようにします（`⌘⇧J` またはタブ列の吹き出しのボタン）。チャットで送った文と回答はターミナルへ入力されます。"),
		},
		[PARADIS_AGENT_CHAT_SEND_KEY_SETTING]: {
			type: 'string',
			enum: ['enter', 'modEnter'],
			enumDescriptions: [
				localize('paradis.agentChat.sendKey.enter', "Enter で送信し、Shift+Enter で改行します。"),
				localize('paradis.agentChat.sendKey.modEnter', "⌘Enter（Windows / Linux では Ctrl+Enter）で送信し、Enter で改行します。"),
			],
			default: 'enter',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.agentChat.sendKey', "チャット表示の入力欄で送信に使うキー。日本語入力の変換を確定する Enter では送信しません。"),
		},
	},
});
