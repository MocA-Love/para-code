/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IViewsRegistry, Extensions as ViewExtensions } from '../../../../workbench/common/views.js';
import { PARADIS_WORKSPACES_VIEW_ID } from '../../workspaceSwitch/browser/paradisWorkspacesView.js';
import { paradisOpenSessionResumeDialog } from './paradisSessionResumeDialog.js';

export const PARADIS_SHOW_SESSION_RESUME_COMMAND_ID = 'paradis.sessionResume.show';

// エディタ(タブ)ではなくモーダルダイアログで開く。3カラムの最小幅(936px)はエディタのペイン幅では
// 満たせないことがあり(分割・サイドバー展開)、ウィンドウ幅を基準にできるダイアログの方が破綻しない。

registerAction2(class ShowParadisSessionResumeAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_SHOW_SESSION_RESUME_COMMAND_ID,
			title: localize2('paradis.sessionResume.show', "エージェントのセッション履歴を開く"),
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		paradisOpenSessionResumeDialog(accessor.get(IInstantiationService));
	}
});

// 入口はスペースのビューの「プロジェクト」の見出しのボタン（paradisWorkspacesNav.ts）とコマンドパレット。
// リポジトリが 0 件のときは見出しが出ない（空の案内だけになる）ので、空の案内にも入口を残す。
// コマンドはデスクトップだけにあるので、案内の行もここ（electron-browser）で足す。
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViewWelcomeContent(PARADIS_WORKSPACES_VIEW_ID, {
	content: localize({ key: 'paradis.sessionResume.welcome', comment: ['{Locked="](command:paradis.sessionResume.show)"}'] }, "これまでのエージェントのセッションは[セッション履歴](command:paradis.sessionResume.show)から開けます。"),
	order: 10, // 「リポジトリを追加」(既定の 5) の後
});
