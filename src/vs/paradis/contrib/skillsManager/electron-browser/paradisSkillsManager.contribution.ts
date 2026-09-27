/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スキル管理の入り口: コマンド「スキル」と歯車メニューの項目。
// `paradis.electron-browser.contribution.ts` からこのファイルを1行 import する。

import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ParadisSkillsDialog } from './paradisSkillsDialog.js';

export const PARADIS_OPEN_SKILLS_COMMAND_ID = 'paradis.openSkills';

let activeDialog: ParadisSkillsDialog | undefined;

class ParadisOpenSkillsAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_OPEN_SKILLS_COMMAND_ID,
			title: localize2('paradis.openSkills', "スキル"),
			category: localize2('paradis.skills.category', "Para Code"),
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		activeDialog?.dispose();
		activeDialog = accessor.get(IInstantiationService).createInstance(ParadisSkillsDialog);
	}
}

registerAction2(ParadisOpenSkillsAction);

// 「設定 (Para Code)」（2.5）・「定期実行」（2.6）の下に並べる
MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
	group: '2_configuration',
	order: 2.7,
	command: { id: PARADIS_OPEN_SKILLS_COMMAND_ID, title: localize('paradis.openSkills.menu', "スキル") },
});
