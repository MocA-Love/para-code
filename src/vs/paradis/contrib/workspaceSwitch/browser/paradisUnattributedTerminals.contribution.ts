/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 所属スペースの分からない復元ターミナルを、今のスペースへ引き取るコマンド。
//
// 復元されたのに所属を確定できなかったターミナルは、アクティブスペースへ推測で寄せず待避させる
// （推測で寄せると、そのスペースの持ち物として台帳へ焼き付き、元がどこだったか分からなくなる）。
// 待避させた分はスペースを切り替えても戻らないので、ここ（コマンド "Recover Terminals
// Without a Space"）と、待避時に出す通知のボタンが戻し口になる。

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IParadisTerminalScopeService } from '../common/paradisWorkspaceSwitch.js';

class ParadisAdoptUnattributedTerminalsAction extends Action2 {
	constructor() {
		super({
			id: 'paradis.workspaceSwitch.adoptUnattributedTerminals',
			title: localize2('paradis.workspaceSwitch.adoptUnattributedTerminals', "Recover Terminals Without a Space"),
			category: localize2('paradis.category', "Para Code"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const scopeService = accessor.get(IParadisTerminalScopeService);
		const notificationService = accessor.get(INotificationService);

		const waiting = scopeService.countUnattributedTerminals();
		if (waiting === 0) {
			notificationService.info(localize('paradis.unattributedTerminals.none', "There are no terminals waiting to be recovered."));
			return;
		}

		const adopted = scopeService.adoptUnattributedTerminals();
		if (adopted === 0) {
			notificationService.notify({
				severity: Severity.Warning,
				message: localize('paradis.unattributedTerminals.failed', "The terminals could not be recovered into this space. Open a space first, then try again."),
			});
			return;
		}
		notificationService.info(localize('paradis.unattributedTerminals.adopted', "Moved {0} terminal(s) into this space.", adopted));
	}
}

registerAction2(ParadisAdoptUnattributedTerminalsAction);
