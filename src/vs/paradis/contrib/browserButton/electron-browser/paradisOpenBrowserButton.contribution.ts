/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エディタタイトルバーに常時「内蔵ブラウザを開く」ボタンを追加する。
// 押すと常に新しいタブを開く（upstream の `open`）。既存のタブから選ぶ一覧は、Option（Alt）を押しながらの
// クリック（`alt` の `openOrList`）、`Cmd+Option+/`、コマンドパレットで出せる（Q437）。
// 既存の New Terminal(+)ボタン(terminalMenus.ts, order: 0)のさらに左に並ぶよう order を負値にしている。
// Agent Sessionsウィンドウには専用の "New Tab" ボタン(browserTabManagementFeatures.ts)が既にあるため、
// 通常ウィンドウに限定して重複表示を避ける。

import { Codicon } from '../../../../base/common/codicons.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize2 } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { BrowserViewCommandId } from '../../../../platform/browserView/common/browserView.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';

for (const menuId of [MenuId.EditorTitle, MenuId.CompactWindowEditorTitle]) {
	MenuRegistry.appendMenuItem(menuId, {
		command: {
			id: BrowserViewCommandId.Open,
			title: isMacintosh
				? localize2('paradis.openBrowserAction.mac', "新しいブラウザのタブを開く（Option を押しながらクリックで、開いているタブから選ぶ）")
				: localize2('paradis.openBrowserAction', "新しいブラウザのタブを開く（Alt を押しながらクリックで、開いているタブから選ぶ）"),
			icon: Codicon.globe
		},
		alt: {
			id: BrowserViewCommandId.OpenOrList,
			title: localize2('paradis.openBrowserAction.list', "開いているブラウザのタブから選ぶ"),
			icon: Codicon.globe
		},
		group: 'navigation',
		order: -10,
		when: IsSessionsWindowContext.toNegated()
	});
}
