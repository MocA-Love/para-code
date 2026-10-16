/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// メニューバーのアイコンの設定。値は main プロセス（アイコン）も読むので settings.json に置く。
// アイコンを出すかどうかは前の版の通知の受信箱の設定（paradisNotificationInboxSettings.ts）のまま。

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	PARADIS_MENU_BAR_INCLUDE_REMOTE_SETTING,
	PARADIS_MENU_BAR_MENU_USAGE_SETTING,
	PARADIS_MENU_BAR_MENU_WORKING_COUNT_SETTING,
	PARADIS_MENU_BAR_MULTIPLE_ACCOUNTS_SETTING,
	PARADIS_MENU_BAR_PLAIN_MENU_SETTING,
	PARADIS_MENU_BAR_TITLE_SETTING,
	PARADIS_MENU_BAR_USAGE_STYLE_SETTING,
	PARADIS_MENU_BAR_USAGE_WINDOW_SETTING,
} from '../common/paradisMenuBar.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_MENU_BAR_TITLE_SETTING]: {
			type: 'string',
			enum: ['usage', 'attention', 'none'],
			enumDescriptions: [
				localize('paradis.menuBar.title.usage', "使用量"),
				localize('paradis.menuBar.title.attention', "許可待ちと質問の数"),
				localize('paradis.menuBar.title.none', "なし"),
			],
			default: 'usage',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.menuBar.title', "メニューバーの Para Code のアイコンの横に出すもの。使用量は Claude Code（C）と Codex（X）の使用中のアカウントの使用率です。タイトルバーの使用量を非表示にしていても、メニューバーに使用量を出している間は数分ごとに使用量を取りに行きます。"),
		},
		[PARADIS_MENU_BAR_USAGE_STYLE_SETTING]: {
			type: 'string',
			enum: ['text', 'bars', 'ring', 'nearLimit'],
			enumDescriptions: [
				localize('paradis.menuBar.usageStyle.text', "数字（C 42%  X 18%）"),
				localize('paradis.menuBar.usageStyle.bars', "細いバー 2 本（上が Claude Code、下が Codex）"),
				localize('paradis.menuBar.usageStyle.ring', "マークを囲む輪（多い方の値）"),
				localize('paradis.menuBar.usageStyle.nearLimit', "上限に近いときだけ数字"),
			],
			default: 'text',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.menuBar.usageStyle', "アイコンの横に使用量を出すときの出し方。「上限に近いときだけ」は 80% を超えたときだけ数字を出します。"),
		},
		[PARADIS_MENU_BAR_USAGE_WINDOW_SETTING]: {
			type: 'string',
			enum: ['fiveHour', 'sevenDay', 'higher'],
			enumDescriptions: [
				localize('paradis.menuBar.usageWindow.fiveHour', "5 時間の枠"),
				localize('paradis.menuBar.usageWindow.sevenDay', "週の枠"),
				localize('paradis.menuBar.usageWindow.higher', "5 時間と週の多い方"),
			],
			default: 'fiveHour',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.menuBar.usageWindow', "アイコンの横に出す使用量の枠。メニューの中には 5 時間と週の両方を出します。"),
		},
		[PARADIS_MENU_BAR_MULTIPLE_ACCOUNTS_SETTING]: {
			type: 'string',
			enum: ['active', 'available', 'both'],
			enumDescriptions: [
				localize('paradis.menuBar.multipleAccounts.active', "使用中のアカウントの値"),
				localize('paradis.menuBar.multipleAccounts.available', "余裕のあるアカウントの数"),
				localize('paradis.menuBar.multipleAccounts.both', "両方"),
			],
			default: 'active',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.menuBar.multipleAccounts', "アカウントが複数あるときにアイコンの横に出すもの。余裕のあるアカウントは、5 時間と週のどちらも 80% 未満のものです。"),
		},
		[PARADIS_MENU_BAR_INCLUDE_REMOTE_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.menuBar.includeRemote', "開いている SSH の接続先の使用量も、この PC の分と合わせて出します。同じアカウントは 1 つにまとめ、今日のコストは足します。"),
		},
		[PARADIS_MENU_BAR_MENU_USAGE_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.menuBar.menu.usage', "メニューに Claude Code と Codex のアカウントごとの使用量と、今日のコストを出します。タイトルバーの使用量を非表示にしていても、メニューバーに使用量を出している間は数分ごとに使用量を取りに行きます。"),
		},
		[PARADIS_MENU_BAR_MENU_WORKING_COUNT_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.menuBar.menu.workingCount', "メニューの見出しに、作業中のエージェントの数を足します。"),
		},
		[PARADIS_MENU_BAR_PLAIN_MENU_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.menuBar.plainMenu', "メニューの行の 2 行目・行の頭の小さなバー・数字の色を使わない、簡単な表示にします。メニューの表示が崩れるときにオンにします。"),
		},
	},
});
