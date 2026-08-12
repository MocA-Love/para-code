/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';

/** 同梱している open-remote-ssh の「今のウィンドウで繋ぐ」コマンド。 */
const OPEN_IN_CURRENT_WINDOW_COMMAND = 'openremotessh.openEmptyWindowInCurrentWindow';

/**
 * 「><」メニューの先頭に「同じウィンドウのまま SSH に接続する...」を出す。
 *
 * 同梱の open-remote-ssh は "Connect to Host..."（新しいウィンドウ）と
 * "Connect Current Window to Host..."（今のウィンドウ）を両方出すが、上に来るのは前者で、
 * 素直に押すとウィンドウが増える。Para Code はスペースを1つのウィンドウで行き来する作りなので、
 * 増えない方を既定にしたい。
 *
 * 拡張が出す2項目は消せない（他の拡張のメニュー項目を隠す仕組みが VS Code に無い）。
 * そこで、より上のグループへ自前の項目を置いて、最初に目に入るものを入れ替える。
 * 中身は拡張のコマンドをそのまま呼ぶだけで、接続の手順には一切触らない。
 */
class ParadisConnectInCurrentWindowAction extends Action2 {

	constructor() {
		super({
			id: 'paradis.remote.connectInCurrentWindow',
			// allow-any-unicode-next-line
			title: localize2('paradis.remote.connectInCurrentWindow', "同じウィンドウのまま SSH に接続する..."),
			category: localize2('paradis.category', "Para Code"),
			f1: true,
			menu: {
				id: MenuId.StatusBarRemoteIndicatorMenu,
				// グループ名は remoteIndicator が `remote_$ORDER_$REMOTENAME_$GROUPING` として解釈する。
				// 拡張側は remote_20_ssh_* なので、10 番台に置いて先頭へ出す。
				group: 'remote_10_ssh_1general',
				order: 1
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		try {
			await commandService.executeCommand(OPEN_IN_CURRENT_WINDOW_COMMAND);
		} catch (error) {
			// 拡張が無効化されている等でコマンドが無い場合。ここで落とすと「><」メニューが
			// エラーを出すだけになるので、記録に留めて拡張側の項目に任せる
			accessor.get(ILogService).warn(`[paradis] ${OPEN_IN_CURRENT_WINDOW_COMMAND} is unavailable`, error);
		}
	}
}

registerAction2(ParadisConnectInCurrentWindowAction);
