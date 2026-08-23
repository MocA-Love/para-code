/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 統合使用量ダッシュボードのコマンド登録。
//
// 引数でタブを指定して開けるので、ccusage / GitHub / rtk それぞれのステータスバーからは
// 対応するタブを指定して同じダイアログを開く（3機能の contribution 側が
// `paradis.usage.showDashboard` を該当タブ付きで呼ぶ）。

import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ParadisUsageDashboardDialog, ParadisUsageDashboardTab } from './paradisUsageDashboardDialog.js';

export const PARADIS_USAGE_DASHBOARD_COMMAND_ID = 'paradis.usage.showDashboard';

/** 同時に1つだけ開く（通知設定ダイアログ等と同じ方式）。 */
let activeDialog: ParadisUsageDashboardDialog | undefined;

/** 別 contribution（各ステータスバー）からタブ指定で開くための入口。 */
export function paradisOpenUsageDashboard(accessor: ServicesAccessor, tab?: ParadisUsageDashboardTab): void {
	activeDialog?.dispose();
	activeDialog = accessor.get(IInstantiationService).createInstance(ParadisUsageDashboardDialog, tab);
}

class ParadisShowUsageDashboardAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_USAGE_DASHBOARD_COMMAND_ID,
			// allow-any-unicode-next-line
			title: localize2('paradis.usage.showDashboard', "使用量ダッシュボードを開く"),
			// allow-any-unicode-next-line
			category: localize2('paradis.usage.category', "Para Code"),
			f1: true,
		});
	}

	run(accessor: ServicesAccessor, tab?: ParadisUsageDashboardTab): void {
		paradisOpenUsageDashboard(accessor, tab);
	}
}

registerAction2(ParadisShowUsageDashboardAction);
