/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { PARADIS_AGENT_BROWSER_SHOW_CURSOR_OVERLAY_SETTING, PARADIS_BROWSER_REPORT_STATE_SETTING, PARADIS_BROWSER_SETTLE_AFTER_ACTION_SETTING, PARADIS_BROWSER_SITE_NOTES_SETTING } from '../common/paradisAgentBrowser.js';

// 共通の 'paradis' セクションへプロパティを追加する（windowTransparency の設定登録と同じ id/title を
// 再利用し、Settings UI 上は同じ「Para Code」カテゴリへマージ表示される）。
const paradisConfigurationNodeBase = Object.freeze<IConfigurationNode>({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object'
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...paradisConfigurationNodeBase,
	properties: {
		[PARADIS_AGENT_BROWSER_SHOW_CURSOR_OVERLAY_SETTING]: {
			type: 'boolean',
			default: true,
			// APPLICATIONスコープ: 実際の注入はshared process側のエージェントブラウザサービスが行い、
			// mainプロセス側はdefaultプロファイルのuser settings.jsonしか見えないため、
			// Workspace/プロファイルスコープでの上書きを許すと見えている値が食い違う
			// （windowTransparency.enabled・browserDownloads.enabledと同じ理由）。
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.agentBrowser.showCursorOverlay', "エージェント（Claude Code / Codex）が内蔵ブラウザを操作していることを、ページ上の演出で見せるかどうかを制御します。クリック・ホバー・ドラッグに合わせてマウスカーソルが動き、エージェントがスクリーンショットを撮るときは画面が一瞬光ります。そのカーソルは撮影された画像には写りません。演出は表示中のタブでのみ行い、ページの共有をやめたとき・自分でページを操作し始めたときは消えます。無効にしても操作自体には影響しません。OSで視差効果を減らす設定が有効な場合は、演出も自動的に控えめになります。")
		},
		// 内蔵ブラウザの道具（para-browser MCP）は shared process で動くので、cursor と同じく APPLICATION スコープ
		[PARADIS_BROWSER_SETTLE_AFTER_ACTION_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.agentBrowser.settleAfterAction', "（試験的）エージェントが内蔵ブラウザでクリック・入力・ページ移動をした後、ページの変化が落ち着くまで最大 2 秒待ち、増えた・変わった・消えた要素を道具の結果に添えます。エージェントが確かめるための呼び出しが減ります。")
		},
		[PARADIS_BROWSER_REPORT_STATE_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.agentBrowser.reportBrowserState', "（試験的）エージェントが内蔵ブラウザで操作した結果に、使えるタブ、その操作で開いたページ、新しいダウンロード、開いているダイアログを添えます。前回と同じ内容は省きます。")
		},
		[PARADIS_BROWSER_SITE_NOTES_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.agentBrowser.siteNotes', "（試験的）エージェントが内蔵ブラウザで使ったサイトについて短いメモ（入力の書式やボタンの場所など）を残し、同じリポジトリで次にそのサイトを開いたエージェントへヒントとして渡します。メモはサイトとリポジトリの組ごとに、書いた日とエージェントを添えて利用者のフォルダの .para-code/browser-notes に保存します。エージェントは間違ったメモを消せます。有効にした後は、エージェントを起動し直すとメモの道具が使えます。")
		}
	}
});
