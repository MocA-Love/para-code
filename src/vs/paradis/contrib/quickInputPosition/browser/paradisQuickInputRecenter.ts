/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { AbstractCommandsQuickAccessProvider } from '../../../../platform/quickinput/browser/commandsQuickAccess.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';

export const PARADIS_QUICK_INPUT_RECENTER_COMMAND_ID = 'paradis.quickInput.recenter';

/**
 * quick input を upstream の「中央」に戻す (Q641)。最初の移し替え (paradisQuickInputPosition.ts) より前に
 * 動かしていて上に残った人向け。
 *
 * - `setAlignment('center')` は upstream が `workbench.quickInput.viewState` に保存する (メインのウィンドウだけ。補助ウィンドウは今のまま)
 * - コマンドパレットから実行したときは、upstream がパレットを閉じてから実行するので、閉じたままの状態で位置だけ移る
 * - quick input をまだ一度も開いていない (upstream のドラッグの仕組みが無い) か、部品の横に出すものが開いていると
 *   `setAlignment` が効かない。そのときはコマンドパレットを開いてから中央に置き、移ったことが見えるようにする
 */
export function recenterQuickInput(quickInputService: IQuickInputService): void {
	quickInputService.setAlignment('center');
	if (quickInputService.alignment.get() === 'center') {
		return;
	}
	quickInputService.quickAccess.show(AbstractCommandsQuickAccessProvider.PREFIX);
	quickInputService.setAlignment('center');
}

registerAction2(class ParadisRecenterQuickInputAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_QUICK_INPUT_RECENTER_COMMAND_ID,
			title: localize2('paradis.quickInput.recenter', "パレットを中央に戻す"),
			category: localize2('paradis.category', "Para Code"),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		recenterQuickInput(accessor.get(IQuickInputService));
	}
});
