/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Codicon } from '../../../../base/common/codicons.js';
import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
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

// 採用した入口: Workspaces 見出し。space行を汚さず、どのspaceの履歴も横断する機能だと伝わる。
MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: {
		id: PARADIS_SHOW_SESSION_RESUME_COMMAND_ID,
		title: localize2('paradis.sessionResume.viewTitle', "セッション履歴を開く"),
		icon: Codicon.history,
	},
	when: ContextKeyExpr.equals('view', PARADIS_WORKSPACES_VIEW_ID),
	group: 'navigation',
	order: -1,
});
