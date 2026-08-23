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
// 待避させた分はスペースを切り替えても戻らないので、ここ（コマンド「所属スペースのない
// ターミナルを復元」）と、待避時に出す通知のボタンが戻し口になる。

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IParadisTerminalScopeService } from '../common/paradisWorkspaceSwitch.js';

class ParadisAdoptUnattributedTerminalsAction extends Action2 {
	constructor() {
		super({
			id: 'paradis.workspaceSwitch.adoptUnattributedTerminals',
			title: localize2('paradis.workspaceSwitch.adoptUnattributedTerminals', "所属スペースのないターミナルを復元"),
			category: localize2('paradis.category', "Para Code"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const scopeService = accessor.get(IParadisTerminalScopeService);
		const notificationService = accessor.get(INotificationService);

		const waiting = scopeService.countUnattributedTerminals();
		if (waiting === 0) {
			notificationService.info(localize('paradis.unattributedTerminals.none', "復元待ちのターミナルはありません。"));
			return;
		}

		const adopted = scopeService.adoptUnattributedTerminals();
		if (adopted === 0) {
			notificationService.notify({
				severity: Severity.Warning,
				message: localize('paradis.unattributedTerminals.failed', "このスペースへターミナルを復元できませんでした。先にスペースを開いてから、もう一度お試しください。"),
			});
			return;
		}
		// 引き取り先が正しいかはユーザーにしか分からない（コマンドは今のスペースへ入れるだけで、
		// どのスペースのものだったかは誰も知らない）。所属は台帳へ確定して次のセッションまで
		// 残るので、その場で戻せるようにしておく。
		notificationService.prompt(
			Severity.Info,
			localize('paradis.unattributedTerminals.adopted', "{0} 個のターミナルをこのスペースへ移動しました。", adopted),
			[{
				label: localize('paradis.unattributedTerminals.undo', "元に戻す"),
				run: () => scopeService.undoLastTerminalAdoption(),
			}],
		);
	}
}

registerAction2(ParadisAdoptUnattributedTerminalsAction);
