/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 定期実行の入り口: コマンド「定期実行」と歯車メニューの項目、実行を受け持つ runner。
// `paradis.electron-browser.contribution.ts` からこのファイルを1行 import する。

import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ParadisScheduledRunsDialog } from './paradisScheduledRunsDialog.js';
import './paradisScheduledRunsClient.js';
import './paradisScheduledRunsRunner.contribution.js';

export const PARADIS_OPEN_SCHEDULED_RUNS_COMMAND_ID = 'paradis.openScheduledRuns';

let activeDialog: ParadisScheduledRunsDialog | undefined;

class ParadisOpenScheduledRunsAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_OPEN_SCHEDULED_RUNS_COMMAND_ID,
			title: localize2('paradis.openScheduledRuns', "定期実行"),
			category: localize2('paradis.scheduledRuns.category', "Para Code"),
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		activeDialog?.dispose();
		activeDialog = accessor.get(IInstantiationService).createInstance(ParadisScheduledRunsDialog);
	}
}

registerAction2(ParadisOpenScheduledRunsAction);

// 「設定 (Para Code)」（2.5）のすぐ下に並べる
MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
	group: '2_configuration',
	order: 2.6,
	command: { id: PARADIS_OPEN_SCHEDULED_RUNS_COMMAND_ID, title: localize('paradis.openScheduledRuns.menu', "定期実行") },
});
