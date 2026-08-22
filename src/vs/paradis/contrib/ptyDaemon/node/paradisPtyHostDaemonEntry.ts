/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 薄い常駐の入口。`bootstrap-fork` が `VSCODE_ESM_ENTRYPOINT` を見てここへ来る。
//
// **アプリのコードをほとんど読み込まない。** 読むのは pty を抱える部分と ipc とログだけで、
// workbench も `PtyService` も入ってこない。前の常駐がアプリの pty ホスト一式を起こしていたのと
// 対照的で、これが「アプリの版とは無関係に動ける」の実体でもある。
//
// ログは標準出力へ出す。起こす側がファイルへ向けてある（`paradisEnsurePtyHost.ts`）。
// **捨てない**のは、起動できない理由が一切残らないと症状だけ見て溶かすことになるため。

import { ConsoleLogger, LogLevel } from '../../../../platform/log/common/log.js';
import { LogService } from '../../../../platform/log/common/logService.js';
import { paradisReadPtyDaemonEnv } from '../common/paradisPtyDaemonEnv.js';
import { paradisPtyHostPaths } from '../common/paradisPtyHostPaths.js';
import { PARADIS_PTY_HOST_STATE_DIR } from './paradisPtyHostBootstrap.js';
import { paradisRunPtyHostDaemon } from './paradisPtyHostDaemonMain.js';

const env = paradisReadPtyDaemonEnv(process.env);
const stateDir = process.env[PARADIS_PTY_HOST_STATE_DIR];
if (!env || !stateDir) {
	// 置き場所が分からないまま起きても、誰も繋いで来られない。
	console.error('[ParadisPtyHost] refusing to start: the socket and ledger were not given');
	process.exit(1);
}

// **渡された置き場所を鵜呑みにしない。** ここは終わるときにソケットを unlink し台帳を消すので、
// 偽の env で起こされると任意のパスを消しに行ける。自分で計算し直して一致を確かめる。
//
// ただし**強さは旧い入口と同じではない**。あちらは実際の userDataPath から期待値を作るが、
// こちらは置き場所そのものも env から受け取っているので、見ているのは env 同士の整合だけ。
// 置き場所を偽れば socketPath も一緒に偽れる。同じ信頼境界の中の話なので実害は小さいが、
// 同等だと思って読まれないように書いておく。
const expected = paradisPtyHostPaths({
	stateDir,
	platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
});
if (env.socketPath !== expected.socketPath || env.ledgerFile !== expected.ledgerFile) {
	console.error(`[ParadisPtyHost] refusing to start: ${env.socketPath} is not where this protocol version keeps one`);
	process.exit(1);
}

await paradisRunPtyHostDaemon({ env, logService: new LogService(new ConsoleLogger(LogLevel.Info)) });
