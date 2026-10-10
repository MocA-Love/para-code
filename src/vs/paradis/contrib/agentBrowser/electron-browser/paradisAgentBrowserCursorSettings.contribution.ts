/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { PARADIS_AGENT_BROWSER_SHOW_CURSOR_OVERLAY_SETTING, PARADIS_BROWSER_REPORT_STATE_SETTING, PARADIS_BROWSER_RUN_STEPS_FLOW_SETTING, PARADIS_BROWSER_SETTLE_AFTER_ACTION_SETTING, PARADIS_BROWSER_SITE_NOTES_SETTING, PARADIS_BROWSER_SNAPSHOT_DIFF_SETTING, PARADIS_BROWSER_SITE_RECIPES_SETTING } from '../common/paradisAgentBrowser.js';

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
		[PARADIS_BROWSER_RUN_STEPS_FLOW_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.agentBrowser.runStepsFlow', "（試験的）エージェントが内蔵ブラウザで、前の結果を使う・条件を待つ・繰り返す、を 1 回の呼び出しで書けるようにします。すべてが効くのは、オンにした後に起動したエージェントからです。")
		},
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
		[PARADIS_BROWSER_SITE_NOTES_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.agentBrowser.siteNotes', "（試験的）エージェントが内蔵ブラウザで使ったサイトについて短いメモを残し、同じリポジトリの次のエージェントへヒントとして渡します。")
		},
		[PARADIS_BROWSER_SITE_RECIPES_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.agentBrowser.siteRecipes', "（試験的）エージェントが内蔵ブラウザで決まった画面まで進む操作を手順として保存し、同じリポジトリの次のエージェントが 1 回の呼び出しでやり直せるようにします。")
		},
		// 内蔵ブラウザの道具（para-browser MCP）は shared process で動くので、cursor と同じく APPLICATION スコープ
		[PARADIS_BROWSER_SETTLE_AFTER_ACTION_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.agentBrowser.settleAfterAction', "（試験的）エージェントがクリックや入力をした後、ページの表示が落ち着くまで最大 2 秒待ち、何が変わったかを伝えます。すべてが効くのは、オンにした後に起動したエージェントからです。")
		},
		[PARADIS_BROWSER_REPORT_STATE_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.agentBrowser.reportBrowserState', "（試験的）新しいページやダウンロード、開いたダイアログなどを、エージェントに伝えます。")
		},
		[PARADIS_BROWSER_SNAPSHOT_DIFF_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.agentBrowser.snapshotDiff', "（試験的）エージェントが内蔵ブラウザで同じページの中身を 2 回目以降に読むとき、前回から変わったところだけを渡し、読む量を減らします。")
		}
	}
});
