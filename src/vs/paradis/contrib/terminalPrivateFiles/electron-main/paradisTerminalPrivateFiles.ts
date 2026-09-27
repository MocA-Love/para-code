/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// main プロセスに `paradisTerminalPrivateFiles` チャネルを立てる。app.ts へ新しい行を足さないよう、
// 常駐ターミナルの状態チャネルの登録（`paradisRegisterPtyDaemonStatus`）から一緒に呼ぶ。

import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { dirname, join } from '../../../../base/common/path.js';
import { IServerChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { PARADIS_TERMINAL_PRIVATE_FILES_CHANNEL } from '../common/paradisTerminalPrivateFiles.js';
import { ParadisTerminalPrivateFileStore } from '../node/paradisTerminalPrivateFileStore.js';

/** 描画ずれの記録の置き場所（ログのフォルダの直下。セッションごとのフォルダではない）。 */
export const PARADIS_RENDER_EVIDENCE_FOLDER = 'paradisTerminalRender';
/** 常駐の保存画面の置き場所（ユーザーデータの直下）。 */
export const PARADIS_TERMINAL_SCREENS_FOLDER = 'paradisTerminalScreens';

export function paradisRegisterTerminalPrivateFiles(
	server: { registerChannel(name: string, channel: IServerChannel<string>): void },
	environmentMainService: IEnvironmentMainService,
): IDisposable {
	const store = new DisposableStore();
	const files = new ParadisTerminalPrivateFileStore(
		join(environmentMainService.userDataPath, PARADIS_TERMINAL_SCREENS_FOLDER),
		join(dirname(environmentMainService.logsHome.fsPath), PARADIS_RENDER_EVIDENCE_FOLDER),
	);
	server.registerChannel(PARADIS_TERMINAL_PRIVATE_FILES_CHANNEL, ProxyChannel.fromService<string>(files, store));
	return store;
}
