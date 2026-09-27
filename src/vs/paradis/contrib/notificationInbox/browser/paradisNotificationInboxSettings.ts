/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知の受信箱まわりの設定。値は main プロセス（メニューバーのアイコン）も読むので、
// 着信音などの設定（IStorageService）ではなく settings.json に置く。

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	PARADIS_NOTIFICATION_DOCK_BADGE_SETTING,
	PARADIS_NOTIFICATION_INBOX_TITLE_BAR_SETTING,
	PARADIS_NOTIFICATION_INCLUDE_MESSAGE_SETTING,
	PARADIS_NOTIFICATION_MENU_BAR_SETTING,
} from '../common/paradisNotificationInbox.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_NOTIFICATION_INCLUDE_MESSAGE_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.notifications.osIncludeMessage', "エージェントの完了・許可待ち・質問のデスクトップ通知に、エージェントの最後の発言（許可待ち・質問では待っている内容）の冒頭を載せます。ロック画面や画面共有中に通知の中身が見えるのを避けたい場合はオフにします。"),
		},
		[PARADIS_NOTIFICATION_INBOX_TITLE_BAR_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.notifications.inboxTitleBar', "タイトルバーに通知の受信箱（ベル）を表示します。全スペースの完了・許可待ち・質問をまとめて見られ、行を押すとそのペインへ移動します。"),
		},
		[PARADIS_NOTIFICATION_DOCK_BADGE_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.notifications.dockBadge', "Dock（Windows ではタスクバー）の Para Code のアイコンに、対応が必要なペインの数を表示します。"),
		},
		[PARADIS_NOTIFICATION_MENU_BAR_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.notifications.menuBarIcon', "メニューバー（Windows では通知領域）に Para Code のアイコンを表示します。対応が必要なペインがあると印が付き、メニューから最大 5 件のペインへ直接移動できます。"),
		},
	},
});
